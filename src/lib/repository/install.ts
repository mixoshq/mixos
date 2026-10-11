/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Installing an extension from mixos.org into this checkout.
 *
 * An app or a connector is installed into `.mixos/pending/`, where nothing reads
 * it, and waits there until someone registers it (./register.ts), which is when
 * its code first runs. A theme has no code, so it is registered as it is
 * installed: it lands in `themes/`. Either is a privileged act, which is why
 * every entry point into this module is admin-gated and audited.
 *
 * ── THE ORDER OF OPERATIONS IS THE SECURITY MODEL ───────────────────────────
 *
 * Before the locks: the kind's install flag, then `assertInstallable` (not a
 * built deployment, a writable folder, a generator to run). Then, under the
 * `repository.register` row lock and the checkout lock (`.mixos/lock`), with no
 * extension of that slug in place or pending:
 *
 * 1.  Ask mixos.org how to install → commit, download URL, content hash.
 * 2.  Refuse a yanked release unless the admin has been shown why and insisted.
 * 3.  Download from GitHub, pinned to the commit, through the host allowlist.
 * 4.  Read the archive IN MEMORY. Reject symlinks, traversal, oversize trees.
 * 5.  **Verify the content hash.** Mismatch ends it here, with nothing written.
 * 6.  Pre-flight: the manifest exists, parses and is for this slug, no path
 *     would land on disk as something other than what it names, and the
 *     package holds no install record of its own. Then any `.gitignore` or
 *     `.gitattributes` is left out (leaveOut(), ./left-out.ts), and the files
 *     hash is computed over what is written, which Register and the generator
 *     can recompute from the folder (filesHash()). Then the install record,
 *     `.registry.json`, is added to the tree: where it came from and what was
 *     verified (./install-record.ts).
 * 7.  Write to `.mixos/staging/<kind dir>/<slug>/`, never to the target.
 * 8.  **Check the staged copy without running it**: the generator's `--check`,
 *     which reads the extension's text, imports none of its code, and writes
 *     its verdict to a file this process names. Rejected, or no verdict at
 *     all: delete the staged copy and stop.
 * 9.  An app or a connector: write its sidecar (who installed it, when, and the
 *     check's verdict), then rename the staged copy to
 *     `.mixos/pending/<kind dir>/<slug>/`. It waits there for Register, and
 *     none of its code has run.
 *     A theme: rename it into `themes/<slug>/`, run the project registry
 *     generator, and if that run leaves the theme out or stops, remove it and
 *     regenerate, so a failed install leaves the checkout as it was.
 *
 * Steps 7 and 9, and deleting a staged copy the check refused, each begin by
 * confirming both locks are still this install's (`lease.assertHeld()`, see
 * `installExtension`), and stop without touching the disk when either is not.
 *
 * Steps 3–5 are ordered that way deliberately: nothing untrusted touches the
 * filesystem before the hash has been checked. An extract-then-verify pipeline
 * has a window where a tampered tree is on disk, and then depends on its
 * cleanup path being correct for that not to matter.
 *
 * Steps 8 and 9 are ordered the same way for the code: nothing the package
 * ships runs before the text of all of it has been checked, and the check's
 * answer comes from a file, never from what the check prints, which repeats
 * what the package says about itself. Every generator run gets `PATH` and
 * `TMPDIR` as its whole environment (`generatorEnv`).
 *
 * ── WHAT THIS CANNOT DO, AND SAYS SO ────────────────────────────────────────
 *
 * The registries are generated at BUILD time (`prebuild` → `predev` →
 * `scripts/generate-project-registry.ts` → `src/generated/*`). Writing a
 * directory into `apps/` therefore does not, by itself, make an app exist: the
 * generator has to re-run and the server has to pick up the new module graph.
 * In development that is the dev server recompiling. In production it is a
 * rebuild and redeploy — and on a read-only filesystem (Vercel) it cannot
 * happen at all, which `assertInstallable` refuses up front rather than failing
 * halfway through a write.
 *
 * `InstallResult.nextStep` is how that gets said to the admin instead of being
 * a thing they discover when the app they just registered is not in the list.
 */

import fs from "fs/promises";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import {
  CHECK_VERDICT_MAX_BYTES,
  parseCheckVerdict,
  type CheckVerdict,
} from "./check-verdict";
import { fetchInstallManifest, repositoryBaseUrl } from "./client";
import { fetchExtensionTree } from "./fetch-source";
import { filesHash, verifyContentHash } from "./content-hash";
import { handBackFor, type HandBack } from "./hand-back";
import {
  INSTALL_RECORD_FILE,
  InstallRecordSchema,
  installRecordEntry,
  repositoryFromTarballUrl,
  type InstallRecord,
} from "./install-record";
import { LEFT_OUT_NAMES, type LeftOut } from "./left-out";
import { BUILT_DEPLOYMENT_NOTICE, isBuiltDeployment } from "../platform/build";
import {
  CheckoutLockLostError,
  describeCheckoutLockHolder,
  withCheckoutLock,
  type CheckoutLock,
} from "../platform/checkout-lock";
import { LockLostError, withPlatformLock, type PlatformLease } from "../platform/lock";
import { satisfiesMinimum } from "../platform/version";
import {
  pathExists,
  pendingLocation,
  readSidecar,
  stagingLocation,
  writeSidecar,
  type PendingLocation,
  type PendingSidecar,
} from "./pending";
import type { TarEntry } from "./tar";
import {
  SlugSchema,
  isVerifiableHash,
  type ExtensionKind,
  type InstallManifest,
} from "./types";
import { installDisabledMessage, installEnabled } from "./policy";
import {
  RawAppManifestSchema,
  RawConnectorManifestSchema,
  RawThemeManifestSchema,
  formatZodError,
} from "../../../scripts/manifest-schemas";

/**
 * Where each kind installs to, and what identifies one on disk.
 *
 * Stated here rather than reused from `KIND_SEGMENT` in `./types`, which is
 * mixos.org's URL vocabulary. They happen to coincide today; if mixos.org ever
 * renamed a segment, that must not silently redirect a write on this
 * filesystem.
 */
const INSTALL_SEGMENT: Record<ExtensionKind, string> = {
  app: "apps",
  connector: "connectors",
  theme: "themes",
};

/**
 * The absolute directories, anchored ONCE at module load.
 *
 * The shape matters to the build, not only to the reader. `path.join(cwd(),
 * "apps")` at module scope is a form Turbopack's tracer recognises — the same
 * form `src/lib/apps/api-router.ts` uses for the same reason. Computing the
 * root inside a function and joining a variable segment onto it instead makes
 * every call site "dynamic filesystem access", which makes the tracer give up
 * and pull the whole project into the output bundle of every deployment,
 * including the read-only ones where this module refuses to run at all.
 *
 * `process.cwd()` is the project root under `next dev`, `next start` and the
 * Docker image alike, and the standalone server chdir's to its own root (see
 * next.config.ts). It is NOT trustworthy on a serverless platform — which is
 * exactly the environment `checkInstallable` refuses.
 */
const PROJECT_ROOT = process.cwd();
const APPS_DIR = path.join(PROJECT_ROOT, "apps");
const CONNECTORS_DIR = path.join(PROJECT_ROOT, "connectors");
const THEMES_DIR = path.join(PROJECT_ROOT, "themes");
/**
 * Where pending installs, staged copies and the checkout lock live (./pending.ts).
 * next.config.ts keeps it out of every build's file trace as well.
 */
const MIXOS_DIR = path.join(PROJECT_ROOT, ".mixos");
const GENERATOR = path.join(PROJECT_ROOT, "scripts/generate-project-registry.ts");
const TSX_CLI = path.join(PROJECT_ROOT, "node_modules/tsx/dist/cli.mjs");

/** This checkout, for the modules that take it as an argument (./register.ts). */
export function checkoutRoot(): string {
  return PROJECT_ROOT;
}

/**
 * A switch rather than a `Record<ExtensionKind, string>` lookup, and the two
 * below are the same.
 *
 * A record indexed by a variable key is opaque to Turbopack's tracer in exactly
 * the way the module-scope anchoring above exists to avoid — it reads
 * `fs.readFile(TABLE[kind])` as dynamic filesystem access and falls back to
 * tracing the whole project. Each `return` here is a constant it can see.
 */
function installDir(kind: ExtensionKind): string {
  switch (kind) {
    case "app":
      return APPS_DIR;
    case "connector":
      return CONNECTORS_DIR;
    case "theme":
      return THEMES_DIR;
  }
}

/**
 * The manifest file the generator looks for, per kind.
 *
 * One form per kind, all of them JSON, and that is the point: pre-flight can
 * schema-check the bytes before a single line of the package executes. Apps
 * briefly also accepted an `app.ts` carrying the whole manifest, which had to
 * be imported before there was anything to validate — the wrong order for a
 * package that just arrived from the Registry.
 *
 * An app may still ship `widgets.ts` for config fields built from presets, but
 * it is additive: `app.json` is required either way, so there is always
 * something to check first.
 */
const MANIFEST_FILE: Record<ExtensionKind, string> = {
  app: "app.json",
  connector: "connector.json",
  theme: "theme.json",
};

const APP_REGISTRY_FILE = path.join(PROJECT_ROOT, "src/generated/app-registry.ts");
const CONNECTOR_REGISTRY_FILE = path.join(
  PROJECT_ROOT,
  "src/generated/connector-registry.ts",
);
const THEME_REGISTRY_FILE = path.join(PROJECT_ROOT, "src/generated/theme-registry.ts");

/** The generated module each kind's identifier must appear in afterwards. */
function registryFile(kind: ExtensionKind): string {
  switch (kind) {
    case "app":
      return APP_REGISTRY_FILE;
    case "connector":
      return CONNECTOR_REGISTRY_FILE;
    case "theme":
      return THEME_REGISTRY_FILE;
  }
}

/** The same three, repo-relative, for messages an admin reads. */
const REGISTRY_FILE_LABEL: Record<ExtensionKind, string> = {
  app: "src/generated/app-registry.ts",
  connector: "src/generated/connector-registry.ts",
  theme: "src/generated/theme-registry.ts",
};

/** The JSON key the identifier is written under in the generated registry. */
const REGISTRY_KEY: Record<ExtensionKind, string> = {
  app: "slug",
  connector: "name",
  theme: "slug",
};

export class InstallError extends Error {
  constructor(
    message: string,
    /** A stable code the UI can branch on without matching prose. */
    readonly code:
      | "disabled"
      | "unsupported-environment"
      | "already-installed"
      | "no-release"
      | "unverifiable-checksum"
      | "incompatible"
      | "yanked"
      | "checksum"
      | "invalid-package"
      | "rejected-by-registry"
      | "generator-failed"
      | "write-failed"
      | "lock-lost"
      | "lock-unconfirmed",
    /** The generator's own output, when it is what refused. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = "InstallError";
  }
}

/** How the registry generator's run went, once the check accepted the extension. */
export interface RegistryOutcome {
  /** Whether the generator could be run at all in this environment. */
  ran: boolean;
  /** Whether it finished, and the extension is in the generated registry. */
  ok: boolean;
  /**
   * Set when the run stopped (a non-zero exit) rather than finishing.
   *
   * A run that finishes without the extension has refused it: the generator
   * leaves out one bad app and still exits 0, because one bad app must not
   * break everyone else's build. A run that stops has refused nothing in
   * particular. This run is the first to load the extension's code, which the
   * check does not, so the cause can be that code or this checkout, and the
   * admin is told it could be either.
   */
  stopped: boolean;
  /** The generator's output, trimmed. Shown to the admin verbatim on failure. */
  output: string;
}

export interface InstallResult {
  kind: ExtensionKind;
  slug: string;
  name: string;
  /** The install record written into the tree: `.registry.json`. */
  record: InstallRecord;
  version: string;
  /** Null for a release published without a tag. */
  gitTag: string | null;
  commitSha: string;
  /** The hash that was verified, over the package as published. Recorded in the audit row. */
  contentHash: string;
  /** The files written, with file modes ignored, which Register recomputes from the folder. */
  filesHash: string;
  /**
   * Repo-relative: `.mixos/pending/apps/postgres` for an app or connector
   * waiting for Register, `themes/aurora` for a theme.
   */
  installPath: string;
  /** True for an app or connector, which waits in `.mixos/pending/` for Register. */
  pending: boolean;
  /** The files written and their bytes, the install record not counted. */
  fileCount: number;
  byteCount: number;
  /**
   * What install left out of the package, by name: `{ ".gitignore": 2 }`, or
   * `{}` (./left-out.ts). The content hash covers these files; the files hash
   * and the counts above don't.
   */
  leftOut: LeftOut;
  /** What the check left to registration, which loads the extension's code. */
  deferred: string[];
  /** The generator's run, for a theme. Null for a pending install, which runs nothing. */
  registry: RegistryOutcome | null;
  /**
   * For a theme, which registers as it installs: what to commit, and how
   * (./hand-back.ts). Null for a pending install, whose Register hands back.
   */
  handBack: HandBack | null;
  /** What the admin has to do before this is actually live. */
  nextStep: string;
}

/* -------------------------------------------------------------------------- */
/*  Environment                                                                */
/* -------------------------------------------------------------------------- */

export interface Installability {
  ok: boolean;
  /** Why not, phrased for an admin rather than for a log. */
  reason?: string;
  /**
   * Which refusal it is. `built-deployment` is the design rather than a
   * fault, and pages show it as information; the others are a checkout that
   * can't do what it should, and read as a warning.
   */
  code?: "disabled" | "built-deployment" | "not-writable" | "no-generator";
}

/**
 * Can this deployment register anything at all?
 *
 * Answered before the browse page renders its install buttons, so an admin on
 * a read-only deployment is told once, at the top, rather than after choosing
 * something and waiting for a download.
 */
export async function checkInstallable(kind: ExtensionKind): Promise<Installability> {
  // Turned off for this kind (INSTALL_APPS and friends, ./policy.ts). First,
  // because it is a decision rather than a property of the environment, and it
  // holds whatever the environment could do.
  if (!installEnabled(kind)) {
    return { ok: false, reason: installDisabledMessage(kind), code: "disabled" };
  }

  /*
    A BUILT DEPLOYMENT CANNOT REGISTER, and has to be told so up front.

    This check used to be writability plus "is the generator file there", and
    both of those PASS on a Next standalone build: `outputFileTracingIncludes`
    copies `apps/` in, and the tracer follows the literal paths in this module
    and pulls `scripts/` and `node_modules/tsx` along with them. What it does
    not pull is `esbuild`, `typescript` or `zod` — so the generator is present
    and cannot run.

    The failure that produced was `rejected-by-registry`: the download verified,
    the files were written, the generator was spawned, it died, everything was
    rolled back, and the admin was told the extension "did not pass this
    instance's registry checks". That reads as an accusation against the
    publisher for what is a property of the deployment.

    And even a deployment that COULD run the generator would gain nothing from
    it: the registries are compiled into `.next` at build time, so rewriting
    `src/generated/*.ts` under a running server changes nothing until the next
    build. Registering is an operation on a source checkout. There is no
    arrangement of a shipped artifact that makes it work.

    So it is said as what it is, the way a deployment works, in an information
    tone: not "cannot", which reads as a deployment that is broken.
  */
  if (isBuiltDeployment()) {
    return { ok: false, reason: BUILT_DEPLOYMENT_NOTICE, code: "built-deployment" };
  }

  // Where this install writes: `.mixos/` for an app or a connector, which
  // waits there for Register; `themes/` for a theme. Register checks `apps/`
  // or `connectors/` when it runs.
  if (!(await canWrite(kind === "theme" ? THEMES_DIR : MIXOS_DIR))) {
    const folder = kind === "theme" ? "themes/" : ".mixos/";
    return {
      ok: false,
      reason:
        `This server can't write to ${folder} in its checkout, and installing writes there. ` +
        `Install in a checkout where it can, commit, and deploy.`,
      code: "not-writable",
    };
  }
  try {
    await fs.access(GENERATOR);
  } catch {
    return {
      ok: false,
      reason:
        "The registry generator isn't in this checkout, and installing runs its check. " +
        "Install in a full checkout of your repository, commit, and deploy.",
      code: "no-generator",
    };
  }
  return { ok: true };
}

/**
 * Whether this process can write in `dir`, or, when it doesn't exist yet, make
 * it in its parent. `.mixos/` is made by the first install.
 */
async function canWrite(dir: string): Promise<boolean> {
  try {
    await fs.access(dir, fs.constants.W_OK);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  try {
    // The checkout itself. Named for the tracer as a path it leaves alone: as
    // a folder to read, it would be the whole project (see PROJECT_ROOT).
    await fs.access(path.join(/* turbopackIgnore: true */ dir, ".."), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function assertInstallable(kind: ExtensionKind): Promise<void> {
  const { ok, reason } = await checkInstallable(kind);
  if (!ok) throw new InstallError(reason!, "unsupported-environment");
}

/* -------------------------------------------------------------------------- */
/*  Path safety                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the directory an extension installs into, and prove it is inside the
 * directory it is supposed to be inside.
 *
 * The slug has already been through `SlugSchema`, whose character set excludes
 * every path metacharacter. This check exists anyway. A single validation
 * standing between a remote string and a filesystem write is a validation that
 * has to be right forever, including through every future edit of the schema it
 * lives in — and this one costs a `startsWith`.
 */
function resolveInstallDir(kind: ExtensionKind, slug: string): { dir: string; rel: string } {
  const base = installDir(kind);
  const dir = path.join(base, slug);
  // `path.join` normalises, so a slug carrying `..` or a separator would land
  // somewhere other than one level under `base` — and this is what notices.
  if (path.dirname(dir) !== base || !dir.startsWith(base + path.sep)) {
    throw new InstallError(
      `"${slug}" does not resolve to a directory inside ${INSTALL_SEGMENT[kind]}/.`,
      "invalid-package",
    );
  }
  return { dir, rel: `${INSTALL_SEGMENT[kind]}/${slug}` };
}

/* -------------------------------------------------------------------------- */
/*  Pre-flight                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Characters no path in a package may hold: the control characters (C0, DEL
 * and C1) and Unicode's bidi controls, which can rewrite how a path prints in a
 * terminal or in the dialogs, so that a reviewer reads one name while the disk
 * holds another. The line and paragraph separators are refused with them, for
 * starting a line where the name shows none.
 */
const UNPRINTABLE_IN_PATH = /[\p{Cc}\p{Bidi_Control}\p{Zl}\p{Zp}]/u;

/**
 * Files install leaves out of what it writes, at any depth. Compared folded.
 * ./left-out.ts says why; pathProblems() skips them and leaveOut() drops them.
 */
const LEFT_OUT: ReadonlySet<string> = new Set(LEFT_OUT_NAMES);

/** A path with each character from UNPRINTABLE_IN_PATH, or any non-ASCII one if asked, spelled `\u{…}`. */
function printablePath(p: string, { ascii = false }: { ascii?: boolean } = {}): string {
  const pattern = ascii ? /[^\x20-\x7e]/gu : new RegExp(UNPRINTABLE_IN_PATH.source, "gu");
  return p.replace(pattern, (c) => `\\u{${c.codePointAt(0)!.toString(16).toUpperCase()}}`);
}

/**
 * The spelling two paths share when a default macOS or Windows disk would
 * store them as one: case and Unicode normalisation ignored. Upper-casing
 * first folds the few letters lower-casing alone leaves apart (`ſ` and `s`).
 */
function foldPath(p: string): string {
  return p.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
}

/** The path down to, and including, segment `i`. */
const through = (segments: string[], i: number): string => segments.slice(0, i + 1).join("/");

/**
 * Every way a package's paths would put something on disk other than what they
 * name, one line each. Empty for a package whose paths are what they say.
 *
 * A file install leaves out (LEFT_OUT) is skipped before anything else is
 * checked: it is never written, so nothing about its path reaches the disk.
 *
 * - A control, bidi or line-separator character in a name. The file or folder
 *   holding it is named once, with the character spelled `\u{…}`.
 * - A `.git` file or folder at any depth, named once. Git treats the folder
 *   holding it as a repository of its own, so that folder would not be
 *   committed with the extension.
 * - A file or folder named like the install record, `.registry.json`, at any
 *   depth and in any case, named once. Install writes the record, from what it
 *   verified; a package that shipped one could claim another origin or
 *   release.
 * - Two paths, or two folders, the same but for case or Unicode normalisation.
 *   A case-insensitive checkout, the default on macOS and Windows, would store
 *   them as one: two files become whichever was written last, and that is the
 *   one that runs. Each pair is named once.
 *
 * mixos.org's publish check follows this loop, so that it refuses what install
 * would refuse and nothing else: a change here is one to make there too.
 *
 * Exported for its tests.
 */
export function pathProblems(paths: readonly string[]): string[] {
  const problems = new Set<string>();
  const spellings = new Map<string, string>();

  for (const p of paths) {
    const segments = p.split("/");
    if (LEFT_OUT.has(foldPath(segments[segments.length - 1]))) continue;

    const unprintable = segments.findIndex((s) => UNPRINTABLE_IN_PATH.test(s));
    if (unprintable >= 0) {
      problems.add(
        `"${printablePath(through(segments, unprintable))}" has a control or bidi character in its name, ` +
          `which can change how the name prints.`,
      );
      continue;
    }

    const git = segments.findIndex((s) => foldPath(s) === ".git");
    if (git >= 0) {
      problems.add(
        `"${through(segments, git)}" makes git treat the folder it is in as a repository of its own, ` +
          `so that folder would not be committed with the extension.`,
      );
    }
    const record = segments.findIndex((s) => foldPath(s) === INSTALL_RECORD_FILE);
    if (record >= 0) {
      problems.add(
        `"${through(segments, record)}" is named like the install record (${INSTALL_RECORD_FILE}), ` +
          `which only an install writes, from what it verified.`,
      );
    }

    // Each folder on the way down, and then the file itself.
    for (let i = 1; i <= segments.length; i++) {
      const spelled = segments.slice(0, i).join("/");
      const folded = foldPath(spelled);
      const other = spellings.get(folded);
      if (other === undefined) {
        spellings.set(folded, spelled);
      } else if (other !== spelled) {
        const byForm = other.normalize("NFC") === spelled.normalize("NFC");
        const [a, b] = byForm
          ? [printablePath(other, { ascii: true }), printablePath(spelled, { ascii: true })]
          : [other, spelled];
        problems.add(
          `"${a}" and "${b}" differ only in ${byForm ? "Unicode normalisation" : "case"}, so a case-insensitive ` +
            `disk, the default on macOS and Windows, would store them as one, and what landed there would not be ` +
            `what the source shows.`,
        );
        break;
      }
    }
  }
  return [...problems];
}

/**
 * The cheap checks, run on the in-memory tree before anything is written.
 *
 * These do NOT replace the registry check. They exist so the common failures —
 * an archive that is not an extension at all, a manifest for a different slug —
 * are reported without the instance's source tree being touched, and so the
 * message names the actual problem rather than being whatever the generator
 * says when it meets a directory it cannot read.
 *
 * And so that what is reviewed is what runs. A reviewer reads the source on
 * GitHub; what runs is what lands on this disk. A path that a case-insensitive
 * disk would merge with another, or that prints as something it is not, or a
 * `.git` that changes what the operator's commit records, would make the two
 * differ: `pathProblems` above. A `.gitignore` or `.gitattributes` would too,
 * and is left out instead (leaveOut() below).
 *
 * Exported for its tests.
 */
export function preflight(kind: ExtensionKind, slug: string, entries: TarEntry[]): void {
  const problems = pathProblems(entries.map((e) => e.path));
  if (problems.length > 0) {
    throw new InstallError(
      `The package has ${problems.length === 1 ? "a path" : "paths"} this instance will not write, ` +
        `because what would land on disk would not be what the source shows.`,
      "invalid-package",
      problems.join("\n"),
    );
  }

  const byPath = new Map(entries.map((e) => [e.path, e]));

  const manifestName = MANIFEST_FILE[kind];
  const manifest = byPath.get(manifestName);

  if (!manifest) {
    throw new InstallError(
      `The package has no ${manifestName} at its root, so it is not a MixOS ${kind}. ` +
        `The Registry listing may point at the wrong directory in its source repo.`,
      "invalid-package",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest.data.toString("utf8"));
  } catch (err) {
    throw new InstallError(
      `${manifestName} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      "invalid-package",
    );
  }

  const schema =
    kind === "app"
      ? RawAppManifestSchema
      : kind === "connector"
        ? RawConnectorManifestSchema
        : RawThemeManifestSchema;
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new InstallError(
      `${manifestName} is not a valid ${kind} manifest.`,
      "invalid-package",
      formatZodError(result.error),
    );
  }

  // The identifier the extension will be known by on this instance comes from
  // the DIRECTORY name, which comes from the repository's slug. A manifest
  // naming something else would install one thing under another thing's name.
  const declared = (parsed as Record<string, unknown>)[
    kind === "connector" ? "name" : "slug"
  ];
  if (typeof declared === "string" && declared !== slug) {
    throw new InstallError(
      `${manifestName} declares "${declared}", but the repository lists this as "${slug}". ` +
        `Registering it would install it under a name its own manifest disagrees with.`,
      "invalid-package",
    );
  }
}

/**
 * What install writes of a verified package, and what it leaves out: every
 * file whose name, folded, is in LEFT_OUT, at any depth, counted by name.
 *
 * It runs after the content hash is checked, which covers the package as
 * published, these files included, and before the files hash is computed,
 * which covers only what is written, so that Register and the generator can
 * recompute it from the folder.
 *
 * Exported for its tests.
 */
export function leaveOut(entries: readonly TarEntry[]): { written: TarEntry[]; leftOut: LeftOut } {
  const written: TarEntry[] = [];
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const segments = entry.path.split("/");
    const name = foldPath(segments[segments.length - 1]);
    if (LEFT_OUT.has(name)) counts.set(name, (counts.get(name) ?? 0) + 1);
    else written.push(entry);
  }
  const leftOut: LeftOut = {};
  for (const name of LEFT_OUT_NAMES) {
    const files = counts.get(name);
    if (files) leftOut[name] = files;
  }
  return { written, leftOut };
}

/* -------------------------------------------------------------------------- */
/*  Writing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Write the verified tree to its staging folder, `staged`, for the check to
 * read: `.mixos/staging/<kind dir>/<slug>/` (stagingLocation() in ./pending.ts).
 * Returns `staged`. placeTree() or placePending() then moves it on.
 *
 * Named for the slug, so the check can treat it as the extension's own folder:
 * the folder's name is the slug the import rules and every message use. And
 * under `.mixos/`, which nothing that builds or runs the checkout reads, so a
 * crash at any point here leaves nothing a later build will load.
 *
 * Staging-then-rename rather than writing straight to the target: a partial
 * write into `apps/<slug>` is a half-extension that the generator will meet on
 * its next run, and a tree the check refuses must never be in place at all.
 * The rename is the only step that moves the tree on, and it is atomic on every
 * filesystem this runs on.
 *
 * Starts by confirming the locks, then clears what an earlier run left in the
 * staging folder. A write that fails is cleaned up straight away. An install
 * that has lost a lock may share that staging folder with the one that holds it
 * now, so it leaves it as a crash would, for the next install of the slug to
 * clear.
 *
 * Exported for its tests; `runInstall` is the only caller.
 */
export async function stageTree(
  staged: string,
  entries: TarEntry[],
  lease: PlatformLease,
): Promise<string> {
  await fence(lease, "Nothing was written.");
  await fs.rm(staged, { recursive: true, force: true });
  try {
    await fs.mkdir(staged, { recursive: true });
    for (const entry of entries) {
      // `staged` is an argument, which Turbopack's tracer resolves from this
      // module's own folder, pulling all of src/lib/repository/ into the
      // build of every page that imports this module. It is a runtime path
      // under `.mixos/staging/`, so the tracer is told to leave it alone.
      const target = path.resolve(/* turbopackIgnore: true */ staged, entry.path);
      // Third and last containment check, this one on the fully-joined path.
      if (!target.startsWith(staged + path.sep)) {
        throw new InstallError(
          `The package tried to write outside its own directory: ${entry.path}`,
          "invalid-package",
        );
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      // Never carry the archive's mode across wholesale. An archive that can
      // set the mode of a file it places in the checkout can set the setuid
      // bit, and no file an extension ships is a program to execute.
      await fs.writeFile(target, entry.data, { mode: 0o644 });
    }
  } catch (err) {
    await fs.rm(staged, { recursive: true, force: true }).catch(() => {});
    throw asWriteFailure(err);
  }
  return staged;
}

/**
 * Move a staged theme the check accepted into place, at `dir`: the first moment
 * the tree is live. Confirms the locks first, and puts nothing in place without
 * them.
 *
 * Exported for its tests; `runInstall` is the only caller.
 */
export async function placeTree(
  staged: string,
  dir: string,
  lease: PlatformLease,
): Promise<void> {
  await fence(lease, "Nothing was moved into place.");
  try {
    await fs.rename(staged, dir);
  } catch (err) {
    await fs.rm(staged, { recursive: true, force: true }).catch(() => {});
    throw asWriteFailure(err);
  }
}

/**
 * Move a staged app or connector the check accepted into pending, where it
 * waits for Register, with its sidecar: the sidecar first, so a pending folder
 * always has the record Register checks it against. Confirms the locks first.
 *
 * Exported for its tests; `runInstall` is the only caller.
 */
export async function placePending(
  staged: string,
  where: PendingLocation,
  sidecar: PendingSidecar,
  lease: PlatformLease,
): Promise<void> {
  await fence(lease, "Nothing was moved into .mixos/pending/.");
  try {
    await fs.mkdir(path.dirname(where.folder), { recursive: true });
    writeSidecar(where.sidecar, sidecar);
    await fs.rename(staged, where.folder);
  } catch (err) {
    await fs.rm(where.sidecar, { force: true }).catch(() => {});
    await fs.rm(staged, { recursive: true, force: true }).catch(() => {});
    throw asWriteFailure(err);
  }
}

/**
 * Check a staged copy, and stop the install unless the check accepted it.
 * Returns the accepted outcome; throws an InstallError otherwise, once the
 * staged copy is deleted.
 *
 * Deleting it waits on the locks, as every change to the disk here does. An
 * install that has lost a lock leaves the copy where it is: nothing reads
 * `.mixos/staging/`, and the next install of the slug clears it.
 *
 * `options` are checkExtension()'s, for tests. Exported for its tests;
 * `runInstall` is the only caller.
 */
export async function checkStagedTree(
  kind: ExtensionKind,
  slug: string,
  staged: string,
  lease: PlatformLease,
  options?: Parameters<typeof checkExtension>[2],
): Promise<CheckOutcome> {
  const check = await checkExtension(kind, staged, options);
  if (check.ran && check.accepted) return check;

  const detail = check.ran ? check.problems.join("\n") : check.output;
  await fence(
    lease,
    `The staged copy in .mixos/staging/${INSTALL_SEGMENT[kind]}/${slug}/ is still on disk; ` +
      `nothing reads it, and installing ${slug} again clears it.`,
    detail,
  );
  await fs.rm(staged, { recursive: true, force: true }).catch(() => {});

  // Two different failures, and saying the wrong one sends the admin to argue
  // with a publisher about their own machine.
  throw check.ran
    ? new InstallError(
        `${slug} did not pass this instance's registry checks and was not installed.`,
        "rejected-by-registry",
        detail,
      )
    : new InstallError(
        `This instance could not complete its registry check, so ${slug} was not checked ` +
          `and was not installed. The check runs none of the extension's code. Run ` +
          `\`npm run registry\` in this checkout to see whether its generator runs.`,
        "generator-failed",
        detail,
      );
}

function asWriteFailure(err: unknown): InstallError {
  if (err instanceof InstallError) return err;
  return new InstallError(
    `Could not write to disk: ${err instanceof Error ? err.message : String(err)}`,
    "write-failed",
  );
}

/**
 * The row lock and the checkout lock as one lease: `assertHeld()` confirms
 * both, the row first. What install and Register fence every disk change with.
 */
export function bothLocks(lease: PlatformLease, lock: CheckoutLock): PlatformLease {
  return {
    async assertHeld() {
      await lease.assertHeld();
      lock.assertHeld();
    },
  };
}

/**
 * What a failed `assertHeld()` means, for the admin: which lock went, and that
 * the operation, `what` ("This install"), stopped before changing anything
 * more. Three failures, said apart. `lock-lost` is a row lock that has passed
 * to someone else, or a checkout lock that was broken or replaced.
 * `lock-unconfirmed` is a check that could not reach the database, which stops
 * the operation at the same point, because an unconfirmed lease is not one to
 * change the disk under.
 */
export function describeLockFailure(
  err: unknown,
  what: string,
): { code: "lock-lost" | "lock-unconfirmed"; message: string } {
  if (err instanceof LockLostError) {
    return {
      code: "lock-lost",
      message:
        `${what} was paused for longer than its lock lasts (a laptop going to sleep can ` +
        `do that), so another may hold the lock now. It stopped here rather than change ` +
        `files the other one may be using.`,
    };
  }
  if (err instanceof CheckoutLockLostError) {
    return {
      code: "lock-lost",
      message:
        `${what} no longer holds this checkout's lock (.mixos/lock): it was broken or ` +
        `replaced while ${what.replace(/^This /, "the ")} ran, so another operation may be changing ` +
        `the checkout. It stopped here rather than change files the other one may be using.`,
    };
  }
  // The database's own words stay in the log: they can name hosts and roles.
  console.error("[repository] could not confirm the register lock:", err);
  return {
    code: "lock-unconfirmed",
    message:
      `${what} could not confirm with the database that it still holds its lock, so it ` +
      `stopped here rather than risk changing files another operation may be using.`,
  };
}

/**
 * `lease.assertHeld()`, with a failure turned into what the admin is told: why
 * the install stopped, and `left`, what is on disk at the point it did.
 */
async function fence(lease: PlatformLease, left: string, detail?: string): Promise<void> {
  try {
    await lease.assertHeld();
  } catch (err) {
    const { code, message } = describeLockFailure(err, "This install");
    throw new InstallError(`${message} ${left}`, code, detail);
  }
}

/* -------------------------------------------------------------------------- */
/*  The registry generator: the check, then the registration                  */
/* -------------------------------------------------------------------------- */

/**
 * The whole environment a registry generator run gets: `PATH` and `TMPDIR`,
 * where they are set, and nothing else.
 *
 * The server's own environment holds `DATABASE_URL`, `AUTH_SECRET` and
 * `CONNECTOR_ENCRYPTION_KEY`, and the generator needs none of it: it reads
 * files and writes files. The run that registers an extension also loads that
 * extension's code for the first time. `PATH` is there for anything the
 * toolchain starts, and `TMPDIR` for where tsx keeps its compile cache.
 */
export function generatorEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["PATH", "TMPDIR"]) {
    const value = env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** What an install's check made of a staged extension. */
export interface CheckOutcome {
  /**
   * Whether the check reached a verdict. False when it could not be started,
   * exited non-zero, ran out of time, or left anything other than exactly one
   * well-formed verdict in its file.
   */
  ran: boolean;
  accepted: boolean;
  /** Why it was rejected, one line each, each naming its file. */
  problems: string[];
  /** What it left to registration, which loads the extension's code. */
  deferred: string[];
  /** What the check printed, for an admin to read. Nothing is read from it. */
  output: string;
}

/** The verdict's name in the directory made for it. */
const VERDICT_FILE = "verdict.json";

/**
 * Run the generator's `--check` on a staged extension, and read its verdict.
 *
 * `dir` is the staged copy, in a folder named for the slug (stagingLocation()).
 * The check reads the extension's text and runs none of its code: what it does,
 * and what it leaves to registration, is described where it lives, at the end
 * of scripts/generate-project-registry.ts.
 *
 * THE VERDICT COMES FROM A FILE. The check writes it to a path in a directory
 * made for this run, which the check must create and nothing else may already
 * hold. It counts only when the check exited 0 and that directory holds
 * exactly one well-formed verdict. What the check prints is display only: it
 * repeats file names, manifest strings and the text of schema errors, all of
 * which the extension chooses, so a line in it can be made to look like a
 * verdict, or like the absence of a refusal. Nothing is ever matched in it.
 *
 * `options` are for tests: another script in the generator's place, another
 * directory of registered manifests, a shorter time limit.
 */
export async function checkExtension(
  kind: ExtensionKind,
  dir: string,
  options: { generator?: string; registryDir?: string; timeoutMs?: number } = {},
): Promise<CheckOutcome> {
  const verdictDir = await fs.mkdtemp(path.join(os.tmpdir(), "mixos-check-"));
  const verdictFile = path.join(verdictDir, VERDICT_FILE);
  try {
    const run = await spawnCapture(
      process.execPath,
      [
        TSX_CLI,
        options.generator ?? GENERATOR,
        "--check",
        kind,
        dir,
        "--verdict-file",
        verdictFile,
        ...(options.registryDir ? ["--registry-dir", options.registryDir] : []),
      ],
      PROJECT_ROOT,
      options.timeoutMs,
      generatorEnv(),
    );

    const noVerdict = (why: string): CheckOutcome => ({
      ran: false,
      accepted: false,
      problems: [],
      deferred: [],
      output: [run.output, why].filter(Boolean).join("\n\n"),
    });
    if (run.code === null) return noVerdict("The check could not be run to the end.");
    if (run.code !== 0) return noVerdict(`The check exited with code ${run.code}, without a verdict.`);

    const verdict = await readVerdict(verdictDir);
    if (!verdict) return noVerdict("The check finished without leaving exactly one well-formed verdict.");
    return {
      ran: true,
      accepted: verdict.verdict === "accepted",
      problems: verdict.problems,
      deferred: verdict.deferred,
      output: run.output,
    };
  } finally {
    await fs.rm(verdictDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The one verdict in `dir`, or null: when the directory holds anything but
 * that one file, when it is a link or not a regular file, when it is too large
 * to be one the check wrote, or when its text is not exactly one verdict.
 */
async function readVerdict(dir: string): Promise<CheckVerdict | null> {
  const names = await fs.readdir(dir).catch(() => null);
  if (!names || names.length !== 1 || names[0] !== VERDICT_FILE) return null;

  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    // O_NOFOLLOW: a verdict is a file the check wrote, never a link to one.
    handle = await fs.open(
      path.join(dir, VERDICT_FILE),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > CHECK_VERDICT_MAX_BYTES) return null;
    return parseCheckVerdict(await handle.readFile("utf8"));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** What regenerateRegistry() runs under, and for tests, where. */
export interface RegenerateOptions {
  /**
   * The checkout lock's token. The run works under its caller's lock, and is
   * told the token in its arguments, `--lock-token`, since its environment is
   * only `PATH` and `TMPDIR` (adoptCheckoutLock() in
   * src/lib/platform/checkout-lock.ts). Without it the run would wait for the
   * lock its own caller holds.
   */
  lockToken: string;
  /** Tests: the checkout to run in. Its `src/generated/` is the one read. */
  root?: string;
  /** Tests: a script in the generator's place. */
  generator?: string;
  /** Ends the run early, as its time limit does. */
  signal?: AbortSignal;
}

/**
 * Run `scripts/generate-project-registry.ts` once an extension is in place, and
 * say whether it is now registered.
 *
 * This is the run that loads the extension's code: `widgets.ts` and every
 * `route.ts`, which the check never loads. It can refuse the extension for what
 * only that code shows, and a refusal there is not an abort: the generator
 * leaves one bad app out and still exits 0, because one bad app must not break
 * everyone else's build. So the extension is registered when the run exits 0
 * AND its identifier is in the generated module, a file this process reads.
 * Nothing in the run's output decides it.
 *
 * Install runs it for a theme, and Register (./register.ts) for an app or a
 * connector.
 */
export async function regenerateRegistry(
  kind: ExtensionKind,
  slug: string,
  options: RegenerateOptions,
): Promise<RegistryOutcome> {
  const run = await runRegistryGenerator(options);
  const { root } = options;

  if (run.code === null) {
    return { ran: false, ok: false, stopped: true, output: run.output };
  }
  if (run.code !== 0) {
    // See RegistryOutcome.stopped: a run that stopped has not said why.
    return { ran: true, ok: false, stopped: true, output: run.output };
  }

  const generated = await readRegistryModule(kind, root);
  const present = generated.includes(`"${REGISTRY_KEY[kind]}": ${JSON.stringify(slug)}`);
  return {
    ran: true,
    ok: present,
    stopped: false,
    output: present
      ? run.output
      : `${run.output}\n\nThe generator ran without error but ${slug} is not in ${REGISTRY_FILE_LABEL[kind]}.`,
  };
}

/**
 * The text of the generated module that lists `kind`: this checkout's, or the
 * one under `root`. A `root` is given by tests and by `npm run register`, never
 * by the server, which reads the constants above.
 *
 * Joined from an argument and a kind looked up at runtime, the second path is
 * the dynamic filesystem access that makes Turbopack trace the whole project
 * into every build (see PROJECT_ROOT), so the tracer is told to leave it alone.
 */
async function readRegistryModule(kind: ExtensionKind, root?: string): Promise<string> {
  if (!root) return fs.readFile(registryFile(kind), "utf8").catch(() => "");
  return fs
    .readFile(path.join(/* turbopackIgnore: true */ root, REGISTRY_FILE_LABEL[kind]), "utf8")
    .catch(() => "");
}

/**
 * One full run of the registry generator under its caller's checkout lock, with
 * `PATH` and `TMPDIR` as its environment: exit code null when it didn't finish.
 */
export function runRegistryGenerator({
  lockToken,
  root,
  generator,
  signal,
}: RegenerateOptions): Promise<{ code: number | null; output: string }> {
  return spawnCapture(
    process.execPath,
    // tsx's CLI entry, resolved from node_modules rather than via `npx`, which
    // would be free to go to the network for a package that is missing.
    [TSX_CLI, generator ?? GENERATOR, "--lock-token", lockToken],
    root ?? PROJECT_ROOT,
    GENERATOR_TIMEOUT_MS,
    generatorEnv(),
    signal,
  );
}

/** Generator runs are seconds; a minute is a hang, not a slow machine. */
const GENERATOR_TIMEOUT_MS = 120_000;

/**
 * Whether a run gets a process group of its own, so the timeout can end all of
 * it.
 *
 * tsx's CLI runs the script in a child process of its own. A kill aimed at the
 * CLI alone leaves that child running with these pipes open, so the run never
 * settles — and the register lock, renewed for as long as the run lasts, would
 * never be released. Signalling the group ends the CLI, the script and anything
 * either started. One consequence: a Ctrl-C to the dev server does not reach a
 * run already in progress, which finishes on its own.
 *
 * Not on Windows, which has no process groups to signal and where `detached`
 * opens a console window. MixOS runs there only inside WSL.
 */
const OWN_PROCESS_GROUP = process.platform !== "win32";

/**
 * Run a generator to the end or to its time limit, and collect what it printed,
 * stdout and stderr together, for display. `env` is the child's whole
 * environment, `generatorEnv()` unless a caller says otherwise. `signal` ends
 * the run early, as the time limit does: `npm run register` aborts it on
 * Ctrl-C, which a run in its own process group would not otherwise see.
 *
 * Exported for its tests; `timeoutMs` is theirs to shorten.
 */
export function spawnCapture(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number = GENERATOR_TIMEOUT_MS,
  env: Record<string, string> = generatorEnv(),
  signal?: AbortSignal,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ code: null, output: "Stopped before the registry generator started." });
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd,
        // The cast is only for Next's types, which declare NODE_ENV on every
        // environment. A generator run has none, deliberately.
        env: env as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
        detached: OWN_PROCESS_GROUP,
      });
    } catch (err) {
      resolve({ code: null, output: err instanceof Error ? err.message : String(err) });
      return;
    }
    let output = "";
    const append = (b: Buffer) => {
      // Bounded: the generator is chatty and a runaway loop must not be able to
      // fill this process's heap with its own log.
      if (output.length < 200_000) output += b.toString("utf8");
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const timer = setTimeout(() => {
      killRun(child);
      output += `\nThe registry generator did not finish within ${timeoutMs / 1000}s.`;
    }, timeoutMs);
    const stop = () => {
      killRun(child);
      output += "\nThe registry generator was stopped.";
    };
    signal?.addEventListener("abort", stop, { once: true });
    const settle = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    };

    child.on("error", (err) => {
      settle();
      resolve({ code: null, output: `${output}\n${err.message}` });
    });
    child.on("close", (code) => {
      settle();
      // A run ended by `signal` is one that did not finish, as at the time limit.
      resolve({ code: signal?.aborted ? null : code, output: output.trim() });
    });
  });
}

/** SIGKILL a run: its whole process group where it has one, else the child. */
function killRun(child: ReturnType<typeof spawn>): void {
  if (OWN_PROCESS_GROUP && child.pid !== undefined) {
    try {
      // A negative pid signals every process in the group.
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // The group is already gone; the child below is a no-op then too.
    }
  }
  child.kill("SIGKILL");
}

/* -------------------------------------------------------------------------- */
/*  The pipeline                                                               */
/* -------------------------------------------------------------------------- */

export interface InstallOptions {
  /** A specific release. Omitted takes whatever the repository calls current. */
  version?: string;
  /**
   * Proceed even though the release is yanked.
   *
   * A yanked release is one the publisher withdrew — usually because it is
   * broken or unsafe — while leaving it resolvable so existing installs keep
   * working. Installing one NEW is a decision, so it takes a second, explicit
   * act by the admin after being shown `yankedReason`.
   */
  allowYanked?: boolean;
  /** Who the install is for, as the audit row names them, for a pending install's sidecar. */
  installedBy?: string;
}

/**
 * Resolve what would be installed, without installing it.
 *
 * The confirmation step reads this: it is what lets the dialog state the exact
 * version, commit and checksum an admin is about to accept, rather than asking
 * them to approve "the latest".
 */
export async function resolveInstall(
  kind: ExtensionKind,
  slug: string,
  version?: string,
): Promise<InstallManifest> {
  const manifest = await fetchInstallManifest(kind, slug, version);
  if (!manifest.commitSha) {
    throw new InstallError(
      `The repository has no installable release for ${slug}.`,
      "no-release",
    );
  }
  /*
    A checksum that is not a checksum ends it here, before anything is
    downloaded, and it is reported as its own thing rather than as a parse
    error — the repository is answering correctly; what it is saying is that
    this release cannot be verified.

    mixos.org's seeded catalogue publishes `sha256-PLACEHOLDER-<slug>` today, so
    this is currently the outcome for every listing on it. That is the pipeline
    working. The one behaviour that would be wrong here is falling back to
    installing without a check, which is why there is no flag to do so — unlike
    `yanked`, which an admin may knowingly accept, an unverifiable download is
    not a risk anyone is in a position to weigh.
  */
  if (!isVerifiableHash(manifest.contentHash)) {
    throw new InstallError(
      `The repository has not published a real checksum for ${slug} ${manifest.version} — ` +
        `it returned "${manifest.contentHash}". There is nothing to verify the download ` +
        `against, so it cannot be registered.`,
      "unverifiable-checksum",
    );
  }
  return manifest;
}

/**
 * Install an extension into this checkout: an app or a connector into
 * `.mixos/pending/`, to wait for Register; a theme into `themes/`.
 *
 * Callers must have already established that the actor is an admin — this
 * module does not authenticate. See `actions.ts`, which is the only entry
 * point the UI has, and which gates and audits every call.
 *
 * ── WHY THE WHOLE THING IS UNDER TWO LOCKS ──────────────────────────────────
 *
 * The row lock, `repository.register`, is the one every instance on this
 * database shares. The checkout lock, `.mixos/lock`, is the one every process
 * changing this checkout shares, the registry generator that `npm run dev` and
 * `npm run registry` start included, which uses no database
 * (src/lib/platform/checkout-lock.ts says why both). Held together, they keep a
 * second install, a registration or a generator run from changing the same
 * folders, or rewriting the shared `src/generated/*.ts` modules, while this one
 * does. The exists-checks are inside the locks too, so two installs of the SAME
 * slug cannot both find it absent and both proceed to write it.
 *
 * The row lock is instance-wide rather than per-slug because the contended
 * resource is the generated registry, which every kind and every slug shares.
 *
 * ── AND WHY EVERY DISK CHANGE CHECKS THEM FIRST ─────────────────────────────
 *
 * The row lock is a lease (src/lib/platform/lock.ts) that anyone may take once
 * it has gone 15 minutes without renewal, and an install can be paused for
 * longer than that: a laptop running `next dev` goes to sleep mid-download,
 * wakes up and carries on. The checkout lock can be broken by hand while it is.
 * So the lease renews itself every minute while this runs, and both locks are
 * confirmed (bothLocks()) before writing the staging tree, before deleting a
 * staged copy the check refused, before moving the tree on and before a theme's
 * rollback. An install that finds a lock gone stops there with `lock-lost`, says
 * what it left on disk, and cleans nothing up: what it would remove may be the
 * new holder's.
 *
 * Renewal holds the lock for as long as this runs, so everything here has a
 * time limit: the repository and GitHub requests, and every generator run,
 * whose whole process group `spawnCapture` ends at the limit.
 */
export async function installExtension(
  kind: ExtensionKind,
  slug: string,
  options: InstallOptions = {},
): Promise<InstallResult> {
  // Before the locks: a kind this instance does not install, or a deployment
  // that cannot install anything, should not hold up anyone else's install
  // while it is refused.
  if (!installEnabled(kind)) {
    throw new InstallError(installDisabledMessage(kind), "disabled");
  }
  await assertInstallable(kind);
  // Every path below is built from the slug, which the Registry validates and
  // this checks again before it names anything on disk.
  if (!SlugSchema.safeParse(slug).success) {
    throw new InstallError(`"${slug}" is not an extension slug.`, "invalid-package");
  }

  return withPlatformLock("repository.register", (lease) =>
    withCheckoutLock(PROJECT_ROOT, `an install of ${kind}/${slug} from the Registry`, (lock) => {
      if (lock.tookOver) {
        console.warn(
          `[repository] took over the checkout lock from ` +
            `${describeCheckoutLockHolder(lock.tookOver)}, which had stopped.`,
        );
      }
      return runInstall(kind, slug, options, bothLocks(lease, lock), lock.token);
    }),
  );
}

async function runInstall(
  kind: ExtensionKind,
  slug: string,
  options: InstallOptions,
  lease: PlatformLease,
  lockToken: string,
): Promise<InstallResult> {
  const { dir, rel } = resolveInstallDir(kind, slug);

  // Refuse to overwrite. Upgrading in place is a different operation with a
  // different question attached — what happens to the data and grants the
  // existing one already has — and quietly replacing a directory on an admin
  // who meant to install something new is the worst possible answer to it.
  if (pathExists(dir)) {
    throw new InstallError(
      `${rel} already exists in this checkout. Remove it first, or update it in its own source repo.`,
      "already-installed",
    );
  }
  // Nor one already waiting for Register: discarding it is a choice, and
  // installing again over it would make it for the admin.
  const where = kind === "theme" ? null : pendingLocation(PROJECT_ROOT, kind, slug);
  if (where) assertNotPending(kind, slug, where);

  const manifest = await resolveInstall(kind, slug, options.version);

  if (manifest.yanked && !options.allowYanked) {
    throw new InstallError(
      `Version ${manifest.version} has been withdrawn by its publisher` +
        (manifest.yankedReason ? `: ${manifest.yankedReason}` : ".") +
        ` Installing it is possible but has to be chosen explicitly.`,
      "yanked",
    );
  }

  /*
    The publisher's floor, compared with this build's version: `package.json`'s,
    which every build stamps into `src/generated/build-info.ts` (see
    `src/lib/platform/version.ts`). Every checkout and every deployment has one,
    so the floor the publisher declared holds wherever this runs. Register checks
    it again, against the checkout it runs in.

    Unlike `yanked`, this has no override. A withdrawn release is a risk an admin
    is in a position to weigh; a release that needs platform features this build
    does not have is not a judgement call, and the failure it produces lands on
    users rather than on the admin who accepted it.

    A floor that is not a version cannot be compared, and is allowed with a
    reason rather than refused — see `satisfiesMinimum`. That path is logged,
    because a floor that was declared and not enforced should never be silent.
  */
  const compat = satisfiesMinimum(manifest.requiresMixOS);
  if (!compat.allowed) {
    throw new InstallError(compat.reason!, "incompatible");
  }
  if (compat.reason) {
    console.warn(`[repository] ${kind}/${slug}: ${compat.reason}`);
  }

  // What the install record will say about where this came from, checked
  // before anything is downloaded: a release whose answer can't be recorded is
  // refused here rather than after the download.
  const origin = recordedOrigin(kind, slug, manifest);

  // Steps 3–5. Nothing has touched the filesystem yet, and nothing will until
  // verifyContentHash returns.
  const entries = await fetchExtensionTree({
    tarballUrl: manifest.tarballUrl,
    commitSha: manifest.commitSha,
    // `?? undefined` rather than passing it through: the repository sends an
    // absent subpath as an explicit `null`, and `rootAt` distinguishes "no
    // subpath" from a subpath it cannot use.
    subpath: manifest.subpath ?? undefined,
  });
  const contentHash = verifyContentHash(entries, manifest.contentHash);

  // Step 6: pre-flight, then what install leaves out, then the install record:
  // what was verified, including the files hash Register and the generator
  // check the folder against, which is over what is written. The record goes
  // into the tree, so it waits in pending with the extension and is committed
  // with it.
  preflight(kind, slug, entries);
  const { written, leftOut } = leaveOut(entries);
  const record: InstallRecord = { ...origin, contentHash, filesHash: filesHash(written) };
  const tree = [...written, installRecordEntry(record)];

  // Step 7, fenced by the locks (see stageTree).
  const staged = await stageTree(stagingLocation(PROJECT_ROOT, kind, slug).dir, tree, lease);

  // Step 8. The staged copy is judged before it is anywhere a build or the dev
  // server would look, and before any of its code has run.
  const check = await checkStagedTree(kind, slug, staged, lease);

  const verified = {
    kind,
    slug,
    name: manifest.name,
    record,
    version: record.version,
    gitTag: record.gitTag,
    commitSha: record.commitSha,
    contentHash: record.contentHash,
    filesHash: record.filesHash,
    // The files written, without the record install added.
    fileCount: written.length,
    byteCount: written.reduce((n, e) => n + e.data.length, 0),
    leftOut,
    deferred: check.deferred,
  };

  // Step 9, for an app or a connector: into pending, with its sidecar. None of
  // its code has run, and none will until Register.
  if (where) {
    await placePending(
      staged,
      where,
      {
        kind: kind as PendingSidecar["kind"],
        slug,
        yankedAccepted: manifest.yanked === true,
        installedAt: new Date().toISOString(),
        installedBy: options.installedBy ?? "an administrator",
        check: { verdict: "accepted", deferred: check.deferred },
        // For Register to say again. Left off when nothing was left out.
        ...(Object.keys(leftOut).length > 0 ? { leftOut } : {}),
      },
      lease,
    );
    return {
      ...verified,
      installPath: where.rel,
      pending: true,
      registry: null,
      handBack: null,
      nextStep:
        `Installed to ${where.rel}/, where nothing runs it yet. Read its code there, then ` +
        `register it in this checkout with \`npm run register -- ${kind}/${slug}\`, which runs ` +
        `its code for the first time. Then commit ${INSTALL_SEGMENT[kind]}/${slug} and deploy it.`,
    };
  }

  // Step 9, for a theme, fenced by the locks (see placeTree), then the
  // registry generator.
  await placeTree(staged, dir, lease);
  const registry = await regenerateRegistry(kind, slug, { lockToken });
  if (registry.ran && !registry.ok) {
    // Undo. Removing the directory is not enough on its own: the failed run may
    // already have rewritten src/generated, so the generator is run once more
    // to restore a registry that matches what is actually on disk.
    //
    // Only while the locks are still this install's. Without them, another
    // operation may be running the generator over these same files, so the
    // admin is told what to clean up instead.
    await fence(
      lease,
      `${rel} is still on disk and was not registered: delete it, then run ` +
        `\`npm run registry\`.`,
      registry.output,
    );
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await regenerateRegistry(kind, slug, { lockToken }).catch(() => {});

    // The check passed and a theme runs no code, so a run that left it out
    // found what the check doesn't read, and one that stopped could also be
    // this checkout. Install cannot tell which.
    throw registry.stopped
      ? new InstallError(
          `The registry generator stopped while registering ${slug}, after its check had ` +
            `passed, so it was not installed. The output below may be about the theme or ` +
            `about this checkout.`,
          "generator-failed",
          registry.output,
        )
      : new InstallError(
          `${slug} passed this instance's registry check, but the registry generator left it ` +
            `out, so it was not installed.`,
          "rejected-by-registry",
          registry.output,
        );
  }

  return {
    ...verified,
    installPath: rel,
    pending: false,
    registry,
    handBack: handBackFor(
      record,
      rel,
      tree
        .map((e) => ({ path: e.path, bytes: e.data.length }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    ),
    nextStep: registry.ran
      ? process.env.NODE_ENV === "development"
        ? `Registered to ${rel}. The dev server picks it up on its next compile — reload the page it appears on.`
        : `Registered to ${rel} and validated. Commit ${rel} and redeploy: the registries are generated at build time, so this instance serves it after the next build.`
      : `Written to ${rel}, but the registry generator could not be run here. ` +
        `Run \`npm run registry\` in the checkout and restart the server before it is usable.`,
  };
}

/**
 * What the install record says about where a release came from, from the
 * catalogue's answer: the catalogue, the release, and the GitHub repository its
 * download URL names, with the folder in it. Everything but the hashes, which
 * come from the download. Throws `invalid-package` for an answer with a value
 * the record can't hold, so nothing is downloaded for it.
 */
function recordedOrigin(
  kind: ExtensionKind,
  slug: string,
  manifest: InstallManifest,
): Omit<InstallRecord, "contentHash" | "filesHash"> {
  const repository = repositoryFromTarballUrl(manifest.tarballUrl);
  if (!repository) {
    throw new InstallError(
      `The repository's download URL for ${slug} doesn't name a GitHub repository, so where it came from ` +
        `couldn't be recorded. It was not installed.`,
      "invalid-package",
    );
  }
  const origin = {
    source: repositoryBaseUrl(),
    kind,
    slug,
    version: manifest.version,
    gitTag: manifest.gitTag ?? null,
    commitSha: manifest.commitSha,
    repository: { ...repository, subpath: (manifest.subpath ?? "").replace(/^\/+|\/+$/g, "") || null },
    requiresMixOS: manifest.requiresMixOS ?? null,
  };
  const parsed = InstallRecordSchema.omit({ contentHash: true, filesHash: true }).safeParse(origin);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new InstallError(
      `The repository's answer for ${slug} has a value this instance can't record ` +
        `(${issue?.path.join(".") || "it"}: ${issue?.message ?? "invalid"}), so it was not installed.`,
      "invalid-package",
    );
  }
  return parsed.data;
}

/**
 * Refuse an install of a slug already waiting in pending, or left there by a
 * registration that stopped midway, naming what to run instead.
 */
function assertNotPending(kind: ExtensionKind, slug: string, where: PendingLocation): void {
  const read = readSidecar(where.sidecar);
  if (read.state === "ok" && read.sidecar.register) {
    throw new InstallError(
      `A registration of ${slug} stopped before it finished. Run \`npm run register -- --recover\` ` +
        `in this checkout, then try again.`,
      "already-installed",
    );
  }
  if (pathExists(where.folder) || read.state !== "missing") {
    throw new InstallError(
      `${slug} is already installed and waiting in ${where.rel}/. Register or discard it in ` +
        `Admin > ${kind === "app" ? "Apps" : "Connectors"}, or with ` +
        `\`npm run register -- ${kind}/${slug}\` or \`npm run register -- ${kind}/${slug} --discard\`.`,
      "already-installed",
    );
  }
}
