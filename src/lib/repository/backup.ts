/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Backups: where an extension's folder waits while an operation takes it out of
 * the build, and the record that says which operation that is.
 *
 *   .mixos/backup/<kind dir>/<name>/       the folder, moved out of apps/,
 *                                          connectors/ or themes/
 *   .mixos/backup/<kind dir>/<name>.json   its record: the operation, the
 *                                          checkout lock's token while it ran,
 *                                          the process and the host
 *
 * Two operations make one:
 *
 *   - Removing an extension's code (./remove.ts) renames its folder here, runs
 *     the registry generator, then deletes the backup if the build is fine
 *     without it, or renames it back if it isn't.
 *   - Updating one (an app or a connector at Register, ./register.ts; a theme
 *     as it installs, ./install.ts) renames the folder in place here, renames
 *     the new release into its place, and runs the generator. If the generator
 *     accepts the new release, the backup is deleted; if not, the new release
 *     goes back where it came from and the backup back into place (swapIn(),
 *     swapBack() and swapDone() below).
 *
 * A rename on one filesystem is atomic, so a folder is always whole, in one
 * place or the other. Nothing that builds or runs the checkout reads `.mixos/`
 * (./pending.ts says why), so a folder here is out of the build.
 *
 * ── THE RECORD ──────────────────────────────────────────────────────────────
 *
 * Written before the folder moves and deleted only once the backup is gone, so
 * a backup always has one. An update's record also names the release the backup
 * holds and the one put in its place. Once the generator has accepted the
 * checkout without the folder, or with the new release, the record says so
 * (`accepted`): from then on the backup is only being deleted.
 *
 * ── ONE THAT STOPPED MIDWAY ─────────────────────────────────────────────────
 *
 * Its record stays, and removal, Register and install refuse that name until
 * recovery (`npm run register -- --recover`, the same as `npm run remove --
 * --recover`) has dealt with it (recoverCheckout() in ./register.ts). For a
 * removal it puts back a folder the generator never accepted the checkout
 * without, and finishes deleting one it did. For an update the generator never
 * accepted, it offers to restore the backup or to keep the new release. It
 * acts only under the checkout lock, and only on a record whose token isn't
 * the lock's, so the process that wrote it no longer holds the lock: it has
 * stopped, or its lock was broken, and it stops at its next check of the lock.
 *
 * Every path here is a runtime path in a checkout, so each join is marked for
 * Turbopack's tracer to leave alone (see ./pending.ts).
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { InstallRecordSchema } from "./install-record";
import { MIXOS_DIR, kindDir, pathExists } from "./pending";
import { CONTENT_HASH_PATTERN, ExtensionKindSchema, type ExtensionKind } from "./types";

/**
 * The name of a folder in apps/, connectors/ or themes/ that removal can act
 * on: one path segment of lowercase letters, digits, hyphens and underscores,
 * starting with a letter or a digit. It holds every app slug and theme slug the
 * registry generator accepts, and every Registry slug, and leaves out
 * `_template` and its kin, dot folders, and anything that could name another
 * place on disk.
 */
export const EXTENSION_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,99}$/;

export function isExtensionName(name: string): boolean {
  return EXTENSION_NAME_PATTERN.test(name);
}

function assertName(name: string): void {
  if (!isExtensionName(name)) {
    throw new Error(`"${name.replace(/[^\x20-\x7e]/g, "?")}" is not the name of an extension folder.`);
  }
}

/** `child` is one level under `parent`, and nowhere else. */
function assertDirectlyUnder(parent: string, child: string): void {
  if (path.dirname(child) !== parent || !child.startsWith(parent + path.sep)) {
    throw new Error(`${child} is not a folder directly under ${parent}.`);
  }
}

/** Where an extension lives in the checkout: `apps/<name>` and the like. */
export function extensionFolder(root: string, kind: ExtensionKind, name: string): { dir: string; rel: string } {
  assertName(name);
  const parent = path.join(/* turbopackIgnore: true */ root, kindDir(kind));
  const dir = path.join(/* turbopackIgnore: true */ parent, name);
  assertDirectlyUnder(parent, dir);
  return { dir, rel: `${kindDir(kind)}/${name}` };
}

/** Where one backup lives. */
export interface BackupLocation {
  /** Absolute: `<root>/.mixos/backup/<kind dir>/<name>`. */
  folder: string;
  /** Absolute: `<root>/.mixos/backup/<kind dir>/<name>.json`. */
  record: string;
  /** Repo-relative, for messages: `.mixos/backup/apps/<name>`. */
  rel: string;
}

export function backupLocation(root: string, kind: ExtensionKind, name: string): BackupLocation {
  assertName(name);
  const parent = path.join(/* turbopackIgnore: true */ root, MIXOS_DIR, "backup", kindDir(kind));
  const folder = path.join(/* turbopackIgnore: true */ parent, name);
  assertDirectlyUnder(parent, folder);
  return { folder, record: `${folder}.json`, rel: `${MIXOS_DIR}/backup/${kindDir(kind)}/${name}` };
}

/** What an earlier operation left of `kind`/`name` in `.mixos/backup/`, or null when it left nothing. */
export function leftoverBackup(root: string, kind: ExtensionKind, name: string): BackupLocation | null {
  const where = backupLocation(root, kind, name);
  return pathExists(where.folder) || pathExists(where.record) ? where : null;
}

/* -------------------------------------------------------------------------- */
/*  The record                                                                 */
/* -------------------------------------------------------------------------- */

const InstantSchema = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "expected a date and time");

/** What every record holds: which extension, and the process that made it. */
const RECORD = {
  kind: ExtensionKindSchema,
  slug: z.string().regex(EXTENSION_NAME_PATTERN),
  /** The checkout lock's token while it ran. */
  token: z.string().min(16),
  pid: z.number().int().positive(),
  hostname: z.string().min(1),
  startedAt: InstantSchema,
  /**
   * Set once the generator accepted the checkout without the folder, or with
   * the release that replaces it: the backup is only being deleted.
   */
  accepted: z.literal(true).optional(),
};

/** A removal's record (./remove.ts). */
export const RemovalRecordSchema = z.strictObject({ operation: z.literal("remove"), ...RECORD });
export type RemovalRecord = z.infer<typeof RemovalRecordSchema>;

/**
 * An update's record: also the release the backup holds, from its install
 * record, with the folder's files hash as the update found it (null when it
 * held something no files hash covers), and the release put in its place.
 */
export const UpdateRecordSchema = z.strictObject({
  operation: z.literal("update"),
  ...RECORD,
  from: z.strictObject({
    version: InstallRecordSchema.shape.version,
    gitTag: InstallRecordSchema.shape.gitTag,
    commitSha: InstallRecordSchema.shape.commitSha,
    folderHash: z.string().regex(CONTENT_HASH_PATTERN).nullable(),
  }),
  to: z.strictObject({
    version: InstallRecordSchema.shape.version,
    gitTag: InstallRecordSchema.shape.gitTag,
    commitSha: InstallRecordSchema.shape.commitSha,
    filesHash: InstallRecordSchema.shape.filesHash,
  }),
});
export type UpdateRecord = z.infer<typeof UpdateRecordSchema>;

export const BackupRecordSchema = z.discriminatedUnion("operation", [RemovalRecordSchema, UpdateRecordSchema]);
export type BackupRecord = z.infer<typeof BackupRecordSchema>;

export type BackupRecordRead =
  | { state: "missing" }
  | { state: "unreadable"; reason: string }
  | { state: "ok"; record: BackupRecord };

/** The largest record this reads; one a removal or an update wrote is well under a kilobyte. */
const MAX_RECORD_BYTES = 64 * 1024;

export function readBackupRecord(file: string): BackupRecordRead {
  let text: string;
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) return { state: "unreadable", reason: "it is not a regular file" };
      if (stat.size > MAX_RECORD_BYTES) return { state: "unreadable", reason: "it is too large to be one MixOS wrote" };
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
  const parsed = BackupRecordSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      state: "unreadable",
      reason: `${issue?.path.join(".") || "it"}: ${issue?.message ?? "not a backup's record"}`,
    };
  }
  return { state: "ok", record: parsed.data };
}

/** Write a record whole or not at all: to a dot-prefixed file beside it, then renamed over it. */
export function writeBackupRecord(file: string, record: BackupRecord): void {
  const value = BackupRecordSchema.parse(record);
  fs.mkdirSync(path.dirname(file), { recursive: true });
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
/*  One left behind                                                            */
/* -------------------------------------------------------------------------- */

/**
 * What install, Register and removal say when an earlier operation left `where`
 * for `slug`, which they refuse to act over: what stopped, and the command that
 * deals with it. `here` adds "in this checkout", for a page that may be read
 * elsewhere.
 */
export function leftoverBackupMessage(where: BackupLocation, slug: string, { here = false }: { here?: boolean } = {}): string {
  const read = readBackupRecord(where.record);
  const inThisCheckout = here ? " in this checkout" : "";
  if (read.state === "ok" && read.record.operation === "update") {
    const { from, to } = read.record;
    return (
      `An update of ${slug} from ${from.version} to ${to.version} stopped before it finished, and left ` +
      `${where.rel}. Run \`npm run register -- --recover\`${inThisCheckout} to restore ${from.version} or keep ` +
      `${to.version}, then try again.`
    );
  }
  return (
    `A removal of ${slug} stopped before it finished, and left ${where.rel}. Run ` +
    `\`npm run remove -- --recover\`${inThisCheckout} to put things back, then try again.`
  );
}

/* -------------------------------------------------------------------------- */
/*  An update's swap                                                           */
/* -------------------------------------------------------------------------- */

/** A folder in the checkout: absolute, and repo-relative for messages. */
export interface CheckoutFolder {
  dir: string;
  rel: string;
}

/**
 * One update's swap: the folder in place, `live`, out to `backup`, and the new
 * release from `incoming` into its place. `incoming` is the pending folder for
 * an app or a connector (Register), and the staged copy for a theme (install).
 */
export interface UpdateSwap {
  live: CheckoutFolder;
  backup: BackupLocation;
  incoming: CheckoutFolder;
  record: UpdateRecord;
}

/**
 * The check before each change to the disk: both locks still held, and the
 * operation not stopped. When it may not go on, it throws the caller's own
 * error, ending with `left`, what is on disk at that point, and changes
 * nothing.
 */
export type Fence = (left: string) => Promise<void>;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Put an update's new release in place, under the caller's locks, fenced before
 * each change: the record, then the folder in place renamed to its backup, then
 * the new release renamed into its place. A rename that fails puts back what
 * this moved, deletes the record, and throws `failed(message)`. A fence that
 * fails leaves everything as it is, for recovery.
 */
export async function swapIn(swap: UpdateSwap, fence: Fence, failed: (message: string) => Error): Promise<void> {
  const { live, backup, incoming, record } = swap;
  const { from, to } = record;
  const recover = "Run `npm run register -- --recover` to put things back.";
  await fence(`Nothing was moved: ${live.rel} still holds ${from.version}, and ${to.version} waits in ${incoming.rel}/.`);
  writeBackupRecord(backup.record, record);

  await fence(`Nothing was moved, but the update's record, ${backup.rel}.json, was left. ${recover}`);
  try {
    fs.mkdirSync(path.dirname(backup.folder), { recursive: true });
    fs.renameSync(live.dir, backup.folder);
  } catch (err) {
    fs.rmSync(backup.record, { force: true });
    throw failed(`Could not move ${live.rel} to ${backup.rel}/: ${errorText(err)}. Nothing was changed.`);
  }

  await fence(
    `${live.rel} (${from.version}) was moved to ${backup.rel}/, and ${to.version} is still in ${incoming.rel}/. ${recover}`,
  );
  try {
    fs.renameSync(incoming.dir, live.dir);
  } catch (err) {
    fs.renameSync(backup.folder, live.dir);
    fs.rmSync(backup.record, { force: true });
    throw failed(`Could not move ${to.version} into ${live.rel}: ${errorText(err)}. ${from.version} was put back.`);
  }
}

/**
 * Undo a swap the generator didn't accept, once the caller has fenced: the new
 * release goes back to `incoming`, or is deleted when `keepIncoming` is false
 * (a theme's staged copy, which nothing waits on), the backup goes back into
 * place, and its record is deleted. Also what recovery's "restore" does, so
 * the new release may already be out of place.
 */
export function swapBack(swap: UpdateSwap, { keepIncoming }: { keepIncoming: boolean }): void {
  const { live, backup, incoming } = swap;
  if (pathExists(live.dir)) {
    if (keepIncoming) {
      fs.mkdirSync(path.dirname(incoming.dir), { recursive: true });
      fs.renameSync(live.dir, incoming.dir);
    } else {
      fs.rmSync(live.dir, { recursive: true, force: true });
    }
  }
  fs.renameSync(backup.folder, live.dir);
  fs.rmSync(backup.record, { force: true });
}

/**
 * Finish a swap the generator accepted, once the caller has fenced: the record
 * says so first, so a stop from here on leaves only deleting to do; then
 * `settle`, the caller's own tidying (Register deletes the pending sidecar);
 * then the backup, then its record.
 */
export function swapDone(swap: UpdateSwap, settle?: () => void): void {
  writeBackupRecord(swap.backup.record, { ...swap.record, accepted: true });
  settle?.();
  fs.rmSync(swap.backup.folder, { recursive: true, force: true });
  fs.rmSync(swap.backup.record, { force: true });
}
