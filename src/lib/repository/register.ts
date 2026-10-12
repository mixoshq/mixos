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
 * The result hands back what to commit and how (./hand-back.ts): the folder's
 * files, a commit message built from the record, and the commands.
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
 * Recovery also deals with a removal that died midway (./remove.ts), from what
 * it left in `.mixos/backup/` (./backup.ts): it puts back a folder the registry
 * generator never accepted the checkout without, and finishes deleting one it
 * did. `npm run remove -- --recover` is the same recovery.
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
  readBackupRecord,
} from "./backup";
import { contentHashesMatch } from "./content-hash";
import { handBackFor, type HandBack } from "./hand-back";
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
  writeSidecar,
  type PendingKind,
  type PendingSidecar,
  type Registering,
} from "./pending";
import { installDisabledMessage, installEnabled } from "./policy";
import { SlugSchema, type ExtensionKind } from "./types";

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
  | "changed-meanwhile";

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
  /** What to do next, in a paragraph. */
  nextStep: string;
}

/**
 * Register a pending app or connector. Throws RegisterError, or a lock's
 * error, when it refuses; either way it is audited.
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
      },
    });
    throw err;
  }
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

  // 1. What is pending, its records, and nothing where it would go.
  const { sidecar, record } = pendingInstallFor(kind, slug, where);
  if (options.reviewedFilesHash !== undefined && !contentHashesMatch(options.reviewedFilesHash, record.filesHash)) {
    throw new RegisterError(
      `What is waiting in ${where.rel}/ isn't what you reviewed: it was discarded and installed ` +
        "again, or replaced, since. Nothing was moved. Review it again before registering it.",
      "changed-meanwhile",
    );
  }
  // A removal of the same name that stopped midway may have its folder in
  // `.mixos/backup/`, for recovery to put back where this would go.
  const leftover = leftoverBackup(root, kind, slug);
  if (leftover) {
    throw new RegisterError(
      `A removal of ${slug} stopped before it finished, and left ${leftover.rel}. Run ` +
        "`npm run remove -- --recover` to put things back, then try again.",
      "interrupted",
    );
  }
  if (pathExists(live.dir)) {
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
    // The hand-back says how to ship it; this says what it is now.
    nextStep:
      `Registered to ${live.rel}: the registry generator loaded its code and accepted it. ` +
      (kind === "app"
        ? "It is off until an admin activates it in Admin > Apps (run `npm run migrate:apps` " +
          "first if it has migrations)."
        : "Configure it in Admin > Connectors."),
  };
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
  | "drop-backup-record";

/** The actions about `.mixos/backup/`, which a removal leaves: audited as `<kind>.remove.recover`. */
const BACKUP_ACTIONS: ReadonlySet<RecoveryAction> = new Set([
  "restore-backup",
  "finish-removal",
  "clear-backup-record",
  "drop-backup-record",
]);

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
}

/**
 * What a stopped install, registration, discard or removal left in the
 * checkout at `root`, and what recovery would do about each. Reads only.
 */
export function planRecovery(root: string = checkoutRoot()): RecoveryItem[] {
  const items: RecoveryItem[] = [];
  const here = os.hostname();
  // Who holds the checkout lock now, unless its holder has certainly stopped: a
  // removal's record with that holder's token belongs to a removal still running.
  const holder = readCheckoutLock(root).holder;
  const liveHolder = holder && !isStaleHolder(holder) ? holder : null;

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
 * What a removal of `kind`/`slug` left in `.mixos/backup/` (./backup.ts), and
 * what recovery would do about it. The record's token says whose it is: one the
 * checkout lock holds now, from a holder that may still be running, is a
 * removal under way, which is left alone. Any other has stopped, or has lost
 * its lock and stops at its next check of it.
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
    const blocked =
      liveHolder?.token !== r.token
        ? null
        : liveHolder.hostname === os.hostname()
          ? `The removal that recorded it, pid ${r.pid} on this machine, is still running. Let it ` +
            "finish, or stop it, then run this again."
          : `The removal that recorded it holds this checkout's lock from another machine, ` +
            `${liveHolder.hostname.replace(/[^\x20-\x7e]/g, "?")}, which this can't check. If it has stopped, run ` +
            "`npm run register -- --break-lock`, then run this again.";
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

/** A plan's identity: two plans are the same when they would do the same things. */
function planKey(items: readonly RecoveryItem[]): string {
  return items.map((i) => `${i.action}:${i.path}:${i.blocked ? "blocked" : ""}`).join("\n");
}

export interface RecoverOptions extends PendingActionOptions {
  /** Shown what recovery found and would do; resolves to whether to go ahead. */
  confirm: (items: RecoveryItem[]) => Promise<boolean>;
  /** The command that asked, which the checkout lock names while recovery holds it. */
  command?: string;
}

export interface RecoverResult {
  /** Everything found. */
  items: RecoveryItem[];
  /** What was done. */
  acted: RecoveryItem[];
  /** Nothing was done because the answer was no. */
  cancelled: boolean;
  /** The registry generator's run, when recovery needed one. */
  regenerated: { ok: boolean; output: string } | null;
}

/**
 * Deal with what a stopped install, registration, discard or removal left.
 * Shows the plan and asks without holding a lock, then takes both, checks the
 * checkout is still as shown, and acts. Each pending install it acts on is
 * audited as `<kind>.register.recover`, and each removal's backup as
 * `<kind>.remove.recover`.
 */
export async function recoverCheckout(options: RecoverOptions): Promise<RecoverResult> {
  const root = options.root ?? checkoutRoot();
  const items = planRecovery(root);
  if (!items.some((i) => !i.blocked)) return { items, acted: [], cancelled: false, regenerated: null };
  if (!(await options.confirm(items))) return { items, acted: [], cancelled: true, regenerated: null };

  const purpose = options.command ?? "npm run register -- --recover";
  const { acted, regenerated } = await withPlatformLock("repository.register", (lease) =>
    withCheckoutLock(root, purpose, async (lock) => {
      tellTakeover(lock, options);
      const fence = fencer(bothLocks(lease, lock), "This recovery", options.signal);
      if (planKey(planRecovery(root)) !== planKey(items)) {
        throw new RegisterError(
          "The checkout changed while you were deciding, so nothing was done. Run it again to see what is there now.",
          "changed-meanwhile",
        );
      }

      const done: RecoveryItem[] = [];
      const soFar = () =>
        done.length === 0 ? "Nothing was changed." : `It had dealt with: ${done.map((d) => d.path).join(", ")}.`;
      let regenerate = false;
      for (const item of items) {
        if (item.blocked) continue;
        await fence(`${soFar()} Run it again to finish.`);
        actOn(root, item);
        if (["return-to-pending", "clear-record", "restore-backup", "clear-backup-record"].includes(item.action)) {
          regenerate = true;
        }
        done.push(item);
      }

      let regenerated: RecoverResult["regenerated"] = null;
      if (regenerate) {
        await fence(`${soFar()} Run \`npm run registry\` to regenerate the registry.`);
        const run = await runRegistryGenerator({
          lockToken: lock.token,
          root: options.root,
          generator: options.generator,
          signal: options.signal,
        });
        regenerated = { ok: run.code === 0, output: run.output };
      }
      return { acted: done, regenerated };
    }),
  );

  for (const item of acted) {
    if (!item.kind || !item.slug || item.action === "drop-staging" || item.action === "drop-temp") continue;
    await recordAdminAction(options.actor, {
      action: `${item.kind}.${BACKUP_ACTIONS.has(item.action) ? "remove" : "register"}.recover`,
      targetType: item.kind,
      targetId: item.slug,
      details: { via: options.via, action: item.action, path: item.path },
    });
  }
  return { items, acted, cancelled: false, regenerated };
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
