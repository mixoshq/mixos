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
 * 1.  Ask mixos.org how to install → commit, download URL, content hash.
 * 2.  Refuse a yanked release unless the admin has been shown why and insisted.
 * 3.  Download from GitHub, pinned to the commit, through the host allowlist.
 * 4.  Read the archive IN MEMORY. Reject symlinks, traversal, oversize trees.
 * 5.  **Verify the content hash.** Mismatch ends it here, with nothing written.
 * 6.  Pre-flight the manifest — it exists, it parses, it is for this slug.
 * 7.  Write to a staging directory beside the target, never to the target.
 * 8.  Rename staging into place. This is the first moment the tree is live.
 * 9.  Run the project registry generator — the authoritative validation.
 * 10. If the generator rejected it, remove the directory and regenerate again,
 *     so a failed registration leaves the instance exactly as it was.
 *
 * Steps 3–5 are ordered that way deliberately: nothing untrusted touches the
 * filesystem before the hash has been checked. An extract-then-verify pipeline
 * has a window where a tampered tree is on disk, and then depends on its
 * cleanup path being correct for that not to matter.
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
import { existsSync } from "fs";
import path from "path";
import { spawn } from "child_process";
import { fetchInstallManifest } from "./client";
import { fetchExtensionTree } from "./fetch-source";
import { verifyContentHash } from "./content-hash";
import { withPlatformLock } from "../platform/lock";
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
      | "write-failed",
    /** The generator's own output, when it is what refused. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = "InstallError";
  }
}

export interface RegistryOutcome {
  /** Whether the generator could be run at all in this environment. */
  ran: boolean;
  ok: boolean;
  /**
   * Set when the generator itself failed rather than judging the package.
   *
   * The distinction is the generator's own contract: a per-item problem is a
   * `Skipping <dir>/ — ...` warning and the run still exits 0, because one bad
   * app must not break everyone else's build. A NON-ZERO exit therefore never
   * means "your extension is invalid" — it means the generator could not
   * complete, which is a fact about this machine. Reporting the two as one
   * outcome is how a broken toolchain gets blamed on a publisher.
   */
  brokenToolchain: boolean;
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

/**
 * Is the code running from a build output rather than a source checkout?
 *
 * Two markers, both server-side facts rather than anything a request can
 * influence:
 *
 *   - `VERCEL` is set by the platform on every serverless deployment.
 *   - `server.js` sits at the root of a Next `output: "standalone"` tree and is
 *     generated by the build. A checkout does not have one, and the standalone
 *     server `process.chdir()`s to that root before listening — so finding it at
 *     `process.cwd()` is the same as being inside one.
 *
 * Checked synchronously at module load: it cannot change while the process
 * lives, and making it a per-call `stat` would put a filesystem hit in front of
 * every render of the browse page to answer a constant.
 */
const BUILT_DEPLOYMENT =
  Boolean(process.env.VERCEL) || existsSync(path.join(PROJECT_ROOT, "server.js"));

export function isBuiltDeployment(): boolean {
  return BUILT_DEPLOYMENT;
}

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
 * The cheap checks, run on the in-memory tree before anything is written.
 *
 * These do NOT replace the generator. They exist so the common failures — an
 * archive that is not an extension at all, a manifest for a different slug —
 * are reported without the instance's source tree being touched, and so the
 * message names the actual problem rather than being whatever the generator
 * says when it meets a directory it cannot read.
 */
function preflight(kind: ExtensionKind, slug: string, entries: TarEntry[]): void {
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
 * Write the verified tree to a staging directory, then rename it into place.
 *
 * Staging-then-rename rather than writing straight to the target: a partial
 * write into `apps/<slug>` is a half-extension that the generator will meet on
 * its next run — including the run that `next dev` triggers on its own. The
 * rename is the only step that makes the tree visible, and it is atomic on
 * every filesystem this runs on.
 *
 * The staging directory is dot-prefixed because the generator skips entries
 * beginning with `.`, so even a crash between write and rename leaves nothing
 * that a later build will try to read.
 */
async function writeTree(dir: string, entries: TarEntry[]): Promise<void> {
  const staging = path.join(path.dirname(dir), `.installing-${path.basename(dir)}`);
  await fs.rm(staging, { recursive: true, force: true });

  try {
    for (const entry of entries) {
      const target = path.resolve(staging, entry.path);
      // Third and last containment check, this one on the fully-joined path.
      if (!target.startsWith(staging + path.sep)) {
        throw new InstallError(
          `The package tried to write outside its own directory: ${entry.path}`,
          "invalid-package",
        );
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      // Never carry the archive's mode across wholesale. Source files are data
      // to this project — nothing here execs them — and an archive that can set
      // the mode of a file it places in the checkout can set the setuid bit.
      await fs.writeFile(target, entry.data, { mode: 0o644 });
    }
    await fs.rename(staging, dir);
  } catch (err) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    if (err instanceof InstallError) throw err;
    throw new InstallError(
      `Could not write to disk: ${err instanceof Error ? err.message : String(err)}`,
      "write-failed",
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  The registry generator — the authoritative validation                      */
/* -------------------------------------------------------------------------- */

/**
 * Run `scripts/generate-project-registry.ts` and decide whether it accepted the
 * new directory.
 *
 * WHY THE EXIT CODE IS NOT ENOUGH. The generator's per-item failure path is a
 * `Skipping <dir>/ — ...` warning, not an abort: an app with an invalid
 * manifest is left out of the registry and the run still succeeds, because one
 * bad app must not break everyone else's build. That is right for the build and
 * wrong as an answer to "did MY extension pass", so acceptance is decided by
 * three facts together — the run succeeded, it did not skip this directory, and
 * the identifier is actually present in the generated module.
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
  );

  if (run.code === null) {
    return { ran: false, ok: false, brokenToolchain: true, output: run.output };
  }
  if (run.code !== 0) {
    // See RegistryOutcome.brokenToolchain: a non-zero exit is the generator
    // failing, never its verdict on one extension.
    return { ran: true, ok: false, brokenToolchain: true, output: run.output };
  }

  const skipped = new RegExp(
    `Skipping\\s+(?:${INSTALL_SEGMENT[kind]}/)?${escapeRe(slug)}/`,
  ).test(run.output);
  if (skipped) {
    return { ran: true, ok: false, brokenToolchain: false, output: run.output };
  }

  const generated = await fs.readFile(registryFile(kind), "utf8").catch(() => "");
  const present = generated.includes(`"${REGISTRY_KEY[kind]}": ${JSON.stringify(slug)}`);
  return {
    ran: true,
    ok: present,
    brokenToolchain: false,
    output: present
      ? run.output
      : `${run.output}\n\nThe generator ran without error but ${slug} is not in ${REGISTRY_FILE_LABEL[kind]}.`,
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Generator runs are seconds; a minute is a hang, not a slow machine. */
const GENERATOR_TIMEOUT_MS = 120_000;

function spawnCapture(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
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
      child.kill("SIGKILL");
      output += `\nThe registry generator did not finish within ${GENERATOR_TIMEOUT_MS / 1000}s.`;
    }, GENERATOR_TIMEOUT_MS);

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
 */
export async function installExtension(
  kind: ExtensionKind,
  slug: string,
  options: InstallOptions = {},
): Promise<InstallResult> {
  // Before the lock: a kind this instance does not install should not hold up
  // anyone else's registration while it is refused.
  if (!installEnabled(kind)) {
    throw new InstallError(installDisabledMessage(kind), "disabled");
  }
  return withPlatformLock("repository.register", () =>
    runInstall(kind, slug, options),
  );
}

async function runInstall(
  kind: ExtensionKind,
  slug: string,
  options: InstallOptions,
): Promise<InstallResult> {
  await assertInstallable(kind);

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
    `requiresMixOS` has been parsed and shown to admins since this module was
    written, and enforced against nothing, because no part of a running instance
    knew what version of MixOS it was. `src/generated/build-info.ts` now carries
    the release this image was built from, so the floor the publisher declared
    can actually hold.

    Unlike `yanked`, this has no override. A withdrawn release is a risk an admin
    is in a position to weigh; a release that needs platform features this build
    does not have is not a judgement call, and the failure it produces lands on
    users rather than on the admin who accepted it.

    An untagged build cannot compare and says so rather than refusing — see the
    reasoning in `satisfiesMinimum`. That path is logged, because "declared but
    not enforced" silently is exactly the state this change exists to end.
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

  await writeTree(dir, entries);

  const registry = await regenerateRegistry(kind, slug);
  if (registry.ran && !registry.ok) {
    // Undo. Removing the directory is not enough on its own: the failed run may
    // already have rewritten src/generated, so the generator is run once more
    // to restore a registry that matches what is actually on disk.
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await regenerateRegistry(kind, slug).catch(() => {});

    // Two different failures, and saying the wrong one sends the admin to
    // argue with a publisher about their own machine.
    throw registry.brokenToolchain
      ? new InstallError(
          `This instance could not run its registry generator, so ${slug} could not be ` +
            `validated and was not installed. Nothing is wrong with the extension — ` +
            `run \`npm run registry\` in this checkout to see the same failure directly.`,
          "generator-failed",
          registry.output,
        )
      : new InstallError(
          `${slug} did not pass this instance's registry checks and was not installed.`,
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
