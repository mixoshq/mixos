/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pending installs: an app or connector from the Registry that install has
 * verified, checked and accepted, waiting outside the build until someone
 * registers it.
 *
 *   .mixos/staging/<kind dir>/<slug>/       the tree while install checks it
 *   .mixos/pending/<kind dir>/<slug>/       the tree as installed, waiting
 *   .mixos/pending/<kind dir>/<slug>.json   its sidecar: what install verified,
 *                                           for whom, and when
 *
 * `<kind dir>` is `apps`, `connectors` or, while staging only, `themes`: a theme
 * has no code to run, so it registers when it is installed.
 *
 * Nothing that builds or runs the checkout reads `.mixos/`. The registry
 * generator scans `apps/`, `connectors/` and `themes/`; the release step
 * migrates only the apps the registry accepted; `tsc`'s globs skip dot-folders;
 * ESLint, Docker and git are told to ignore it. So a pending app's code can't
 * run until Register (./register.ts) moves it into `apps/`.
 *
 * ── THE SIDECAR ─────────────────────────────────────────────────────────────
 *
 * Never committed: it is about this checkout's install. It records what install
 * verified (the release, its commit, its content hash and `filesHash`), the
 * floor the release declared, the check's verdict, who installed it and when.
 * While a registration is under way it also records that registration's holder,
 * so one that died midway can be told from one still running.
 *
 * ── filesHash ───────────────────────────────────────────────────────────────
 *
 * The content hash records each file's execute bit, as a git tree does, but
 * install writes every file 0644, so a folder on disk can't reproduce it. So the
 * sidecar records `filesHash` as well (filesHash() in ./content-hash.ts), and
 * Register recomputes it from the pending folder and refuses a folder that no
 * longer matches: what runs is what install verified and checked. It is a check
 * against change after install, by an editor, a tool or another process in the
 * checkout. Anyone who can write the folder can write the sidecar too.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { filesHash } from "./content-hash";
import type { TarEntry } from "./tar";
import {
  CONTENT_HASH_PATTERN,
  CommitShaSchema,
  SlugSchema,
  type ExtensionKind,
} from "./types";

/** The kinds that wait in pending. A theme registers when it is installed. */
export type PendingKind = "app" | "connector";

export function isPendingKind(kind: string): kind is PendingKind {
  return kind === "app" || kind === "connector";
}

/**
 * The folder each kind lives in, under the checkout and under `.mixos/`.
 *
 * Stated here rather than taken from KIND_SEGMENT in ./types, which is
 * mixos.org's URL vocabulary: a change there must not move a write on this
 * filesystem.
 */
export function kindDir(kind: ExtensionKind): "apps" | "connectors" | "themes" {
  switch (kind) {
    case "app":
      return "apps";
    case "connector":
      return "connectors";
    case "theme":
      return "themes";
  }
}

/** Where everything about this checkout's installs is kept. */
export const MIXOS_DIR = ".mixos";

/** A slug as the Registry validates one, which every path here is built from. */
function assertSlug(slug: string): void {
  if (!SlugSchema.safeParse(slug).success) {
    throw new PendingError(`"${slug.replace(/[^\x20-\x7e]/g, "?")}" is not an extension slug.`);
  }
}

/** `child` is one level under `parent`, and nowhere else. */
function assertDirectlyUnder(parent: string, child: string): void {
  if (path.dirname(child) !== parent || !child.startsWith(parent + path.sep)) {
    throw new PendingError(`${child} is not a folder directly under ${parent}.`);
  }
}

export class PendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PendingError";
  }
}

/*
  Every path below is in a checkout at runtime, under `.mixos/` or an extension's
  folder, and none is a file a build should carry. Joined from an argument and a
  kind's folder name, Turbopack's tracer can't tell, and guesses at matching
  folders across the whole project, pulling them into the build of every page
  that imports this module. So each join is marked for it to leave alone.
*/

/** Where one pending install lives. */
export interface PendingLocation {
  /** Absolute: `<root>/.mixos/pending/<kind dir>/<slug>`. */
  folder: string;
  /** Absolute: `<root>/.mixos/pending/<kind dir>/<slug>.json`. */
  sidecar: string;
  /** Repo-relative, for messages: `.mixos/pending/apps/<slug>`. */
  rel: string;
}

export function pendingLocation(root: string, kind: PendingKind, slug: string): PendingLocation {
  assertSlug(slug);
  const parent = path.join(/* turbopackIgnore: true */ root, MIXOS_DIR, "pending", kindDir(kind));
  const folder = path.join(/* turbopackIgnore: true */ parent, slug);
  assertDirectlyUnder(parent, folder);
  return {
    folder,
    sidecar: `${folder}.json`,
    rel: `${MIXOS_DIR}/pending/${kindDir(kind)}/${slug}`,
  };
}

/** Where install writes a tree while its check reads it. */
export function stagingLocation(root: string, kind: ExtensionKind, slug: string): { dir: string; rel: string } {
  assertSlug(slug);
  const parent = path.join(/* turbopackIgnore: true */ root, MIXOS_DIR, "staging", kindDir(kind));
  const dir = path.join(/* turbopackIgnore: true */ parent, slug);
  assertDirectlyUnder(parent, dir);
  return { dir, rel: `${MIXOS_DIR}/staging/${kindDir(kind)}/${slug}` };
}

/** Where an extension lives once it is registered: `apps/<slug>` and the like. */
export function liveLocation(root: string, kind: ExtensionKind, slug: string): { dir: string; rel: string } {
  assertSlug(slug);
  const parent = path.join(/* turbopackIgnore: true */ root, kindDir(kind));
  const dir = path.join(/* turbopackIgnore: true */ parent, slug);
  assertDirectlyUnder(parent, dir);
  return { dir, rel: `${kindDir(kind)}/${slug}` };
}

/* -------------------------------------------------------------------------- */
/*  The sidecar                                                                */
/* -------------------------------------------------------------------------- */

const HashSchema = z.string().regex(CONTENT_HASH_PATTERN, "expected a sha256- hash");
const InstantSchema = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "expected a date and time");

/** The registration under way, recorded before anything moves. */
export const RegisteringSchema = z.strictObject({
  /** The checkout lock's token while it ran. */
  token: z.string().min(16),
  pid: z.number().int().positive(),
  hostname: z.string().min(1),
  startedAt: InstantSchema,
});
export type Registering = z.infer<typeof RegisteringSchema>;

export const PendingSidecarSchema = z.strictObject({
  kind: z.enum(["app", "connector"]),
  slug: SlugSchema,
  /** The catalogue it came from: repositoryBaseUrl() at install, an origin. */
  source: z.string().min(1),
  version: z.string().min(1),
  gitTag: z.string().nullable(),
  commitSha: CommitShaSchema,
  /** The content hash, as published and verified. */
  contentHash: HashSchema,
  /** The same entries with every mode read as 644, which Register recomputes from the folder. */
  filesHash: HashSchema,
  /** The release's declared floor, which Register checks again. */
  requiresMixOS: z.string().nullable(),
  yankedAccepted: z.boolean(),
  installedAt: InstantSchema,
  /** Who installed it, as the audit row names them. */
  installedBy: z.string().min(1),
  fileCount: z.number().int().nonnegative(),
  byteCount: z.number().int().nonnegative(),
  /** The install check's verdict, and what it left to registration. */
  check: z.strictObject({
    verdict: z.literal("accepted"),
    deferred: z.array(z.string()),
  }),
  /** Present only while a registration is under way, or after one died midway. */
  register: RegisteringSchema.optional(),
});
export type PendingSidecar = z.infer<typeof PendingSidecarSchema>;

export type SidecarRead =
  | { state: "missing" }
  | { state: "unreadable"; reason: string }
  | { state: "ok"; sidecar: PendingSidecar };

/** The largest sidecar this reads. A deferred list at its limit fits well inside it. */
const MAX_SIDECAR_BYTES = 4 * 1024 * 1024;

export function readSidecar(file: string): SidecarRead {
  let text: string;
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) return { state: "unreadable", reason: "it is not a regular file" };
      if (stat.size > MAX_SIDECAR_BYTES) return { state: "unreadable", reason: "it is too large to be one install wrote" };
      text = fs.readFileSync(fd, "utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { state: "missing" };
    return { state: "unreadable", reason: code === "ELOOP" ? "it is a link" : String(code ?? err) };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { state: "unreadable", reason: "it is not JSON" };
  }
  const parsed = PendingSidecarSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      state: "unreadable",
      reason: `${issue?.path.join(".") || "it"}: ${issue?.message ?? "not a pending install's record"}`,
    };
  }
  return { state: "ok", sidecar: parsed.data };
}

/**
 * Write a sidecar whole or not at all: to a dot-prefixed file beside it, then
 * renamed over it.
 */
export function writeSidecar(file: string, sidecar: PendingSidecar): void {
  const value = PendingSidecarSchema.parse(sidecar);
  const tmp = path.join(/* turbopackIgnore: true */ path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/*  filesHash, from a folder                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The files hash of the tree under `dir`: every file, at any depth, dot files
 * and `node_modules/` included, since install wrote all of them and any of them
 * could run. Empty folders count for nothing, as they do in the content hash.
 *
 * Throws PendingError for a link or anything else that is not a file or a
 * folder: install writes neither, so the folder has changed.
 */
export function folderFilesHash(dir: string): string {
  const entries: TarEntry[] = [];
  collect(dir, "", entries);
  return filesHash(entries);
}

function collect(dir: string, relative: string, into: TarEntry[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // POSIX separators, as the archive's paths have.
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    const full = path.join(/* turbopackIgnore: true */ dir, entry.name);
    if (entry.isDirectory()) {
      collect(full, rel, into);
    } else if (entry.isFile()) {
      into.push({ path: rel, mode: 0o644, data: readRegularFile(full, rel) });
    } else {
      throw new PendingError(
        `${rel} is ${entry.isSymbolicLink() ? "a symbolic link" : "not a regular file"}, which install never writes.`,
      );
    }
  }
}

/** A file's bytes, never through a link put in its place since it was listed. */
function readRegularFile(full: string, rel: string): Buffer {
  let fd: number;
  try {
    fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    throw new PendingError(`${rel} could not be read: ${(err as NodeJS.ErrnoException).code ?? err}`);
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw new PendingError(`${rel} is not a regular file.`);
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/* -------------------------------------------------------------------------- */
/*  What is pending                                                            */
/* -------------------------------------------------------------------------- */

export interface PendingInstall {
  kind: PendingKind;
  slug: string;
  /** Repo-relative path of its folder. */
  path: string;
  hasFolder: boolean;
  /** Its sidecar, when there is one that reads as one. */
  sidecar: PendingSidecar | null;
  /** What stands in the way of registering it as it is, or null for nothing. */
  problem: string | null;
}

/**
 * Every pending install in the checkout at `root`, apps then connectors, each
 * by slug. Reads only: it takes no lock, so what it lists can change before
 * anything acts on it, and Register checks again under its locks.
 */
export function listPendingInstalls(root: string): PendingInstall[] {
  const out: PendingInstall[] = [];
  for (const kind of ["app", "connector"] as const) {
    const parent = path.join(/* turbopackIgnore: true */ root, MIXOS_DIR, "pending", kindDir(kind));
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(parent, { withFileTypes: true });
    } catch {
      continue;
    }
    const slugs = new Set<string>();
    for (const entry of names) {
      const slug = entry.name.endsWith(".json") ? entry.name.slice(0, -".json".length) : entry.name;
      if (SlugSchema.safeParse(slug).success) slugs.add(slug);
    }
    for (const slug of [...slugs].sort()) {
      const where = pendingLocation(root, kind, slug);
      const hasFolder = isRealDirectory(where.folder);
      const read = readSidecar(where.sidecar);
      out.push({
        kind,
        slug,
        path: where.rel,
        hasFolder,
        sidecar: read.state === "ok" ? read.sidecar : null,
        problem: pendingProblem(where, hasFolder, read),
      });
    }
  }
  return out;
}

function pendingProblem(where: PendingLocation, hasFolder: boolean, read: SidecarRead): string | null {
  if (read.state === "ok" && read.sidecar.register) {
    return "A registration of it stopped before it finished. Run `npm run register -- --recover`.";
  }
  if (!hasFolder) {
    return `${where.rel}/ is missing, so there is nothing to register. Run \`npm run register -- --recover\`.`;
  }
  if (read.state === "missing") {
    return `It has no record of what install verified (${where.rel}.json), so it can't be registered. Discard it.`;
  }
  if (read.state === "unreadable") {
    return `Its record of what install verified (${where.rel}.json) can't be read: ${read.reason}. Discard it.`;
  }
  return null;
}

/** A directory at `p` itself, not a link to one. */
export function isRealDirectory(p: string): boolean {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Anything at `p`, a dangling link included. */
export function pathExists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
