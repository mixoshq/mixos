/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Registering an extension from mixos.org onto this instance.
 *
 * "Register" here means what the admin sees it mean: the extension's source
 * lands in `apps/`, `connectors/` or `themes/` and becomes part of what this
 * instance offers everyone on it. It is a privileged, instance-wide act, which
 * is why every entry point into this module is admin-gated and audited.
 *
 * ── THE ORDER OF OPERATIONS IS THE SECURITY MODEL ───────────────────────────
 *
 * Before the lock: the kind's install flag, then `assertInstallable` (not a
 * built deployment, a writable folder, a generator to run). Then, under the
 * `repository.register` lock, with the target directory confirmed absent:
 *
 * 1.  Ask mixos.org how to install → commit, download URL, content hash.
 * 2.  Refuse a yanked release unless the admin has been shown why and insisted.
 * 3.  Download from GitHub, pinned to the commit, through the host allowlist.
 * 4.  Read the archive IN MEMORY. Reject symlinks, traversal, oversize trees.
 * 5.  **Verify the content hash.** Mismatch ends it here, with nothing written.
 * 6.  Pre-flight: the manifest exists, parses and is for this slug, and no
 *     path would land on disk as something other than what it names.
 * 7.  Write to a staging directory beside the target, never to the target.
 * 8.  **Check the staged copy without running it**: the generator's `--check`,
 *     which reads the extension's text, imports none of its code, and writes
 *     its verdict to a file this process names. Rejected, or no verdict at
 *     all: delete the staged copy and stop.
 * 9.  Rename staging into place. This is the first moment the tree is live.
 * 10. Run the project registry generator, which loads the extension's code for
 *     the first time to read what only its code can say.
 * 11. If that run left the extension out or stopped, remove the directory and
 *     regenerate again, so a failed registration leaves the instance exactly
 *     as it was.
 *
 * Steps 7, 9 and 11 each begin by confirming the lock is still this
 * registration's (`lease.assertHeld()`, see `installExtension`), and stop
 * without touching the disk when it is not. So does deleting a staged copy the
 * check refused.
 *
 * Steps 3–5 are ordered that way deliberately: nothing untrusted touches the
 * filesystem before the hash has been checked. An extract-then-verify pipeline
 * has a window where a tampered tree is on disk, and then depends on its
 * cleanup path being correct for that not to matter.
 *
 * Steps 8–10 are ordered the same way for the code: nothing the package ships
 * runs before the text of all of it has been checked, and the check's answer
 * comes from a file, never from what the check prints, which repeats what the
 * package says about itself. Both generator runs get `PATH` and `TMPDIR` as
 * their whole environment (`generatorEnv`).
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
import { fetchInstallManifest } from "./client";
import { fetchExtensionTree } from "./fetch-source";
import { verifyContentHash } from "./content-hash";
import { isBuiltDeployment } from "../platform/build";
import { LockLostError, withPlatformLock, type PlatformLease } from "../platform/lock";
import { satisfiesMinimum } from "../platform/version";
import type { TarEntry } from "./tar";
import { isVerifiableHash, type ExtensionKind, type InstallManifest } from "./types";
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
const GENERATOR = path.join(PROJECT_ROOT, "scripts/generate-project-registry.ts");
const TSX_CLI = path.join(PROJECT_ROOT, "node_modules/tsx/dist/cli.mjs");

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
  version: string;
  /** Null for a release published without a tag. */
  gitTag: string | null;
  commitSha: string;
  /** The hash that was verified. Recorded in the audit row. */
  contentHash: string;
  /** Repo-relative, e.g. `apps/postgres`. */
  installPath: string;
  fileCount: number;
  byteCount: number;
  registry: RegistryOutcome;
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
    return { ok: false, reason: installDisabledMessage(kind) };
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
  */
  if (isBuiltDeployment()) {
    return {
      ok: false,
      reason:
        "This instance is running a built artifact, so it cannot register extensions. " +
        "Registering copies source into the checkout and re-runs the build-time registry " +
        "generator, and a compiled deployment has neither the toolchain to run it nor a " +
        "build to pick up the result. Browse from here, then register on a machine with " +
        "a writable checkout and deploy what it produces.",
    };
  }

  try {
    await fs.access(installDir(kind), fs.constants.W_OK);
  } catch {
    return {
      ok: false,
      reason:
        `This deployment cannot register extensions: ${INSTALL_SEGMENT[kind]}/ is not writable. ` +
        `Registering copies source into the checkout and re-runs the build-time ` +
        `registry generator, which a read-only or serverless filesystem cannot do. ` +
        `Register on a machine with a writable checkout and deploy the result.`,
    };
  }
  try {
    await fs.access(GENERATOR);
  } catch {
    return {
      ok: false,
      reason:
        "This deployment cannot register extensions: the registry generator is not " +
        "present in the running image, so a newly written extension could never be " +
        "validated or picked up.",
    };
  }
  return { ok: true };
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
 * Files git reads from the tree it is adding, at any depth.
 *
 * A package that ships one changes what the operator's repository records when
 * the extension is committed, or how a review shows it: `.gitattributes` can
 * hide a diff (`-diff`) or fold files away as generated, `.gitignore` can keep a
 * file the extension runs out of the commit, and a `.git` makes git treat the
 * folder as a repository of its own, which `git add` does not descend into.
 */
const GIT_CONTROL_FILES = new Set([".gitattributes", ".gitignore", ".git"]);

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

/**
 * Every way a package's paths would put something on disk other than what they
 * name, one line each. Empty for a package whose paths are what they say.
 *
 * - Two paths, or two folders, the same but for case or Unicode normalisation.
 *   A case-insensitive checkout, the default on macOS and Windows, would store
 *   them as one: two files become whichever was written last, and that is the
 *   one that runs.
 * - A control, bidi or line-separator character anywhere in a path.
 * - A git control file at any depth (GIT_CONTROL_FILES).
 *
 * Exported for its tests.
 */
export function pathProblems(paths: readonly string[]): string[] {
  const problems = new Set<string>();
  const spellings = new Map<string, string>();

  for (const p of paths) {
    if (UNPRINTABLE_IN_PATH.test(p)) {
      problems.add(
        `"${printablePath(p)}" has a control or bidi character in its name, which can change how the name prints.`,
      );
      continue;
    }

    const segments = p.split("/");
    const git = segments.find((s) => GIT_CONTROL_FILES.has(foldPath(s)));
    if (git) {
      problems.add(
        `"${p}" is a git control file (${git}), which would change what your repository records for the extension, or how a review shows it.`,
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
 * git control file that changes what the operator's commit records, would make
 * the two differ: `pathProblems` above.
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

/* -------------------------------------------------------------------------- */
/*  Writing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Where an extension waits while it is checked: `<kind dir>/.installing-<slug>/`,
 * holding the staged copy in a folder named for the slug.
 *
 * Dot-prefixed, because the generator never scans a dot-prefixed folder, so a
 * crash at any point here leaves nothing a later build will read. And the copy
 * sits one level down, in `<slug>/`, so that the check can treat it as the
 * extension's own folder: the folder's name is the slug the import rules and
 * every message use.
 */
function stagingHolder(dir: string): string {
  return path.join(path.dirname(dir), `.installing-${path.basename(dir)}`);
}

/**
 * Write the verified tree to a staging directory, for the check to read.
 * Returns the staged copy's folder. placeTree() then moves it into place.
 *
 * Staging-then-rename rather than writing straight to the target: a partial
 * write into `apps/<slug>` is a half-extension that the generator will meet on
 * its next run — including the run that `next dev` triggers on its own — and a
 * tree the check refuses must never be in place at all. The rename is the only
 * step that makes the tree visible, and it is atomic on every filesystem this
 * runs on.
 *
 * Starts by confirming the lease, then clears what an earlier run left in the
 * staging directory. A write that fails is cleaned up straight away. A
 * registration that has lost the lock may share that staging directory with
 * the one that holds it now, so it leaves it as a crash would, for the next
 * registration of the slug to clear.
 *
 * Exported for its tests; `runInstall` is the only caller.
 */
export async function stageTree(
  dir: string,
  entries: TarEntry[],
  lease: PlatformLease,
): Promise<string> {
  const holder = stagingHolder(dir);
  const staged = path.join(holder, path.basename(dir));

  await fence(lease, "Nothing was written.");
  await fs.rm(holder, { recursive: true, force: true });
  try {
    for (const entry of entries) {
      const target = path.resolve(staged, entry.path);
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
    await fs.rm(holder, { recursive: true, force: true }).catch(() => {});
    throw asWriteFailure(err);
  }
  return staged;
}

/**
 * Move a staged copy the check accepted into place, at `dir`: the first moment
 * the tree is live. Confirms the lease first, and puts nothing in place without
 * it.
 *
 * Exported for its tests; `runInstall` is the only caller.
 */
export async function placeTree(
  staged: string,
  dir: string,
  lease: PlatformLease,
): Promise<void> {
  const holder = path.dirname(staged);

  await fence(lease, "Nothing was moved into place.");
  try {
    await fs.rename(staged, dir);
  } catch (err) {
    await fs.rm(holder, { recursive: true, force: true }).catch(() => {});
    throw asWriteFailure(err);
  }
  // Empty now. `rmdir` removes nothing else, if anything else is there.
  await fs.rmdir(holder).catch(() => {});
}

/**
 * Check a staged copy, and stop the install unless the check accepted it.
 * Returns the accepted outcome; throws an InstallError otherwise, once the
 * staged copy is deleted.
 *
 * Deleting it waits on the lease, as every change to the disk here does. A
 * registration that has lost the lock leaves the copy where it is: it is
 * dot-prefixed, so nothing scans it, and the next registration of the slug
 * clears it.
 *
 * `options` are checkExtension()'s, for tests. Exported for its tests;
 * `runInstall` is the only caller.
 */
export async function checkStagedTree(
  kind: ExtensionKind,
  dir: string,
  staged: string,
  lease: PlatformLease,
  options?: Parameters<typeof checkExtension>[2],
): Promise<CheckOutcome> {
  const slug = path.basename(dir);
  const check = await checkExtension(kind, staged, options);
  if (check.ran && check.accepted) return check;

  const detail = check.ran ? check.problems.join("\n") : check.output;
  await fence(
    lease,
    `The staged copy in ${INSTALL_SEGMENT[kind]}/.installing-${slug}/ is still on disk; ` +
      `nothing reads it, and installing ${slug} again clears it.`,
    detail,
  );
  await fs.rm(stagingHolder(dir), { recursive: true, force: true }).catch(() => {});

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
 * `lease.assertHeld()`, with a failure turned into what the admin is told: why
 * this stopped, and `left`, what is on disk at the point it did.
 *
 * Two failures, said apart. `lock-lost` is a lease that has passed to someone
 * else. `lock-unconfirmed` is a check that could not reach the database, which
 * stops the registration at the same point, because an unconfirmed lease is
 * not one to change the disk under.
 */
async function fence(lease: PlatformLease, left: string, detail?: string): Promise<void> {
  try {
    await lease.assertHeld();
  } catch (err) {
    if (err instanceof LockLostError) {
      throw new InstallError(
        `This registration was paused for longer than its lock lasts (a laptop going ` +
          `to sleep can do that), so another registration may hold the lock now. It ` +
          `stopped here rather than change files the other one may be using. ${left}`,
        "lock-lost",
        detail,
      );
    }
    // The database's own words stay in the log: they can name hosts and roles.
    console.error("[repository] could not confirm the register lock:", err);
    throw new InstallError(
      `This registration could not confirm with the database that it still holds ` +
        `its lock, so it stopped here rather than risk changing files another ` +
        `registration may be using. ${left}`,
      "lock-unconfirmed",
      detail,
    );
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
 * `dir` is the staged copy, in a folder named for the slug (stagingHolder()).
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

/**
 * Run `scripts/generate-project-registry.ts` once the check has accepted the
 * extension and it is in place, and say whether it is now registered.
 *
 * This is the run that loads the extension's code: `widgets.ts` and every
 * `route.ts`, which the check left to it. It can refuse the extension for what
 * only that code shows, and a refusal there is not an abort: the generator
 * leaves one bad app out and still exits 0, because one bad app must not break
 * everyone else's build. So the extension is registered when the run exits 0
 * AND its identifier is in the generated module, a file this process reads.
 * Nothing in the run's output decides it.
 */
async function regenerateRegistry(
  kind: ExtensionKind,
  slug: string,
): Promise<RegistryOutcome> {
  const run = await spawnCapture(
    process.execPath,
    // tsx's CLI entry, resolved from node_modules rather than via `npx`, which
    // would be free to go to the network for a package that is missing.
    [TSX_CLI, GENERATOR],
    PROJECT_ROOT,
    GENERATOR_TIMEOUT_MS,
    generatorEnv(),
  );

  if (run.code === null) {
    return { ran: false, ok: false, stopped: true, output: run.output };
  }
  if (run.code !== 0) {
    // See RegistryOutcome.stopped: a run that stopped has not said why.
    return { ran: true, ok: false, stopped: true, output: run.output };
  }

  const generated = await fs.readFile(registryFile(kind), "utf8").catch(() => "");
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
 * environment, `generatorEnv()` unless a caller says otherwise.
 *
 * Exported for its tests; `timeoutMs` is theirs to shorten.
 */
export function spawnCapture(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number = GENERATOR_TIMEOUT_MS,
  env: Record<string, string> = generatorEnv(),
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
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

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, output: `${output}\n${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output: output.trim() });
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
 * Register an extension onto this instance.
 *
 * Callers must have already established that the actor is an admin — this
 * module does not authenticate. See `actions.ts`, which is the only entry
 * point the UI has, and which gates and audits every call.
 *
 * ── WHY THE WHOLE THING IS UNDER A LOCK ─────────────────────────────────────
 *
 * `regenerateRegistry` rewrites the shared `src/generated/*.ts` modules, and the
 * rollback path rewrites them again. Two admins registering at once run two
 * generator processes over the same three files, and the second one's rollback
 * can land on top of the first one's success. The exists-check is inside the
 * lock too, so two concurrent registrations of the SAME slug cannot both find
 * the directory absent and both proceed to write it.
 *
 * The lock is instance-wide rather than per-slug because the contended resource
 * is the generated registry, which every kind and every slug shares.
 *
 * ── AND WHY EVERY DISK CHANGE CHECKS IT FIRST ───────────────────────────────
 *
 * The lock is a lease (src/lib/platform/lock.ts) that anyone may take once it
 * has gone 15 minutes without renewal, and a registration can be paused for
 * longer than that: a laptop running `next dev` goes to sleep mid-download,
 * wakes up and carries on. So the lease renews itself every minute while this
 * runs, and `lease.assertHeld()` comes before writing the staging tree, before
 * deleting a staged copy the check refused, before the rename and before the
 * rollback. A registration that finds the lock gone stops there with
 * `lock-lost`, says what it left on disk, and cleans nothing up: what it would
 * remove may be the new holder's.
 *
 * Renewal holds the lock for as long as this runs, so everything here has a
 * time limit: the repository and GitHub requests, and both generator runs, the
 * check and the registration, whose whole process group `spawnCapture` ends at
 * the limit.
 */
export async function installExtension(
  kind: ExtensionKind,
  slug: string,
  options: InstallOptions = {},
): Promise<InstallResult> {
  // Before the lock: a kind this instance does not install, or a deployment
  // that cannot register anything, should not hold up anyone else's
  // registration while it is refused.
  if (!installEnabled(kind)) {
    throw new InstallError(installDisabledMessage(kind), "disabled");
  }
  await assertInstallable(kind);

  return withPlatformLock("repository.register", (lease) =>
    runInstall(kind, slug, options, lease),
  );
}

async function runInstall(
  kind: ExtensionKind,
  slug: string,
  options: InstallOptions,
  lease: PlatformLease,
): Promise<InstallResult> {
  const { dir, rel } = resolveInstallDir(kind, slug);

  // Refuse to overwrite. Upgrading in place is a different operation with a
  // different question attached — what happens to the data and grants the
  // existing one already has — and quietly replacing a directory on an admin
  // who meant to install something new is the worst possible answer to it.
  try {
    await fs.access(dir);
    throw new InstallError(
      `${rel} already exists on this instance. Remove it first, or update it in its own source repo.`,
      "already-installed",
    );
  } catch (err) {
    if (err instanceof InstallError) throw err;
    // ENOENT is the good case.
  }

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
    so the floor the publisher declared holds wherever this runs.

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

  preflight(kind, slug, entries);

  // Step 7, fenced by the lease (see stageTree).
  const staged = await stageTree(dir, entries, lease);

  // Step 8. The staged copy is judged before it is anywhere a build or the dev
  // server would look, and before any of its code has run.
  await checkStagedTree(kind, dir, staged, lease);

  // Step 9, fenced by the lease (see placeTree).
  await placeTree(staged, dir, lease);

  // Step 10: registration, the first time any of the extension's code runs.
  const registry = await regenerateRegistry(kind, slug);
  if (registry.ran && !registry.ok) {
    // Undo. Removing the directory is not enough on its own: the failed run may
    // already have rewritten src/generated, so the generator is run once more
    // to restore a registry that matches what is actually on disk.
    //
    // Only while the lock is still this registration's. Without it, another
    // registration may be running the generator over these same files, so the
    // admin is told what to clean up instead.
    await fence(
      lease,
      `${rel} is still on disk and was not registered: delete it, then run ` +
        `\`npm run registry\`.`,
      registry.output,
    );
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await regenerateRegistry(kind, slug).catch(() => {});

    // The check passed, so what refused it here is what the check leaves to
    // registration: the extension's code, loaded for the first time. A run
    // that stopped could also be this checkout, and install cannot tell which.
    throw registry.stopped
      ? new InstallError(
          `The registry generator stopped while registering ${slug}, after its check had ` +
            `passed, so it was not installed. Registering loads the extension's code for the ` +
            `first time, so the output below may be about that code or about this checkout.`,
          "generator-failed",
          registry.output,
        )
      : new InstallError(
          `${slug} passed this instance's registry check, but the registry generator left it ` +
            `out once it loaded the extension's code, so it was not installed.`,
          "rejected-by-registry",
          registry.output,
        );
  }

  return {
    kind,
    slug,
    name: manifest.name,
    version: manifest.version,
    gitTag: manifest.gitTag ?? null,
    commitSha: manifest.commitSha,
    contentHash,
    installPath: rel,
    fileCount: entries.length,
    byteCount: entries.reduce((n, e) => n + e.data.length, 0),
    registry,
    nextStep: registry.ran
      ? process.env.NODE_ENV === "development"
        ? `Registered to ${rel}. The dev server picks it up on its next compile — reload the page it appears on.`
        : `Registered to ${rel} and validated. Commit ${rel} and redeploy: the registries are generated at build time, so this instance serves it after the next build.`
      : `Written to ${rel}, but the registry generator could not be run here. ` +
        `Run \`npm run registry\` in the checkout and restart the server before it is usable.`,
  };
}
