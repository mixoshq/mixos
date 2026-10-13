/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Register, Discard and recovery: what becomes of an app or connector waiting
 * in `.mixos/pending/` (./pending.ts). Each runs in a checkout, under both
 * locks, and is audited.
 *
 * Install leaves an accepted extension in pending, where nothing reads it.
 * Register moves it into `apps/` or `connectors/` and runs the registry
 * generator, which loads its code for the first time. Discard deletes it.
 * Recovery tidies up after one of them, or an install, that stopped midway.
 *
 * Two entry points call them: `npm run register` (scripts/register.ts), and
 * the Register and Discard buttons on Admin > Apps and Admin > Connectors
 * (./pending-actions.ts), which follow a review of what will run. Each
 * function takes the actor its audit row names and how it was asked for
 * (`via`: "cli" or "button").
 *
 * ── UNDER BOTH LOCKS ────────────────────────────────────────────────────────
 *
 * `repository.register`, the row lock that every instance on the database
 * shares (src/lib/platform/lock.ts), renewed every minute; and the checkout
 * lock, `.mixos/lock` (src/lib/platform/checkout-lock.ts), which the registry
 * generator takes too. Both are confirmed before each change to the disk
 * (bothLocks() in ./install.ts), and an operation that finds either gone stops
 * there without touching anything more. A generator run started here works
 * under the caller's checkout lock, by its token (`--lock-token`).
 *
 * ── REGISTER ────────────────────────────────────────────────────────────────
 *
 * 1. The pending folder exists, with its sidecar and its install record
 *    (`.registry.json`, ./install-record.ts), and nothing is where it would
 *    go. `filesHash` recomputed from the folder, the record left out, matches
 *    the record's: what runs has to be what install verified and checked.
 * 2. `requiresMixOS`, from the record, holds for this checkout's version.
 * 3. The sidecar records this registration (the checkout lock's token, the pid
 *    and the host), then the folder is renamed into place.
 * 4. The full generator, with `PATH` and `TMPDIR` as its environment. This is
 *    the first time any of the extension's code runs, as this checkout's OS
 *    user.
 * 5. Refused, stopped or out of time: renamed back to pending, the sidecar's
 *    registration cleared, and the generator run again so `src/generated/`
 *    matches the disk. Accepted: the sidecar is deleted. The install record
 *    stays in the folder, to be committed with it.
 * 6. Audited: `<kind>.register`, or `<kind>.register.rejected` with the reason.
 *
 * ── AN UPDATE ───────────────────────────────────────────────────────────────
 *
 * A pending update (./update.ts) replaces a folder already in place, so step 1
 * checks that folder instead: it is there, its install record is the release
 * the update replaces, and its files are as the update found them
 * (replacesProblem() in ./pending.ts). Then, at step 3, the swap
 * (swapIn() in ./backup.ts), fenced before each change: a backup record in
 * `.mixos/backup/<kind dir>/<slug>.json`, with this registration's token and
 * both releases; the folder in place renamed to its backup; the update renamed
 * into its place. At step 5, refused, stopped or out of time: the update goes
 * back to pending and the backup back into place, and the generator runs
 * again; a Ctrl-C doesn't stop that. Accepted: the record says so, then the
 * sidecar, the backup and the record are deleted. Activation, grants, settings
 * and connector configuration are the database's, by slug, and nothing here
 * touches them.
 *
 * The result hands back what to commit and how (./hand-back.ts): the folder's
 * files, a commit message built from the record, and the commands. For an
 * update: the files the commit changes, a message naming both releases, and
 * how to roll it back once it is deployed.
 *
 * ── A REGISTRATION THAT DIED MIDWAY ─────────────────────────────────────────
 *
 * Its record stays in the sidecar, and Register, Discard and install all refuse
 * the slug until `npm run register -- --recover` has dealt with it. Recovery
 * acts only under both locks, and only on a record whose holder is gone: it
 * refuses one whose process is still running on this machine, and warns about
 * one from another machine, which it can't check. It puts an extension that was
 * moved into place back into pending, since its registration never finished;
 * Register can then be run again. It asks first, and checks under the locks
 * that the checkout is still as it was shown.
 *
 * Recovery also deals with a removal or an update that died midway, from what
 * it left in `.mixos/backup/` (./backup.ts). For a removal (./remove.ts) it puts
 * back a folder the registry generator never accepted the checkout without, and
 * finishes deleting one it did. For an update whose new release was in place
 * but not yet accepted, it offers both ways: restore the backup, putting the
 * update back in pending, or keep the new release, which runs the generator as
 * Register would have and restores the backup if that refuses it. One the
 * generator accepted is finished. Each acts only on a record whose token isn't
 * the checkout lock's while its holder may still be running.
 * `npm run remove -- --recover` is the same recovery.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordAdminAction, type AdminActor } from "../apps/admin-audit";
import { BUILT_DEPLOYMENT_NOTICE, isBuiltDeployment } from "../platform/build";
import {
  CheckoutLockHeldError,
  describeCheckoutLockHolder,
  isStaleHolder,
  pidRunning,
  readCheckoutLock,
  withCheckoutLock,
  type CheckoutLock,
  type CheckoutLockHolder,
} from "../platform/checkout-lock";
import { LockUnavailableError, withPlatformLock, type PlatformLease } from "../platform/lock";
import { satisfiesMinimum } from "../platform/version";
import {
  backupLocation,
  extensionFolder,
  isExtensionName,
  leftoverBackup,
  leftoverBackupMessage,
  readBackupRecord,
  swapBack,
  swapDone,
  swapIn,
  type BackupLocation,
  type UpdateRecord,
  type UpdateSwap,
} from "./backup";
import { contentHashesMatch } from "./content-hash";
import { handBackFor, updateHandBackFor, type HandBack } from "./hand-back";
import {
  FolderReadError,
  INSTALL_RECORD_FILE,
  folderFiles,
  folderFilesHash,
  readInstallRecord,
  type InstallRecord,
} from "./install-record";
import type { LeftOut } from "./left-out";
import {
  bothLocks,
  checkoutRoot,
  describeLockFailure,
  regenerateRegistry,
  runRegistryGenerator,
  type RegistryOutcome,
} from "./install";
import {
  MIXOS_DIR,
  PendingError,
  isPendingKind,
  isRealDirectory,
  kindDir,
  liveLocation,
  pathExists,
  pendingLocation,
  readSidecar,
  recordProblem,
  replacesProblem,
  stagingLocation,
  writeSidecar,
  type PendingKind,
  type PendingSidecar,
  type Registering,
  type Replaces,
  type UpdateDirection,
} from "./pending";
import { installDisabledMessage, installEnabled } from "./policy";
import { SlugSchema, type ExtensionKind } from "./types";
import { compareMigrations, folderDifferences, folderMigrations, type FolderDifferences } from "./update";

/** How a pending install was acted on, and by whom. */
export interface PendingActionOptions {
  /** Who the audit row names. */
  actor: AdminActor;
  /** How it was asked for, recorded in the audit row. */
  via: "cli" | "button";
  /** Tests: the checkout. This one by default. */
  root?: string;
  /** Tests: a script in the registry generator's place. */
  generator?: string;
  /** Stops the work at its next check, and ends a generator run in progress. */
  signal?: AbortSignal;
  /** Told what a person should know that isn't a failure: a stale lock taken over. */
  notice?: (message: string) => void;
  /**
   * Register only: the files hash of the pending install the person reviewed
   * (the admin pages' review prompt). Checked under the locks against the
   * pending install's record, `.registry.json`, so what registers is what they
   * read, even if it was discarded and installed again in between.
   */
  reviewedFilesHash?: string;
}

export type RegisterFailureCode =
  | "disabled"
  | "unsupported-environment"
  | "not-pending"
  | "unregistrable"
  | "interrupted"
  | "already-registered"
  | "changed"
  | "incompatible"
  | "rejected-by-registry"
  | "generator-failed"
  | "write-failed"
  | "lock-lost"
  | "lock-unconfirmed"
  | "stopped"
  | "changed-meanwhile"
  /** An update's folder in place isn't what the update replaces any more. */
  | "folder-changed";

export class RegisterError extends Error {
  constructor(
    message: string,
    /** A stable code a caller can branch on without matching prose. */
    readonly code: RegisterFailureCode,
    /** The generator's output, or the hashes that disagreed. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = "RegisterError";
  }
}

/** Any failure here as a code and a message for a person, `locked` among them. */
export function describeRegisterFailure(err: unknown): { code: string; message: string; detail?: string } {
  if (err instanceof RegisterError) return { code: err.code, message: err.message, detail: err.detail };
  if (err instanceof LockUnavailableError) {
    return {
      code: "locked",
      message:
        "Another install, registration or removal holds the register lock (repository.register) in " +
        "the database, from this checkout or another instance using it. Try again when it " +
        "finishes. One that stopped without finishing releases it within 15 minutes.",
    };
  }
  if (err instanceof CheckoutLockHeldError) return { code: "locked", message: err.message };
  if (err instanceof PendingError) return { code: "not-pending", message: err.message };
  return { code: "unknown", message: err instanceof Error ? err.message : String(err) };
}

/**
 * The checks every disk change here starts with: not stopped, and both locks
 * still held. `finishing` skips the first, for the last step of a registration
 * the generator has accepted, which a Ctrl-C should not leave half done.
 */
function fencer(lease: PlatformLease, what: string, signal?: AbortSignal) {
  return async (left: string, detail?: string, { finishing = false } = {}): Promise<void> => {
    if (signal?.aborted && !finishing) {
      throw new RegisterError(`Stopped before it finished. ${left}`, "stopped", detail);
    }
    try {
      await lease.assertHeld();
    } catch (err) {
      const { code, message } = describeLockFailure(err, what);
      throw new RegisterError(`${message} ${left}`, code, detail);
    }
  };
}

/** Say so when taking the checkout lock meant taking over one whose holder had stopped. */
function tellTakeover(lock: CheckoutLock, options: PendingActionOptions): void {
  if (!lock.tookOver) return;
  (options.notice ?? console.warn)(
    `Took over the checkout lock from ${describeCheckoutLockHolder(lock.tookOver)}, which had stopped.`,
  );
}

function assertPendingTarget(kind: ExtensionKind, slug: string): asserts kind is PendingKind {
  if (!isPendingKind(kind)) {
    throw new RegisterError(
      `A ${kind} is registered when it is installed, so none waits in ${MIXOS_DIR}/pending/.`,
      "not-pending",
    );
  }
  if (!SlugSchema.safeParse(slug).success) {
    throw new RegisterError(`"${slug.replace(/[^\x20-\x7e]/g, "?")}" is not an extension slug.`, "not-pending");
  }
}

/** What a stopped registration's record says, for a person. */
function describeRegistering(r: Registering): string {
  const where = r.hostname === os.hostname() ? "this machine" : `another machine, ${r.hostname.replace(/[^\x20-\x7e]/g, "?")}`;
  return `pid ${r.pid} on ${where}, started ${new Date(r.startedAt).toLocaleString(undefined, { hour12: false })}`;
}

function interruptedEarlier(slug: string, r: Registering): RegisterError {
  return new RegisterError(
    `A registration of ${slug} (${describeRegistering(r)}) stopped before it finished. ` +
      "Run `npm run register -- --recover` to put things back, then try again.",
    "interrupted",
  );
}

/* -------------------------------------------------------------------------- */
/*  Register                                                                   */
/* -------------------------------------------------------------------------- */

export interface RegisterResult {
  kind: PendingKind;
  slug: string;
  /** Its install record, now in its folder, to be committed with it. */
  record: InstallRecord;
  source: string;
  version: string;
  gitTag: string | null;
  commitSha: string;
  contentHash: string;
  filesHash: string;
  /** Repo-relative: `apps/<slug>` or `connectors/<slug>`. */
  installPath: string;
  installedBy: string;
  installedAt: string;
  /** The files install wrote and their bytes, as found in the folder, without the install record. */
  fileCount: number;
  byteCount: number;
  /** What install left out of the package, from its sidecar: `{ ".gitignore": 1 }`, or `{}`. */
  leftOut: LeftOut;
  /** What install's check left to registration, which this run checked. */
  deferred: string[];
  registry: RegistryOutcome;
  /** What to commit, and how: it runs in this checkout now, and ships when it is committed. */
  handBack: HandBack;
  /** For an update: the release it replaced, and what the swap changed. Null for an install. */
  update: RegisteredUpdate | null;
  /** What to do next, in a paragraph. */
  nextStep: string;
}

/** What an update that Register put in place replaced, and what it changed. */
export interface RegisteredUpdate {
  from: { version: string; gitTag: string | null; commitSha: string };
  direction: UpdateDirection;
  localChangesDiscarded: boolean;
  /** An app's new `migrations/*.sql`, which `npm run migrate:apps` and the release step apply. */
  migrationsAdded: string[];
  /** The files the update changed in the folder, against the release it replaced. */
  changes: FolderDifferences;
}

/**
 * Register a pending app or connector, or put a pending update in place.
 * Throws RegisterError, or a lock's error, when it refuses; either way it is
 * audited.
 */
export async function registerPending(
  kind: ExtensionKind,
  slug: string,
  options: PendingActionOptions,
): Promise<RegisterResult> {
  const root = options.root ?? checkoutRoot();
  try {
    const result = await registerUnderLocks(kind, slug, root, options);
    await recordAdminAction(options.actor, {
      action: `${kind}.register`,
      targetType: kind,
      targetId: slug,
      details: {
        via: options.via,
        source: result.source,
        version: result.version,
        gitTag: result.gitTag,
        commitSha: result.commitSha,
        contentHash: result.contentHash,
        filesHash: result.filesHash,
        installPath: result.installPath,
        installedBy: result.installedBy,
        installedAt: result.installedAt,
        fileCount: result.fileCount,
        byteCount: result.byteCount,
        // An update: what it replaced, and that the folder was swapped, with
        // the backup deleted once the generator accepted the new release.
        ...(result.update
          ? {
              update: {
                from: result.update.from,
                direction: result.update.direction,
                localChangesDiscarded: result.update.localChangesDiscarded,
                swapped: true,
                backupDeleted: true,
              },
            }
          : {}),
      },
    });
    return result;
  } catch (err) {
    const failure = describeRegisterFailure(err);
    await recordAdminAction(options.actor, {
      action: `${kind}.register.rejected`,
      targetType: kind,
      targetId: slug,
      details: {
        via: options.via,
        reason: failure.code,
        // Never the detail, which is the generator's output, nor the words of
        // an error nothing here expected, which can name this machine's paths.
        message: failure.code === "unknown" ? "An unexpected error stopped it." : failure.message,
        ...updateDetails(kind, slug, options.root ?? checkoutRoot()),
      },
    });
    throw err;
  }
}

/**
 * For a refused registration of a pending update, the releases it would have
 * swapped, read from its records for the audit row; nothing for an install,
 * or for records that can't be read. A swap that stopped midway has both in
 * its backup's record, and may have moved the pending folder into place, so
 * that record is read first.
 */
function updateDetails(kind: ExtensionKind, slug: string, root: string): Record<string, unknown> {
  if (!isPendingKind(kind) || !SlugSchema.safeParse(slug).success) return {};
  const leftover = leftoverBackup(root, kind, slug);
  const backup = leftover ? readBackupRecord(leftover.record) : null;
  if (backup?.state === "ok" && backup.record.operation === "update") {
    const { from, to } = backup.record;
    return {
      update: {
        from: { version: from.version, commitSha: from.commitSha },
        to: { version: to.version, commitSha: to.commitSha },
      },
    };
  }
  const where = pendingLocation(root, kind, slug);
  const read = readSidecar(where.sidecar);
  const replaces = read.state === "ok" ? read.sidecar.replaces : undefined;
  if (!replaces) return {};
  const record = isRealDirectory(where.folder) ? readInstallRecord(where.folder) : null;
  return {
    update: {
      from: { version: replaces.version, commitSha: replaces.commitSha },
      to: record?.state === "ok" ? { version: record.record.version, commitSha: record.record.commitSha } : null,
    },
  };
}

async function registerUnderLocks(
  kind: ExtensionKind,
  slug: string,
  root: string,
  options: PendingActionOptions,
): Promise<RegisterResult> {
  assertPendingTarget(kind, slug);
  // Before the locks, as for install: registering is the second half of
  // installing from the Registry, so the kind's install flag decides it too.
  if (!installEnabled(kind)) {
    throw new RegisterError(
      `${installDisabledMessage(kind)} Registering one finishes installing it, so it is off too. ` +
        `Discard it with \`npm run register -- ${kind}/${slug} --discard\`.`,
      "disabled",
    );
  }
  assertRegistrable(kind, root, options.generator);

  const purpose = `a registration of ${kind}/${slug}${options.via === "cli" ? " (npm run register)" : ""}`;
  return withPlatformLock("repository.register", (lease) =>
    withCheckoutLock(root, purpose, (lock) => {
      tellTakeover(lock, options);
      return runRegister(kind, slug, root, lock.token, bothLocks(lease, lock), options);
    }),
  );
}

/**
 * The environment Register needs: a checkout, not a built deployment; a
 * writable folder to register into; and the generator, which it runs.
 */
function assertRegistrable(kind: PendingKind, root: string, generator?: string): void {
  if (isBuiltDeployment()) {
    throw new RegisterError(BUILT_DEPLOYMENT_NOTICE, "unsupported-environment");
  }
  // Runtime paths in the checkout, never files a build should carry, so each
  // join is marked for Turbopack's tracer to leave alone (see ./pending.ts).
  const dir = path.join(/* turbopackIgnore: true */ root, kindDir(kind));
  try {
    fs.accessSync(path.join(/* turbopackIgnore: true */ pathExists(dir) ? dir : root), fs.constants.W_OK);
  } catch {
    throw new RegisterError(
      `${kindDir(kind)}/ is not writable in this checkout, so nothing can be registered into it.`,
      "unsupported-environment",
    );
  }
  const script = path.join(/* turbopackIgnore: true */ generator ?? path.join(/* turbopackIgnore: true */ root, "scripts", "generate-project-registry.ts"));
  if (!fs.existsSync(script)) {
    throw new RegisterError(
      "The registry generator isn't in this checkout, so nothing can be registered here.",
      "unsupported-environment",
    );
  }
}

async function runRegister(
  kind: PendingKind,
  slug: string,
  root: string,
  lockToken: string,
  lease: PlatformLease,
  options: PendingActionOptions,
): Promise<RegisterResult> {
  const where = pendingLocation(root, kind, slug);
  const live = liveLocation(root, kind, slug);
  const fence = fencer(lease, "This registration", options.signal);
  const generator = { lockToken, root: options.root, generator: options.generator, signal: options.signal };

  // 1. Nothing of this name left by a removal or an update that stopped
  // midway: `.mixos/backup/` may hold the folder this would go into, or
  // replace, for recovery to put back. Checked before the pending records,
  // since an update that died after its swap left a record in both places,
  // and the backup's says which releases are where.
  const leftover = leftoverBackup(root, kind, slug);
  if (leftover) throw new RegisterError(leftoverBackupMessage(leftover, slug), "interrupted");
  // What is pending, its records, and nothing where it would go.
  const { sidecar, record } = pendingInstallFor(kind, slug, where);
  if (options.reviewedFilesHash !== undefined && !contentHashesMatch(options.reviewedFilesHash, record.filesHash)) {
    throw new RegisterError(
      `What is waiting in ${where.rel}/ isn't what you reviewed: it was discarded and installed ` +
        "again, or replaced, since. Nothing was moved. Review it again before registering it.",
      "changed-meanwhile",
    );
  }

  // An update replaces the folder in place, which has to be the one it was
  // prepared against. Anything else is never registered over.
  const replaces = sidecar.replaces ?? null;
  if (replaces) {
    const problem = replacesProblem(root, kind, slug, replaces);
    if (problem) throw new RegisterError(`${where.rel}/ was not registered: nothing was moved. ${problem}`, "folder-changed");
  } else if (pathExists(live.dir)) {
    throw new RegisterError(
      `${live.rel} already exists in this checkout, so ${slug} can't be registered over it. ` +
        `Discard the pending copy with \`npm run register -- ${kind}/${slug} --discard\`, or ` +
        `remove ${live.rel} first.`,
      "already-registered",
    );
  }

  // What runs has to be what install verified and checked: every file but the
  // record, against the record's files hash.
  let found: string;
  try {
    found = folderFilesHash(where.folder);
  } catch (err) {
    if (err instanceof FolderReadError) throw changedSinceInstall(slug, kind, err.message);
    throw err;
  }
  if (!contentHashesMatch(found, record.filesHash)) {
    throw changedSinceInstall(slug, kind, `expected ${record.filesHash}\nfound    ${found}`);
  }

  // 2. The release's floor, against the version this checkout builds.
  const compat = satisfiesMinimum(record.requiresMixOS);
  if (!compat.allowed) throw new RegisterError(compat.reason!, "incompatible");
  if (compat.reason) console.warn(`[register] ${kind}/${slug}: ${compat.reason}`);

  if (replaces) {
    return registerUpdate({ kind, slug, root, lockToken, fence, generator, where, live, sidecar, record, replaces });
  }

  // 3. Record this registration, then move it into place.
  await fence(`Nothing was moved: ${slug} is still waiting in ${where.rel}/.`);
  const registering: Registering = {
    token: lockToken,
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
  };
  writeSidecar(where.sidecar, { ...sidecar, register: registering });
  try {
    fs.mkdirSync(path.dirname(live.dir), { recursive: true });
    fs.renameSync(where.folder, live.dir);
  } catch (err) {
    writeSidecar(where.sidecar, sidecar);
    throw new RegisterError(
      `Could not move ${slug} into ${live.rel}: ${err instanceof Error ? err.message : String(err)}`,
      "write-failed",
    );
  }

  // 4. The first run of its code.
  const registry = await regenerateRegistry(kind, slug, generator);

  if (!registry.ok) {
    // 5. Refused: back to pending, its record cleared, and the registry
    // regenerated, since the run that refused it may have rewritten it.
    await fence(
      `${live.rel} is in place but was not registered. Run \`npm run register -- --recover\` ` +
        `to put it back in pending.`,
      registry.output,
    );
    fs.renameSync(live.dir, where.folder);
    writeSidecar(where.sidecar, sidecar);
    const restored = await runRegistryGenerator(generator);
    throw refusal(slug, registry, restored.code === 0);
  }

  // Accepted. The record is done with.
  await fence(
    `${slug} is registered in ${live.rel}, but its record in ${where.rel}.json was left. ` +
      "`npm run register -- --recover` would put it back in pending; delete that file " +
      "instead to keep it registered.",
    undefined,
    { finishing: true },
  );
  fs.rmSync(where.sidecar, { force: true });

  const files = folderFiles(live.dir);
  const packaged = files.filter((f) => f.path !== INSTALL_RECORD_FILE);
  return {
    kind,
    slug,
    record,
    source: record.source,
    version: record.version,
    gitTag: record.gitTag,
    commitSha: record.commitSha,
    contentHash: record.contentHash,
    filesHash: record.filesHash,
    installPath: live.rel,
    installedBy: sidecar.installedBy,
    installedAt: sidecar.installedAt,
    fileCount: packaged.length,
    byteCount: packaged.reduce((n, f) => n + f.bytes, 0),
    leftOut: sidecar.leftOut ?? {},
    deferred: sidecar.check.deferred,
    registry,
    handBack: handBackFor(record, live.rel, files),
    update: null,
    // The hand-back says how to ship it; this says what it is now.
    nextStep:
      `Registered to ${live.rel}: the registry generator loaded its code and accepted it. ` +
      (kind === "app"
        ? "It is off until an admin activates it in Admin > Apps (run `npm run migrate:apps` " +
          "first if it has migrations)."
        : "Configure it in Admin > Connectors."),
  };
}

/** What registerUpdate() works with: runRegister()'s own, once its checks have passed. */
interface UpdateContext {
  kind: PendingKind;
  slug: string;
  root: string;
  lockToken: string;
  fence: ReturnType<typeof fencer>;
  generator: { lockToken: string; root?: string; generator?: string; signal?: AbortSignal };
  where: ReturnType<typeof pendingLocation>;
  live: { dir: string; rel: string };
  sidecar: PendingSidecar;
  record: InstallRecord;
  replaces: Replaces;
}

/**
 * Steps 3 to 5 for a pending update: the swap, the generator's first run of
 * the new release, and then the backup deleted, or everything put back.
 */
async function registerUpdate(c: UpdateContext): Promise<RegisterResult> {
  const { kind, slug, root, lockToken, fence, generator, where, live, sidecar, record, replaces } = c;
  const from = replaces.version;
  const to = record.version;
  const backup = backupLocation(root, kind, slug);
  const swap: UpdateSwap = {
    live,
    backup,
    incoming: { dir: where.folder, rel: where.rel },
    record: updateRecordFor(kind, slug, lockToken, replaces, record),
  };

  // 3. Record this registration in the sidecar, then the swap, which fences
  // before each of its own changes.
  await fence(`Nothing was moved: ${to} is still waiting in ${where.rel}/, and ${live.rel} holds ${from}.`);
  writeSidecar(where.sidecar, { ...sidecar, register: registeringNow(lockToken) });
  try {
    await swapIn(swap, (left) => fence(left), (message) => new RegisterError(message, "write-failed"));
  } catch (err) {
    // A rename that failed put back what it moved. A lost lock or a stop
    // leaves everything as it was at that point, for recovery.
    if (err instanceof RegisterError && err.code === "write-failed") writeSidecar(where.sidecar, sidecar);
    throw err;
  }

  // 4. The new release's code runs for the first time.
  const registry = await regenerateRegistry(kind, slug, generator);

  if (!registry.ok) {
    // 5. Refused, stopped or out of time: the update back to pending, the
    // folder it replaced back in place, and the registry regenerated. A Ctrl-C
    // doesn't stop this: it is what leaves the checkout as it was.
    await fence(
      `The registry generator didn't accept ${to}: ${live.rel} holds it, and ${from} waits in ${backup.rel}/. ` +
        `Run \`npm run register -- --recover\` to restore ${from}.`,
      registry.output,
      { finishing: true },
    );
    swapBack(swap, { keepIncoming: true });
    writeSidecar(where.sidecar, sidecar);
    const restored = await runRegistryGenerator({ ...generator, signal: undefined });
    throw updateRefusal(c, registry, restored.code === 0, generator.signal?.aborted === true);
  }

  // Accepted. What it changed, while both folders are here, then the backup
  // goes: the record first says the generator accepted it, so recovery
  // finishes deleting rather than putting it back.
  await fence(
    `${to} is registered in ${live.rel}, but ${from} is still in ${backup.rel}/. Run ` +
      `\`npm run register -- --recover\` and keep ${to} to finish.`,
    undefined,
    { finishing: true },
  );
  const changes = folderDifferences(backup.folder, live.dir);
  const migrationsAdded =
    kind === "app" ? compareMigrations(folderMigrations(backup.folder), folderMigrations(live.dir)).added : [];
  swapDone(swap, () => fs.rmSync(where.sidecar, { force: true }));

  const files = folderFiles(live.dir);
  const packaged = files.filter((f) => f.path !== INSTALL_RECORD_FILE);
  return {
    kind,
    slug,
    record,
    source: record.source,
    version: record.version,
    gitTag: record.gitTag,
    commitSha: record.commitSha,
    contentHash: record.contentHash,
    filesHash: record.filesHash,
    installPath: live.rel,
    installedBy: sidecar.installedBy,
    installedAt: sidecar.installedAt,
    fileCount: packaged.length,
    byteCount: packaged.reduce((n, f) => n + f.bytes, 0),
    leftOut: sidecar.leftOut ?? {},
    deferred: sidecar.check.deferred,
    registry,
    handBack: updateHandBackFor(
      record,
      {
        version: from,
        commitSha: replaces.commitSha,
        direction: replaces.direction,
        localChangesDiscarded: replaces.localChangesDiscarded,
      },
      live.rel,
      files,
      changes,
    ),
    update: {
      from: { version: from, gitTag: replaces.gitTag, commitSha: replaces.commitSha },
      direction: replaces.direction,
      localChangesDiscarded: replaces.localChangesDiscarded,
      migrationsAdded,
      changes,
    },
    nextStep: updateNextStep(kind, live.rel, from, to, migrationsAdded.length),
  };
}

/** The backup record an update writes before it moves anything: both releases, and this registration. */
export function updateRecordFor(
  kind: ExtensionKind,
  slug: string,
  lockToken: string,
  replaces: Pick<Replaces, "version" | "gitTag" | "commitSha" | "folderHash">,
  to: Pick<InstallRecord, "version" | "gitTag" | "commitSha" | "filesHash">,
): UpdateRecord {
  return {
    operation: "update",
    kind,
    slug,
    ...registeringNow(lockToken),
    from: { version: replaces.version, gitTag: replaces.gitTag, commitSha: replaces.commitSha, folderHash: replaces.folderHash },
    to: { version: to.version, gitTag: to.gitTag, commitSha: to.commitSha, filesHash: to.filesHash },
  };
}

/** This process, holding the checkout lock by `token`, as a record names it. */
function registeringNow(token: string): Registering {
  return { token, pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() };
}

/**
 * What an update put in place is now, for a paragraph after Register. How to
 * ship it, and to roll it back, is the hand-back's to say.
 */
export function updateNextStep(kind: ExtensionKind, rel: string, from: string, to: string, migrationsAdded: number): string {
  const kept =
    kind === "app"
      ? "Its activation, grants and settings carry over: they belong to its slug, in the database."
      : kind === "connector"
        ? "Its credentials and its users' connections carry over: they belong to its name, in the database."
        : "Whether it is the applied theme carries over.";
  const migrate =
    migrationsAdded > 0
      ? ` Run \`npm run migrate:apps\` in this checkout to apply its ${migrationsAdded} new ` +
        `${migrationsAdded === 1 ? "migration" : "migrations"}, which can't be undone.`
      : "";
  const restart =
    kind === "theme"
      ? ""
      : " If `npm run dev` is running, restart it: until it does, it can keep serving the code it compiled " +
        `from ${from}.`;
  return (
    `Updated ${rel} from ${from} to ${to}: the registry generator loaded the new code and accepted it, ` +
    `and the backup of ${from} was deleted. ${kept}${migrate}${restart}`
  );
}

/** Why an update the generator didn't accept was put back. */
function updateRefusal(
  c: Pick<UpdateContext, "slug" | "live" | "where" | "replaces" | "record">,
  registry: RegistryOutcome,
  restored: boolean,
  stopped: boolean,
): RegisterError {
  const from = c.replaces.version;
  const to = c.record.version;
  const back = `${from} was put back in ${c.live.rel}, and ${to} waits in ${c.where.rel}/ again.`;
  const after = restored
    ? ""
    : " Regenerating the registry afterwards failed too, so src/generated/ may still describe " +
      `${to}: run \`npm run registry\`.`;
  if (stopped) return new RegisterError(`Stopped before it finished. ${back}${after}`, "stopped", registry.output);
  if (!registry.ran || registry.stopped) {
    return new RegisterError(
      `The registry generator ${registry.ran ? "stopped" : "didn't finish"} with ${to} in place, so ${back} ` +
        `Registering loads its code for the first time, so the output below may be about that code or about ` +
        `this checkout.${after}`,
      "generator-failed",
      registry.output,
    );
  }
  return new RegisterError(
    `The registry generator left ${c.slug} ${to} out once it loaded its code, so ${back} The output below ` +
      `says why.${after}`,
    "rejected-by-registry",
    registry.output,
  );
}

/**
 * The sidecar and the install record of a pending install that Register can
 * act on, or why not.
 */
function pendingInstallFor(
  kind: PendingKind,
  slug: string,
  where: ReturnType<typeof pendingLocation>,
): { sidecar: PendingSidecar; record: InstallRecord } {
  const read = readSidecar(where.sidecar);
  const hasFolder = isRealDirectory(where.folder);
  if (read.state === "ok" && read.sidecar.register) throw interruptedEarlier(slug, read.sidecar.register);
  if (!hasFolder && read.state === "missing") {
    throw new RegisterError(
      `Nothing named ${slug} is waiting in ${MIXOS_DIR}/pending/${kindDir(kind)}/. Install it ` +
        "from the Registry first.",
      "not-pending",
    );
  }
  if (!hasFolder) {
    throw new RegisterError(
      `${where.rel}/ is missing, so there is nothing to register. Run ` +
        "`npm run register -- --recover` to clear its record.",
      "unregistrable",
    );
  }
  const discard = `Discard it with \`npm run register -- ${kind}/${slug} --discard\` and install it again.`;
  if (read.state === "unreadable" && read.earlier) {
    // Pending installs from before the record moved into the folder have no
    // record there, so there is nothing to check them against.
    throw new RegisterError(
      `${where.rel}/ was installed by an earlier version of MixOS, before installs kept their record ` +
        `in the extension's folder, so it can't be checked and won't be registered. ${discard}`,
      "unregistrable",
    );
  }
  if (read.state !== "ok") {
    throw new RegisterError(
      `${where.rel}/ has no readable record of its install (${where.rel}.json` +
        (read.state === "unreadable" ? `: ${read.reason}` : ", which is missing") +
        `), so it won't be registered. ${discard}`,
      "unregistrable",
    );
  }
  if (read.sidecar.kind !== kind || read.sidecar.slug !== slug) {
    throw new RegisterError(
      `${where.rel}.json records ${read.sidecar.kind}/${read.sidecar.slug}, not ${kind}/${slug}, so ` +
        `it isn't a record of this folder. Discard it and install it again.`,
      "unregistrable",
    );
  }
  const record = readInstallRecord(where.folder);
  const problem = recordProblem(where, kind, slug, record);
  if (problem || record.state !== "ok") {
    throw new RegisterError(`${where.rel}/ can't be registered. ${problem} ${discard}`, "unregistrable");
  }
  return { sidecar: read.sidecar, record: record.record };
}

function changedSinceInstall(slug: string, kind: PendingKind, detail: string): RegisterError {
  return new RegisterError(
    `${slug} has changed since it was installed: its files are no longer the ones install ` +
      `verified and checked, so it was not registered. Discard it with ` +
      `\`npm run register -- ${kind}/${slug} --discard\` and install it again.`,
    "changed",
    detail,
  );
}

function refusal(slug: string, registry: RegistryOutcome, restored: boolean): RegisterError {
  const after = restored
    ? ""
    : " Regenerating the registry afterwards failed too, so src/generated/ may still list it: " +
      "run `npm run registry`.";
  if (!registry.ran) {
    return new RegisterError(
      `The registry generator didn't finish while registering ${slug}, so it was put back in ` +
        `pending. Registering loads its code for the first time, so the output below may be ` +
        `about that code or about this checkout.${after}`,
      "generator-failed",
      registry.output,
    );
  }
  if (registry.stopped) {
    return new RegisterError(
      `The registry generator stopped while registering ${slug}, so it was put back in pending. ` +
        `Registering loads its code for the first time, so the output below may be about that ` +
        `code or about this checkout.${after}`,
      "generator-failed",
      registry.output,
    );
  }
  return new RegisterError(
    `The registry generator left ${slug} out once it loaded its code, so it was put back in ` +
      `pending. The output below says why.${after}`,
    "rejected-by-registry",
    registry.output,
  );
}

/* -------------------------------------------------------------------------- */
/*  Discard                                                                    */
/* -------------------------------------------------------------------------- */

export interface DiscardResult {
  kind: PendingKind;
  slug: string;
  /** Repo-relative path of what was deleted. */
  pendingPath: string;
  /** Its sidecar, when it could be read. */
  sidecar: PendingSidecar | null;
  /** Its install record, when it could be read. */
  record: InstallRecord | null;
}

/** Delete a pending install, folder and sidecar, under both locks. Audited. */
export async function discardPending(
  kind: ExtensionKind,
  slug: string,
  options: PendingActionOptions,
): Promise<DiscardResult> {
  const root = options.root ?? checkoutRoot();
  const result = await discardUnderLocks(kind, slug, root, options);
  const { sidecar: s, record: r } = result;
  await recordAdminAction(options.actor, {
    action: `${kind}.discard`,
    targetType: kind,
    targetId: slug,
    details: {
      via: options.via,
      pendingPath: result.pendingPath,
      ...(r
        ? {
            source: r.source,
            version: r.version,
            commitSha: r.commitSha,
            contentHash: r.contentHash,
            filesHash: r.filesHash,
          }
        : { installRecord: "missing or unreadable" }),
      ...(s ? { installedBy: s.installedBy, installedAt: s.installedAt } : { record: "missing or unreadable" }),
      // A pending update: the release it would have replaced, which stays.
      ...(s?.replaces ? { replaces: { version: s.replaces.version, commitSha: s.replaces.commitSha } } : {}),
    },
  });
  return result;
}

async function discardUnderLocks(
  kind: ExtensionKind,
  slug: string,
  root: string,
  options: PendingActionOptions,
): Promise<DiscardResult> {
  assertPendingTarget(kind, slug);
  const purpose = `a discard of ${kind}/${slug}${options.via === "cli" ? " (npm run register)" : ""}`;
  return withPlatformLock("repository.register", (lease) =>
    withCheckoutLock(root, purpose, async (lock) => {
      tellTakeover(lock, options);
      const fence = fencer(bothLocks(lease, lock), "This discard", options.signal);
      const where = pendingLocation(root, kind, slug);
      const read = readSidecar(where.sidecar);
      if (read.state === "ok" && read.sidecar.register) throw interruptedEarlier(slug, read.sidecar.register);
      if (!pathExists(where.folder) && read.state === "missing") {
        throw new RegisterError(
          `Nothing named ${slug} is waiting in ${MIXOS_DIR}/pending/${kindDir(kind)}/.`,
          "not-pending",
        );
      }

      // What it was, for the audit row, before it goes.
      const record = pathExists(where.folder) ? readInstallRecord(where.folder) : null;
      const own = record?.state === "ok" && record.record.kind === kind && record.record.slug === slug;

      // The folder first: a record without its folder is what recovery
      // clears, and a folder without its record can never be registered.
      await fence("Nothing was deleted.");
      fs.rmSync(where.folder, { recursive: true, force: true });
      await fence(
        `${where.rel}/ was deleted, but its record ${where.rel}.json was left; ` +
          "`npm run register -- --recover` clears it.",
      );
      fs.rmSync(where.sidecar, { force: true });
      return {
        kind,
        slug,
        pendingPath: where.rel,
        sidecar: read.state === "ok" ? read.sidecar : null,
        record: own && record?.state === "ok" ? record.record : null,
      };
    }),
  );
}

/* -------------------------------------------------------------------------- */
/*  Recovery                                                                   */
/* -------------------------------------------------------------------------- */

export type RecoveryAction =
  /** A registration stopped after moving it into place: move it back. */
  | "return-to-pending"
  /** A registration stopped before moving it, or after moving it back: clear the record. */
  | "clear-record"
  /** A record whose folder is gone. */
  | "drop-record"
  /** A pending folder with no record of what install verified. */
  | "drop-folder"
  /** A pending folder whose record can't be read. */
  | "drop-pending"
  /** A staged copy an install left. */
  | "drop-staging"
  /** A half-written record, or a lock file set aside. */
  | "drop-temp"
  /** A stopped registration with both the pending and the live folder there, or a backup recovery can't place. */
  | "resolve-by-hand"
  /** A removal stopped with the folder in `.mixos/backup/`, never accepted without it: move it back. */
  | "restore-backup"
  /** A removal the generator accepted stopped while deleting its backup: finish deleting it. */
  | "finish-removal"
  /** A removal stopped before moving the folder, or after moving it back: delete its record. */
  | "clear-backup-record"
  /** A backup's record that can't be read, with no backup beside it. */
  | "drop-backup-record"
  /**
   * An update stopped with the folder it replaces in `.mixos/backup/`, never
   * accepted: put that back, and the new release back where it came from.
   */
  | "restore-update"
  /**
   * The same, the other way: keep the new release in place, if the registry
   * generator accepts it now, and delete the backup. If it doesn't, restore.
   */
  | "keep-update"
  /** An update the generator accepted stopped while deleting its backup: finish deleting it. */
  | "finish-update"
  /** An update stopped before moving anything, or after putting everything back: delete its record. */
  | "clear-update-record";

/** What the audit row of each action about `.mixos/backup/` calls the operation: `<kind>.<verb>.recover`. */
const BACKUP_VERB: Partial<Record<RecoveryAction, "remove" | "update">> = {
  "restore-backup": "remove",
  "finish-removal": "remove",
  "clear-backup-record": "remove",
  "drop-backup-record": "remove",
  "restore-update": "update",
  "keep-update": "update",
  "finish-update": "update",
  "clear-update-record": "update",
};

/** The actions after which the registry is regenerated, since what is in place changed, or may have. */
const REGENERATES: ReadonlySet<RecoveryAction> = new Set([
  "return-to-pending",
  "clear-record",
  "restore-backup",
  "clear-backup-record",
  "restore-update",
  "clear-update-record",
]);

/** One of two things recovery can do about an item, which a person picks. */
export interface RecoveryChoice {
  action: RecoveryAction;
  /** A few words: "restore 1.2.0". */
  label: string;
  /** What it does, for a person. */
  does: string;
}

export interface RecoveryItem {
  kind: ExtensionKind | null;
  slug: string | null;
  /** Repo-relative path of what it is about. */
  path: string;
  action: RecoveryAction;
  /** What was found, for a person. */
  found: string;
  /** What recovery does about it, for a person. */
  does: string;
  /** Why recovery leaves it alone, when it does. */
  blocked: string | null;
  /** Something to read before agreeing. */
  warning: string | null;
  /**
   * When recovery can go either way, the two ways, `action` the first: an
   * update stopped with its new release in place, which can be restored or
   * kept. RecoverOptions.choose picks.
   */
  choices?: RecoveryChoice[];
}

/**
 * What a stopped install, registration, discard, removal or update left in the
 * checkout at `root`, and what recovery would do about each. Reads only.
 */
export function planRecovery(root: string = checkoutRoot()): RecoveryItem[] {
  const items: RecoveryItem[] = [];
  const here = os.hostname();
  // Who holds the checkout lock now, unless its holder has certainly stopped: a
  // backup's record with that holder's token belongs to an operation still running.
  const holder = readCheckoutLock(root).holder;
  const liveHolder = holder && !isStaleHolder(holder) ? holder : null;
  // The pending installs an update's backup record speaks for: its item covers
  // the pending folder and its sidecar too.
  const updating = updatesUnderway(root);

  for (const kind of ["app", "connector"] as const) {
    const parent = path.join(/* turbopackIgnore: true */ root, MIXOS_DIR, "pending", kindDir(kind));
    let names: string[];
    try {
      names = fs.readdirSync(parent);
    } catch {
      names = [];
    }
    const slugs = new Set<string>();
    for (const name of names) {
      if (name.startsWith(".") && name.endsWith(".tmp")) {
        items.push({
          kind,
          slug: null,
          path: `${MIXOS_DIR}/pending/${kindDir(kind)}/${name}`,
          action: "drop-temp",
          found: "A record that was being written when its writer stopped.",
          does: "Delete it.",
          blocked: null,
          warning: null,
        });
        continue;
      }
      const slug = name.endsWith(".json") ? name.slice(0, -".json".length) : name;
      if (SlugSchema.safeParse(slug).success) slugs.add(slug);
    }

    for (const slug of [...slugs].sort()) {
      if (updating.has(`${kind}/${slug}`)) continue;
      const item = pendingRecovery(root, kind, slug, here);
      if (item) items.push(item);
    }
  }

  for (const kind of ["app", "connector", "theme"] as const) {
    const parent = path.join(/* turbopackIgnore: true */ root, MIXOS_DIR, "staging", kindDir(kind));
    let names: string[];
    try {
      names = fs.readdirSync(parent);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      items.push({
        kind,
        slug: SlugSchema.safeParse(name).success ? name : null,
        path: `${MIXOS_DIR}/staging/${kindDir(kind)}/${name}`,
        action: "drop-staging",
        found: "A copy an install was checking when it stopped. Nothing reads it.",
        does: "Delete it.",
        blocked: null,
        warning: null,
      });
    }
  }

  for (const kind of ["app", "connector", "theme"] as const) {
    const parent = path.join(/* turbopackIgnore: true */ root, MIXOS_DIR, "backup", kindDir(kind));
    let names: string[];
    try {
      names = fs.readdirSync(parent);
    } catch {
      continue;
    }
    const slugs = new Set<string>();
    for (const name of names.sort()) {
      if (name.startsWith(".") && name.endsWith(".tmp")) {
        items.push({
          kind,
          slug: null,
          path: `${MIXOS_DIR}/backup/${kindDir(kind)}/${name}`,
          action: "drop-temp",
          found: "A record that was being written when its writer stopped.",
          does: "Delete it.",
          blocked: null,
          warning: null,
        });
        continue;
      }
      const slug = name.endsWith(".json") ? name.slice(0, -".json".length) : name;
      if (isExtensionName(slug)) slugs.add(slug);
    }
    for (const slug of [...slugs].sort()) {
      const item = backupRecovery(root, kind, slug, liveHolder);
      if (item) items.push(item);
    }
  }

  let lockDir: string[] = [];
  try {
    lockDir = fs.readdirSync(path.join(/* turbopackIgnore: true */ root, MIXOS_DIR));
  } catch {
    // No .mixos/ at all.
  }
  for (const name of lockDir.sort()) {
    if (/^lock\.(stale|broken)-[0-9a-f-]+$/.test(name)) {
      items.push({
        kind: null,
        slug: null,
        path: `${MIXOS_DIR}/${name}`,
        action: "drop-temp",
        found: "A lock file set aside while a stale lock was replaced.",
        does: "Delete it.",
        blocked: null,
        warning: null,
      });
    }
  }
  return items;
}

/** `app/<slug>` and `connector/<slug>` for each readable update record in `.mixos/backup/`. */
function updatesUnderway(root: string): Set<string> {
  const out = new Set<string>();
  for (const kind of ["app", "connector"] as const) {
    let names: string[];
    try {
      names = fs.readdirSync(path.join(/* turbopackIgnore: true */ root, MIXOS_DIR, "backup", kindDir(kind)));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      const slug = name.slice(0, -".json".length);
      if (!SlugSchema.safeParse(slug).success || !isExtensionName(slug)) continue;
      const read = readBackupRecord(backupLocation(root, kind, slug).record);
      if (read.state === "ok" && read.record.operation === "update") out.add(`${kind}/${slug}`);
    }
  }
  return out;
}

function pendingRecovery(root: string, kind: PendingKind, slug: string, here: string): RecoveryItem | null {
  const where = pendingLocation(root, kind, slug);
  const live = liveLocation(root, kind, slug);
  const read = readSidecar(where.sidecar);
  const hasFolder = pathExists(where.folder);
  const inPlace = pathExists(live.dir);
  const base = { kind, slug, path: where.rel, blocked: null, warning: null };

  if (read.state === "ok" && read.sidecar.register) {
    const r = read.sidecar.register;
    const stillRunning = r.hostname === here && r.pid !== process.pid && pidRunning(r.pid);
    const blocked = stillRunning
      ? `The registration that recorded it, pid ${r.pid} on this machine, is still running. ` +
        "Let it finish, or stop it, then run this again."
      : null;
    const warning =
      r.hostname !== here
        ? `It was recorded by a process on another machine, ${r.hostname}, which this ` +
          "can't check. Go ahead only if nothing is registering there."
        : null;
    const stopped = `A registration of ${slug} (${describeRegistering(r)}) stopped`;
    // A pending update with no backup record: its swap never began, or was
    // put back, so the folder in place is the one it replaces. With its
    // folder gone from pending too, nothing says which release is in place.
    if (read.sidecar.replaces && hasFolder) {
      return {
        ...base,
        action: "clear-record",
        found: `${stopped} before it moved anything: ${live.rel} still holds ${read.sidecar.replaces.version}.`,
        does: "Clear the record of it and regenerate the registry. The update stays in pending.",
        blocked,
        warning,
      };
    }
    if (read.sidecar.replaces && inPlace) {
      return {
        ...base,
        action: "resolve-by-hand",
        found: `${stopped}, ${where.rel}/ is gone, and no backup record says which release ${live.rel} holds.`,
        does: "Nothing.",
        blocked:
          blocked ?? `Check ${live.rel} by hand, then delete ${where.rel}.json and run this again.`,
        warning,
      };
    }
    if (!hasFolder && inPlace) {
      return {
        ...base,
        path: live.rel,
        action: "return-to-pending",
        found: `${stopped} after moving it into ${live.rel}, before it was registered.`,
        does: `Move it back to ${where.rel}/ and regenerate the registry. Register it again after.`,
        blocked,
        warning,
      };
    }
    if (hasFolder && !inPlace) {
      return {
        ...base,
        action: "clear-record",
        found: `${stopped} while it was in ${where.rel}/.`,
        does: "Clear the record of it and regenerate the registry. It stays in pending.",
        blocked,
        warning,
      };
    }
    if (!hasFolder && !inPlace) {
      return {
        ...base,
        action: "drop-record",
        found: `${stopped}, and neither ${where.rel}/ nor ${live.rel} is there now.`,
        does: `Delete its record, ${where.rel}.json.`,
        blocked,
        warning,
      };
    }
    return {
      ...base,
      action: "resolve-by-hand",
      found: `${stopped}, and both ${where.rel}/ and ${live.rel} are there.`,
      does: "Nothing.",
      blocked:
        blocked ??
        `Recovery can't tell which copy to keep. Delete one of them by hand, then run this again.`,
      warning,
    };
  }

  if (read.state === "missing" && hasFolder) {
    return {
      ...base,
      action: "drop-folder",
      found: `${where.rel}/ has no record of what install verified, so it can never be registered.`,
      does: "Delete it. Install it again to register it.",
    };
  }
  if (read.state !== "missing" && !hasFolder) {
    return {
      ...base,
      action: "drop-record",
      found: `${where.rel}.json records an install whose folder is gone.`,
      does: "Delete the record.",
    };
  }
  if (read.state === "unreadable" && hasFolder) {
    return {
      ...base,
      action: "drop-pending",
      found: `${where.rel}.json can't be read (${read.reason}), so ${where.rel}/ can't be checked or registered.`,
      does: "Delete both. Install it again to register it.",
    };
  }
  return null;
}

/**
 * What a removal or an update of `kind`/`slug` left in `.mixos/backup/`
 * (./backup.ts), and what recovery would do about it. The record's token says
 * whose it is: one the checkout lock holds now, from a holder that may still
 * be running, is an operation under way, which is left alone. Any other has
 * stopped, or has lost its lock and stops at its next check of it.
 */
function backupRecovery(
  root: string,
  kind: ExtensionKind,
  slug: string,
  liveHolder: CheckoutLockHolder | null,
): RecoveryItem | null {
  const where = backupLocation(root, kind, slug);
  const live = extensionFolder(root, kind, slug);
  const read = readBackupRecord(where.record);
  const hasBackup = pathExists(where.folder);
  const inPlace = pathExists(live.dir);
  const base = { kind, slug, path: where.rel, blocked: null, warning: null };

  if (read.state === "ok") {
    const r = read.record;
    const what = r.operation === "update" ? "update" : "removal";
    const blocked =
      liveHolder?.token !== r.token
        ? null
        : liveHolder.hostname === os.hostname()
          ? `The ${what} that recorded it, pid ${r.pid} on this machine, is still running. Let it ` +
            "finish, or stop it, then run this again."
          : `The ${what} that recorded it holds this checkout's lock from another machine, ` +
            `${liveHolder.hostname.replace(/[^\x20-\x7e]/g, "?")}, which this can't check. If it has stopped, run ` +
            "`npm run register -- --break-lock`, then run this again.";
    if (r.operation === "update") return updateRecovery(root, r, where, live, { hasBackup, inPlace, blocked });

    const stopped = `A removal of ${slug} (${describeRegistering(r)}) stopped`;
    if (r.accepted) {
      return {
        ...base,
        action: "finish-removal",
        found:
          `${stopped} after the registry generator accepted the checkout without ${live.rel}, ` +
          `while it was deleting the copy in ${where.rel}/.`,
        does: `Delete what is left of ${where.rel}/ and its record. The removal is done.`,
        blocked,
      };
    }
    if (hasBackup && !inPlace) {
      return {
        ...base,
        action: "restore-backup",
        found: `${stopped} with ${live.rel} moved to ${where.rel}/, before it was removed.`,
        does: `Move it back to ${live.rel} and regenerate the registry. Remove it again after.`,
        blocked,
      };
    }
    if (!hasBackup) {
      return {
        ...base,
        action: "clear-backup-record",
        found: inPlace
          ? `${stopped} while ${live.rel} was in place.`
          : `${stopped}, and neither ${where.rel}/ nor ${live.rel} is there now.`,
        does: `Delete its record, ${where.rel}.json, and regenerate the registry.`,
        blocked,
      };
    }
    return {
      ...base,
      action: "resolve-by-hand",
      found: `${stopped}, and both ${where.rel}/ and ${live.rel} are there.`,
      does: "Nothing.",
      blocked:
        blocked ?? "Recovery can't tell which copy to keep. Delete one of them by hand, then run this again.",
    };
  }

  if (read.state === "unreadable") {
    if (!hasBackup) {
      return {
        ...base,
        action: "drop-backup-record",
        found: `${where.rel}.json can't be read (${read.reason}), and there is no backup beside it.`,
        does: "Delete it.",
      };
    }
    return {
      ...base,
      action: "resolve-by-hand",
      found: `${where.rel}/ is a backup whose record can't be read (${read.reason}).`,
      does: "Nothing.",
      blocked: `Recovery can't tell what made it. Move it back to ${live.rel} by hand, or delete it, then run this again.`,
    };
  }

  if (!hasBackup) return null;
  return {
    ...base,
    action: "resolve-by-hand",
    found: `${where.rel}/ is a backup with no record of what made it.`,
    does: "Nothing.",
    blocked: `Recovery can't tell what made it. Move it back to ${live.rel} by hand, or delete it, then run this again.`,
  };
}

/**
 * Where the new release of an update waits until it is in place, and goes back
 * to if it is restored: the pending folder for an app or a connector, or null
 * for a theme, whose staged copy is deleted instead.
 */
function incomingFor(root: string, kind: ExtensionKind, slug: string): ReturnType<typeof pendingLocation> | null {
  return isPendingKind(kind) && SlugSchema.safeParse(slug).success ? pendingLocation(root, kind, slug) : null;
}

/** The swap an update's record describes, for recovery to undo or finish. */
function swapFor(root: string, record: UpdateRecord): UpdateSwap {
  const { kind, slug } = record;
  const incoming = incomingFor(root, kind, slug);
  return {
    live: extensionFolder(root, kind, slug),
    backup: backupLocation(root, kind, slug),
    incoming: incoming
      ? { dir: incoming.folder, rel: incoming.rel }
      : stagingLocation(root, kind, slug),
    record,
  };
}

/** An update's leftovers, from its record (backupRecovery()). */
function updateRecovery(
  root: string,
  r: UpdateRecord,
  where: BackupLocation,
  live: { dir: string; rel: string },
  { hasBackup, inPlace, blocked }: { hasBackup: boolean; inPlace: boolean; blocked: string | null },
): RecoveryItem {
  const { kind, slug, from, to } = r;
  const base = { kind, slug, path: where.rel, blocked, warning: null };
  const incoming = incomingFor(root, kind, slug);
  const stopped = `An update of ${slug} from ${from.version} to ${to.version} (${describeRegistering(r)}) stopped`;
  const waits = incoming ? ` ${to.version} stays in ${incoming.rel}/, to register again or discard.` : "";

  if (r.accepted) {
    return {
      ...base,
      action: "finish-update",
      found:
        `${stopped} after the registry generator accepted ${to.version} in ${live.rel}, while it was ` +
        `deleting the backup of ${from.version}.`,
      does: `Delete what is left of ${where.rel}/ and its record. The update is done.`,
    };
  }
  if (!hasBackup) {
    return {
      ...base,
      action: "clear-update-record",
      found: inPlace
        ? `${stopped} before it moved ${live.rel}, or after putting it back.`
        : `${stopped}, and neither ${where.rel}/ nor ${live.rel} is there now.`,
      does: `Delete its record, ${where.rel}.json, and regenerate the registry.${waits}`,
    };
  }
  if (!inPlace) {
    return {
      ...base,
      action: "restore-update",
      found: `${stopped} with ${from.version} moved to ${where.rel}/, before ${to.version} was put in its place.`,
      does: `Move ${from.version} back to ${live.rel} and regenerate the registry.${waits}`,
    };
  }
  if (incoming && pathExists(incoming.folder)) {
    return {
      ...base,
      action: "resolve-by-hand",
      found: `${stopped}, and ${live.rel}, ${where.rel}/ and ${incoming.rel}/ are all there.`,
      does: "Nothing.",
      blocked:
        blocked ??
        "Recovery can't tell which copy is which. Move them by hand, or delete the ones you don't want, then run this again.",
    };
  }
  const restore: RecoveryChoice = {
    action: "restore-update",
    label: `restore ${from.version}`,
    does:
      `Restore ${from.version}: ` +
      (incoming ? `move ${to.version} back to ${incoming.rel}/` : `delete ${to.version} from ${live.rel}`) +
      `, move ${from.version} back to ${live.rel}, and regenerate the registry.`,
  };
  const keep: RecoveryChoice = {
    action: "keep-update",
    label: `keep ${to.version}`,
    does:
      `Keep ${to.version}: run the registry generator with it in place, as the update would have, and if it ` +
      `accepts it, delete the backup of ${from.version}. If it doesn't, ${from.version} is restored instead.`,
  };
  return {
    ...base,
    action: restore.action,
    found:
      `${stopped} with ${to.version} in ${live.rel} and ${from.version} in ${where.rel}/, before the registry ` +
      `generator accepted ${to.version}.`,
    does: restore.does,
    choices: [restore, keep],
  };
}

/** A plan's identity: two plans are the same when they would do the same things. */
function planKey(items: readonly RecoveryItem[]): string {
  return items.map((i) => `${i.action}:${i.path}:${i.blocked ? "blocked" : ""}`).join("\n");
}

export interface RecoverOptions extends PendingActionOptions {
  /** Shown what recovery found and would do; resolves to whether to go ahead. */
  confirm: (items: RecoveryItem[]) => Promise<boolean>;
  /**
   * Asked first, for each item with `choices`: which to do, or null to leave it
   * alone. Without it, the first choice is what recovery does.
   */
  choose?: (item: RecoveryItem) => Promise<RecoveryAction | null>;
  /** The command that asked, which the checkout lock names while recovery holds it. */
  command?: string;
}

export interface RecoverResult {
  /** Everything found, with what was chosen for each that offered a choice. */
  items: RecoveryItem[];
  /** What was done. */
  acted: RecoveryItem[];
  /** Nothing was done because the answer was no. */
  cancelled: boolean;
  /** The registry generator's run, when recovery needed one. */
  regenerated: { ok: boolean; output: string } | null;
  /** What a person should know about what was done: an update kept that the generator then refused. */
  notes: string[];
}

/**
 * Deal with what a stopped install, registration, discard, removal or update
 * left. Shows the plan and asks without holding a lock, then takes both,
 * checks the checkout is still as shown, and acts. Each pending install it
 * acts on is audited as `<kind>.register.recover`, each removal's backup as
 * `<kind>.remove.recover`, and each update's as `<kind>.update.recover`.
 */
export async function recoverCheckout(options: RecoverOptions): Promise<RecoverResult> {
  const root = options.root ?? checkoutRoot();
  const items = planRecovery(root);
  const none = { acted: [], regenerated: null, notes: [] };
  if (!items.some((i) => !i.blocked)) return { items, cancelled: false, ...none };

  // Which way each update goes, before anything else is asked.
  const planned: RecoveryItem[] = [];
  for (const item of items) {
    if (item.blocked || !item.choices) {
      planned.push(item);
      continue;
    }
    const picked = options.choose ? await options.choose(item) : item.action;
    const choice = item.choices.find((c) => c.action === picked);
    planned.push(
      choice
        ? { ...item, action: choice.action, does: choice.does }
        : { ...item, blocked: "Left as it is: you chose neither." },
    );
  }
  if (!planned.some((i) => !i.blocked)) return { items: planned, cancelled: true, ...none };
  if (!(await options.confirm(planned))) return { items: planned, cancelled: true, ...none };

  const purpose = options.command ?? "npm run register -- --recover";
  const { acted, regenerated, notes } = await withPlatformLock("repository.register", (lease) =>
    withCheckoutLock(root, purpose, async (lock) => {
      tellTakeover(lock, options);
      const fence = fencer(bothLocks(lease, lock), "This recovery", options.signal);
      if (planKey(planRecovery(root)) !== planKey(items)) {
        throw new RegisterError(
          "The checkout changed while you were deciding, so nothing was done. Run it again to see what is there now.",
          "changed-meanwhile",
        );
      }
      const generator = {
        lockToken: lock.token,
        root: options.root,
        generator: options.generator,
        signal: options.signal,
      };

      const done: RecoveryItem[] = [];
      const notes: string[] = [];
      const soFar = () =>
        done.length === 0 ? "Nothing was changed." : `It had dealt with: ${done.map((d) => d.path).join(", ")}.`;
      let regenerate = false;
      for (const item of planned) {
        if (item.blocked) continue;
        await fence(`${soFar()} Run it again to finish.`);
        if (item.action === "keep-update") {
          const kept = await keepUpdate(root, item, generator, fence);
          if (kept) {
            done.push(item);
          } else {
            const restore = item.choices?.find((c) => c.action === "restore-update");
            done.push({ ...item, action: "restore-update", does: restore?.does ?? item.does });
            notes.push(
              `The registry generator didn't accept what ${item.path} replaced, so recovery restored the backup ` +
                "instead. Register the update again to see why, or discard it.",
            );
            regenerate = true;
          }
          continue;
        }
        actOn(root, item);
        if (REGENERATES.has(item.action)) regenerate = true;
        done.push(item);
      }

      let regenerated: RecoverResult["regenerated"] = null;
      if (regenerate) {
        await fence(`${soFar()} Run \`npm run registry\` to regenerate the registry.`);
        const run = await runRegistryGenerator(generator);
        regenerated = { ok: run.code === 0, output: run.output };
      }
      return { acted: done, regenerated, notes };
    }),
  );

  for (const item of acted) {
    if (!item.kind || !item.slug || item.action === "drop-staging" || item.action === "drop-temp") continue;
    const verb = BACKUP_VERB[item.action] ?? "register";
    await recordAdminAction(options.actor, {
      action: `${item.kind}.${verb}.recover`,
      targetType: item.kind,
      targetId: item.slug,
      details: { via: options.via, action: item.action, path: item.path },
    });
  }
  return { items: planned, acted, cancelled: false, regenerated, notes };
}

/**
 * "Keep": the generator runs with the new release in place, as the update
 * would have run it. Accepted, the backup is deleted and the update is done;
 * refused, the backup is restored as "restore" would. Returns whether it kept
 * it. The caller holds both locks and has checked them.
 */
async function keepUpdate(
  root: string,
  item: RecoveryItem,
  generator: { lockToken: string; root?: string; generator?: string; signal?: AbortSignal },
  fence: ReturnType<typeof fencer>,
): Promise<boolean> {
  const read = readBackupRecord(backupLocation(root, item.kind!, item.slug!).record);
  if (read.state !== "ok" || read.record.operation !== "update") {
    throw new RegisterError(
      `${item.path}.json changed while recovery ran, so it was left as it is. Run it again.`,
      "changed-meanwhile",
    );
  }
  const record = read.record;
  const swap = swapFor(root, record);
  const registry = await regenerateRegistry(record.kind, record.slug, generator);
  // Either way this finishes, so a Ctrl-C doesn't leave it half done.
  await fence(
    `${swap.live.rel} holds ${record.to.version}, and ${record.from.version} is still in ${swap.backup.rel}/. Run it again.`,
    registry.output,
    { finishing: true },
  );
  if (registry.ok) {
    swapDone(swap, () => dropUpdateSidecar(root, record));
    return true;
  }
  swapBack(swap, { keepIncoming: isPendingKind(record.kind) });
  clearUpdateSidecar(root, record);
  return false;
}

/** An update's pending sidecar, which recovery clears or deletes with its backup: none for a theme. */
function updateSidecar(root: string, record: UpdateRecord): string | null {
  const incoming = incomingFor(root, record.kind, record.slug);
  return incoming ? incoming.sidecar : null;
}

/** The update is back in pending: its sidecar keeps what it replaces, without the registration. */
function clearUpdateSidecar(root: string, record: UpdateRecord): void {
  const sidecar = updateSidecar(root, record);
  if (sidecar) clearRecord(sidecar);
}

/** The update is done: its sidecar goes, unless a pending folder of the same name is there again. */
function dropUpdateSidecar(root: string, record: UpdateRecord): void {
  const incoming = incomingFor(root, record.kind, record.slug);
  if (incoming && !pathExists(incoming.folder)) fs.rmSync(incoming.sidecar, { force: true });
}

/** Carry out one item of a plan. The caller holds both locks and has checked them. */
function actOn(root: string, item: RecoveryItem): void {
  const target = path.join(/* turbopackIgnore: true */ root, item.path);
  switch (item.action) {
    case "return-to-pending": {
      const where = pendingLocation(root, item.kind as PendingKind, item.slug!);
      const live = liveLocation(root, item.kind as PendingKind, item.slug!);
      fs.renameSync(live.dir, where.folder);
      clearRecord(where.sidecar);
      return;
    }
    case "clear-record":
      clearRecord(pendingLocation(root, item.kind as PendingKind, item.slug!).sidecar);
      return;
    case "drop-record":
      fs.rmSync(pendingLocation(root, item.kind as PendingKind, item.slug!).sidecar, { force: true });
      return;
    case "drop-folder":
      fs.rmSync(pendingLocation(root, item.kind as PendingKind, item.slug!).folder, {
        recursive: true,
        force: true,
      });
      return;
    case "drop-pending": {
      const where = pendingLocation(root, item.kind as PendingKind, item.slug!);
      fs.rmSync(where.folder, { recursive: true, force: true });
      fs.rmSync(where.sidecar, { force: true });
      return;
    }
    case "drop-staging":
    case "drop-temp":
      fs.rmSync(target, { recursive: true, force: true });
      return;
    case "resolve-by-hand":
      return;
    case "restore-backup": {
      const where = backupLocation(root, item.kind!, item.slug!);
      const live = extensionFolder(root, item.kind!, item.slug!);
      fs.mkdirSync(path.dirname(live.dir), { recursive: true });
      fs.renameSync(where.folder, live.dir);
      fs.rmSync(where.record, { force: true });
      return;
    }
    case "finish-removal": {
      // The folder first: a record without its folder is what recovery
      // clears, and a backup without its record is left for a person.
      const where = backupLocation(root, item.kind!, item.slug!);
      fs.rmSync(where.folder, { recursive: true, force: true });
      fs.rmSync(where.record, { force: true });
      return;
    }
    case "clear-backup-record":
    case "drop-backup-record":
      fs.rmSync(backupLocation(root, item.kind!, item.slug!).record, { force: true });
      return;
    case "restore-update":
    case "finish-update":
    case "clear-update-record": {
      const where = backupLocation(root, item.kind!, item.slug!);
      const read = readBackupRecord(where.record);
      if (read.state !== "ok" || read.record.operation !== "update") return;
      const record = read.record;
      if (item.action === "restore-update") {
        swapBack(swapFor(root, record), { keepIncoming: isPendingKind(record.kind) });
        clearUpdateSidecar(root, record);
      } else if (item.action === "finish-update") {
        // As the update would have finished: the sidecar, then the backup,
        // then the record.
        dropUpdateSidecar(root, record);
        fs.rmSync(where.folder, { recursive: true, force: true });
        fs.rmSync(where.record, { force: true });
      } else {
        fs.rmSync(where.record, { force: true });
        clearUpdateSidecar(root, record);
      }
      return;
    }
    case "keep-update":
      // Run by recoverCheckout() itself, since it runs the generator.
      return;
  }
}

/** Rewrite a sidecar without its registration record. */
function clearRecord(file: string): void {
  const read = readSidecar(file);
  if (read.state !== "ok") return;
  const { register: _done, ...rest } = read.sidecar;
  void _done;
  writeSidecar(file, rest);
}
