/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pending installs: an app or connector from the Registry that install has
 * verified, checked and accepted, waiting outside the build until someone
 * registers it.
 *
 *   .mixos/staging/<kind dir>/<slug>/       the tree while install checks it
 *   .mixos/pending/<kind dir>/<slug>/       the tree as installed, waiting, with
 *                                           its install record, .registry.json
 *   .mixos/pending/<kind dir>/<slug>.json   its sidecar: who installed it, when,
 *                                           and the check's verdict
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
 * ── ONE RECORD, AND A SIDECAR ───────────────────────────────────────────────
 *
 * What install verified is in the tree itself, in `.registry.json`
 * (./install-record.ts): the release, its commit, its content hash and its
 * files hash, where it came from and the floor it declares. It moves with the
 * folder at Register and is committed with it. Register recomputes the files
 * hash from the folder and refuses one that no longer matches.
 *
 * The sidecar holds only what is about this checkout's pending install, and is
 * never committed: who installed it and when, whether they accepted a release
 * its publisher withdrew, the check's verdict, and what install left out of the
 * package (./left-out.ts). While a registration is under way it also records
 * that registration's holder, so one that died midway can be told from one
 * still running.
 *
 * ── A PENDING UPDATE ────────────────────────────────────────────────────────
 *
 * An update of an extension already in `apps/` or `connectors/` waits here too
 * (./update.ts). Its sidecar also records what it replaces: the installed
 * release, from that folder's install record, and the folder as the update
 * found it. Register refuses a pending update for now, with
 * pendingUpdateProblem(); Discard deletes one as it deletes any.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  INSTALL_RECORD_FILE,
  InstallRecordSchema,
  readInstallRecord,
  recordMismatch,
  type InstallRecord,
  type RecordRead,
} from "./install-record";
import { LeftOutSchema } from "./left-out";
import { CONTENT_HASH_PATTERN, SlugSchema, type ExtensionKind } from "./types";

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

/**
 * Which way an update goes from the installed release (updateDirection() in
 * ./update.ts): `unknown` when neither the versions nor the dates say.
 */
export const UPDATE_DIRECTIONS = ["newer", "older", "same", "unknown"] as const;
export type UpdateDirection = (typeof UPDATE_DIRECTIONS)[number];

/**
 * What a pending update replaces: the installed release, from the install
 * record in its folder, and that folder as the update found it. What Register
 * will check the folder against before it puts the update in place.
 */
export const ReplacesSchema = z.strictObject({
  version: InstallRecordSchema.shape.version,
  gitTag: InstallRecordSchema.shape.gitTag,
  commitSha: InstallRecordSchema.shape.commitSha,
  /** The record's files hash: the folder as install wrote it. */
  filesHash: InstallRecordSchema.shape.filesHash,
  /**
   * The folder's own files hash when the update was made: the record's when it
   * matched, another when it had been edited, and null when it held something
   * no files hash covers, such as a link.
   */
  folderHash: z.string().regex(CONTENT_HASH_PATTERN).nullable(),
  /** Whether the admin chose to discard the folder's local changes. True whenever folderHash isn't filesHash. */
  localChangesDiscarded: z.boolean(),
  direction: z.enum(UPDATE_DIRECTIONS),
});
export type Replaces = z.infer<typeof ReplacesSchema>;

export const PendingSidecarSchema = z.strictObject({
  kind: z.enum(["app", "connector"]),
  slug: SlugSchema,
  /** Whether the admin chose to install a release its publisher had withdrawn. */
  yankedAccepted: z.boolean(),
  installedAt: InstantSchema,
  /** Who installed it, as the audit row names them. */
  installedBy: z.string().min(1),
  /** The install check's verdict, and what it left to registration. */
  check: z.strictObject({
    verdict: z.literal("accepted"),
    deferred: z.array(z.string()),
  }),
  /** What install left out of the package, by name. Absent when it left out nothing. */
  leftOut: LeftOutSchema.optional(),
  /** Present only for an update: what it replaces in `apps/` or `connectors/`. */
  replaces: ReplacesSchema.optional(),
  /** Present only while a registration is under way, or after one died midway. */
  register: RegisteringSchema.optional(),
});
export type PendingSidecar = z.infer<typeof PendingSidecarSchema>;

export type SidecarRead =
  | { state: "missing" }
  /**
   * `earlier` marks a sidecar an earlier version of MixOS wrote, which held
   * what install verified before that moved into the tree's own record. Its
   * folder has no record, so it can't be registered: discard it and install it
   * again.
   */
  | { state: "unreadable"; reason: string; earlier?: true }
  | { state: "ok"; sidecar: PendingSidecar };

/** Why an earlier version's sidecar can't be used, for a person. */
const EARLIER_SIDECAR =
  "it was written by an earlier version of MixOS, before installs kept their record in the extension's folder";

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
  // What an install before .registry.json wrote: the release's facts, here.
  if (value && typeof value === "object" && "filesHash" in value && "contentHash" in value) {
    return { state: "unreadable", reason: EARLIER_SIDECAR, earlier: true };
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
  /** Its install record, `.registry.json` in its folder, when it is there and is its own. */
  record: InstallRecord | null;
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
      const record: RecordRead = hasFolder ? readInstallRecord(where.folder) : { state: "missing" };
      const own = record.state === "ok" && recordMismatch(record.record, kind, slug) === null;
      const replaces = read.state === "ok" ? read.sidecar.replaces : undefined;
      out.push({
        kind,
        slug,
        path: where.rel,
        hasFolder,
        sidecar: read.state === "ok" ? read.sidecar : null,
        record: own && record.state === "ok" ? record.record : null,
        problem:
          pendingProblem(where, hasFolder, read) ??
          withRemedy(recordProblem(where, kind, slug, record)) ??
          (replaces
            ? pendingUpdateProblem(kind, slug, replaces, record.state === "ok" ? record.record.version : null)
            : null),
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
    return `It has no record of its install (${where.rel}.json), so it can't be registered. Discard it.`;
  }
  if (read.state === "unreadable") {
    return read.earlier
      ? "An earlier version of MixOS installed it, before installs kept their record in the extension's " +
          "folder, so it can't be registered. Discard it and install it again."
      : `Its record of its install (${where.rel}.json) can't be read: ${read.reason}. Discard it.`;
  }
  return null;
}

/**
 * What is wrong with a pending install's own record, `.registry.json` in its
 * folder, or null. Register refuses each, so the list and the review say so.
 */
export function recordProblem(
  where: PendingLocation,
  kind: PendingKind,
  slug: string,
  read: RecordRead,
): string | null {
  const file = `${where.rel}/${INSTALL_RECORD_FILE}`;
  if (read.state === "missing") {
    return `It has no install record (${file}), so what install verified can't be checked.`;
  }
  if (read.state === "invalid") {
    return `Its install record (${file}) can't be read: ${read.reason}.`;
  }
  const mismatch = recordMismatch(read.record, kind, slug);
  return mismatch ? `Its install record (${file}) isn't its own: ${mismatch}.` : null;
}

/** A problem with what to do about it, or null. */
function withRemedy(problem: string | null): string | null {
  return problem ? `${problem} Discard it and install it again.` : null;
}

/**
 * What the pending list, the review and Register say of a pending update:
 * Register can't put one in place yet, and what to do with it instead. `to` is
 * the version waiting, when its record can be read. `subject` names it, "It"
 * where the reader is already looking at it.
 *
 * The one place a pending update is turned away. The swap that puts one in
 * place, with a backup of the folder it replaces, is the rest of the update
 * (docs/plans/20261008_2300-extension-lifecycle.md §1.7), and replaces this.
 */
export function pendingUpdateProblem(
  kind: PendingKind,
  slug: string,
  replaces: Replaces,
  to: string | null,
  subject = "It",
): string {
  return (
    `${subject} is an update of ${kindDir(kind)}/${slug} from ${replaces.version}${to ? ` to ${to}` : ""}, ` +
    "and this version of MixOS can't register updates yet. Discard it with " +
    `\`npm run register -- ${kind}/${slug} --discard\`.`
  );
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
