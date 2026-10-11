/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The checkout lock: `.mixos/lock`, one file that every operation changing what
 * this checkout builds holds while it works.
 *
 * Installing, registering, discarding, recovering and the registry generator
 * all change the same things: `.mixos/`, `apps/`, `connectors/`, `themes/` and
 * the `src/generated/` modules the build compiles. Two of them at once would
 * interleave, and the registry would describe neither.
 *
 * ── WHY A FILE, AS WELL AS THE ROW LOCK ─────────────────────────────────────
 *
 * Install and Register also hold `repository.register` (./lock.ts), a row in
 * the database, which admins on every instance using that database share. It
 * can't serialise one checkout on its own: two processes can find different
 * databases for it. `npm run register` reads the shell's environment, then
 * `.env.local`, then the Docker stack's (scripts/load-env.ts), and a dev server
 * in a container reads its own, so a shell on the host and a dev server in a
 * container can each hold "the" row lock in a different database while
 * changing one checkout. And the generator, which `npm run dev`, `npm run
 * build` and `npm run registry` start, uses no database at all.
 *
 * ── THE FILE ────────────────────────────────────────────────────────────────
 *
 * Created with O_EXCL, so of two processes creating it at once exactly one
 * succeeds, and holding one line of JSON: the holder's pid, its hostname, a
 * random token, what it is, for the message another process shows, and since
 * when.
 *
 * ── WHEN IT IS STALE ────────────────────────────────────────────────────────
 *
 * Only when its hostname is this machine's and its pid isn't running. Its
 * holder is gone then, and the next process that wants the lock takes it over.
 * A lock from another hostname is never taken over: a pid says nothing about a
 * process in another container, which may well be running. Nor is a lock file
 * that can't be read. `npm run register -- --break-lock` shows either one and
 * asks before removing it.
 *
 * ── FENCED ──────────────────────────────────────────────────────────────────
 *
 * A holder can be suspended, and its lock broken by hand while it is. So, as
 * with the row lock, a holder calls `assertHeld()` before each change to the
 * disk. It reads the file back and throws CheckoutLockLostError unless the file
 * still holds this holder's token.
 *
 * ── A CHILD OF A HOLDER ─────────────────────────────────────────────────────
 *
 * A holder that runs the generator passes its token in the generator's
 * arguments, `--lock-token <token>`, since the generator's environment is only
 * `PATH` and `TMPDIR`. The generator checks the file holds that token, works
 * under its parent's lock, and leaves the file to its parent
 * (adoptCheckoutLock()).
 *
 * Node built-ins only: the registry generator imports this, and so does the
 * server.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Who holds the lock, as its file says. */
export interface CheckoutLockHolder {
  pid: number;
  hostname: string;
  token: string;
  /** What holds it, for a person: "the registry generator", "npm run register". */
  purpose: string;
  /** When it was taken, ISO 8601. */
  since: string;
}

/** What `.mixos/lock` holds right now. */
export interface CheckoutLockState {
  /** Absolute path of the lock file. */
  file: string;
  exists: boolean;
  /** The file's text, when it could be read. */
  raw: string | null;
  /** Its holder, or null when there is no file or it can't be read as one. */
  holder: CheckoutLockHolder | null;
}

/** A lock this process holds, or works under (adoptCheckoutLock()). */
export interface CheckoutLock {
  readonly file: string;
  readonly token: string;
  readonly holder: CheckoutLockHolder;
  /** The stale lock this one replaced, when it took one over. */
  readonly tookOver: CheckoutLockHolder | null;
  /**
   * Throw CheckoutLockLostError unless `.mixos/lock` still holds this token.
   * Call it immediately before every change the lock protects.
   */
  assertHeld(): void;
  /** Remove the file, if it is still this lock's. Safe to call twice. */
  release(): void;
}

/** The directory every checkout operation keeps its state in. */
export const MIXOS_DIR_NAME = ".mixos";

/** The largest lock file this reads; anything bigger was not written by a holder. */
const MAX_LOCK_BYTES = 4096;

/** The holder this message describes, made safe to print: no control or bidi characters. */
const UNPRINTABLE = /[\p{Cc}\p{Bidi_Control}\p{Zl}\p{Zp}]/gu;
const printable = (s: string) => s.replace(UNPRINTABLE, "?").slice(0, 200);

export function checkoutLockFile(root: string): string {
  // A runtime path, never a file a build should carry: marked so the tracer
  // leaves it alone (see src/lib/repository/pending.ts).
  return path.join(/* turbopackIgnore: true */ root, MIXOS_DIR_NAME, "lock");
}

/** Someone else holds the lock. */
export class CheckoutLockHeldError extends Error {
  constructor(
    readonly holder: CheckoutLockHolder | null,
    readonly file: string,
  ) {
    super(heldMessage(holder));
    this.name = "CheckoutLockHeldError";
  }
}

/** The lock is no longer this holder's: broken by hand, or replaced. */
export class CheckoutLockLostError extends Error {
  constructor(
    readonly file: string,
    readonly now: CheckoutLockHolder | null,
  ) {
    super(
      `This operation no longer holds the checkout lock (.mixos/lock): it was ` +
        `broken or replaced while the operation ran` +
        (now ? `, and ${describeCheckoutLockHolder(now)} holds it now.` : "."),
    );
    this.name = "CheckoutLockLostError";
  }
}

/** Whether `pid` names a running process. One owned by another user counts. */
export function pidRunning(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether a lock's holder is certainly gone: it is on this machine and its pid
 * isn't running. Never true for another machine's lock.
 */
export function isStaleHolder(
  holder: CheckoutLockHolder,
  here: string = os.hostname(),
  running: (pid: number) => boolean = pidRunning,
): boolean {
  return holder.hostname === here && !running(holder.pid);
}

/** "the registry generator, pid 123 on this machine, since 10:42:07". */
export function describeCheckoutLockHolder(
  holder: CheckoutLockHolder,
  here: string = os.hostname(),
): string {
  const since = new Date(holder.since);
  const when = Number.isNaN(since.getTime())
    ? ""
    : `, since ${since.toLocaleString(undefined, { hour12: false })}`;
  const where = holder.hostname === here ? "this machine" : `another machine, ${printable(holder.hostname)}`;
  return `${printable(holder.purpose)} (pid ${holder.pid} on ${where}${when})`;
}

function heldMessage(holder: CheckoutLockHolder | null): string {
  if (!holder) {
    return (
      "This checkout is locked (.mixos/lock), and the lock file can't be read. If no " +
      "install, registration or registry generator is running in this checkout, run " +
      "`npm run register -- --break-lock`."
    );
  }
  const foreign = holder.hostname !== os.hostname();
  return (
    `This checkout is locked by ${describeCheckoutLockHolder(holder)}. Try again when it finishes.` +
    (foreign
      ? " A lock from another machine, such as a dev container, is never broken " +
        "automatically: if that process has stopped, run `npm run register -- --break-lock`."
      : "")
  );
}

/** The holder a lock file's text names, or null when it names none. */
export function parseCheckoutLockHolder(text: string): CheckoutLockHolder | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (typeof o.pid !== "number" || !Number.isSafeInteger(o.pid) || o.pid <= 0) return null;
  if (typeof o.hostname !== "string" || !o.hostname) return null;
  if (typeof o.token !== "string" || o.token.length < 16) return null;
  return {
    pid: o.pid,
    hostname: o.hostname,
    token: o.token,
    purpose: typeof o.purpose === "string" && o.purpose ? o.purpose : "an unnamed process",
    since: typeof o.since === "string" ? o.since : "",
  };
}

/** A file's text, never through a link, and only when it is small enough to be a lock. */
function readSmallFile(file: string): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_LOCK_BYTES) return "";
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/** What `<root>/.mixos/lock` holds right now. */
export function readCheckoutLock(root: string): CheckoutLockState {
  const file = checkoutLockFile(root);
  let raw: string;
  try {
    raw = readSmallFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { file, exists: false, raw: null, holder: null };
    }
    // A link, or a file this process can't read: there, and nobody's.
    return { file, exists: true, raw: null, holder: null };
  }
  return { file, exists: true, raw, holder: parseCheckoutLockHolder(raw) };
}

/**
 * Create the file with O_EXCL. False when it already exists. O_EXCL also refuses
 * a link at the path, dangling or not, so a link can't redirect the write.
 */
function create(file: string, holder: CheckoutLockHolder): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o644);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try {
    fs.writeSync(fd, `${JSON.stringify(holder)}\n`);
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(file, { force: true });
    throw err;
  }
  fs.closeSync(fd);
  return true;
}

/**
 * The lock as another process sees it, read a second time after a moment when
 * the first read found a file with nothing in it yet: its creator is between
 * creating it and writing it.
 */
function settledState(root: string): CheckoutLockState {
  const state = readCheckoutLock(root);
  if (!state.exists || state.holder) return state;
  // Node lets the main thread wait on an Atomics cell, which makes a short
  // synchronous sleep. This path runs only when a lock appeared in the same
  // instant as this read.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  return readCheckoutLock(root);
}

/**
 * Remove the stale lock `stale`, and only that one. It is renamed aside first
 * and compared: a lock someone else made after `stale` was read is put back
 * rather than removed. Throws CheckoutLockHeldError when that happened.
 */
function takeOver(file: string, stale: CheckoutLockHolder): void {
  const claim = `${file}.stale-${randomUUID()}`;
  try {
    fs.renameSync(file, claim);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  let moved: CheckoutLockHolder | null = null;
  try {
    moved = parseCheckoutLockHolder(readSmallFile(claim));
  } catch {
    // Unreadable: not the stale lock this read.
  }
  if (moved?.token === stale.token) {
    fs.rmSync(claim, { force: true });
    return;
  }
  // Someone took the stale lock over first and made their own. Put theirs
  // back, unless something took its place meanwhile; then its holder finds it
  // gone at its next check, and stops.
  try {
    fs.linkSync(claim, file);
  } catch {
    // See above.
  }
  fs.rmSync(claim, { force: true });
  throw new CheckoutLockHeldError(moved, file);
}

function lockHandle(
  root: string,
  holder: CheckoutLockHolder,
  tookOver: CheckoutLockHolder | null,
  owned: boolean,
): CheckoutLock {
  const file = checkoutLockFile(root);
  let released = false;
  return {
    file,
    token: holder.token,
    holder,
    tookOver,
    assertHeld() {
      const now = readCheckoutLock(root);
      if (released || now.holder?.token !== holder.token) {
        throw new CheckoutLockLostError(file, now.holder);
      }
    },
    release() {
      if (released) return;
      released = true;
      if (!owned) return;
      if (readCheckoutLock(root).holder?.token === holder.token) {
        fs.rmSync(file, { force: true });
      }
    },
  };
}

/**
 * Take the lock now, or throw CheckoutLockHeldError naming who holds it. A
 * stale lock (isStaleHolder()) is taken over, and the result says whose it was.
 */
export function tryAcquireCheckoutLock(root: string, purpose: string): CheckoutLock {
  const file = checkoutLockFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let tookOver: CheckoutLockHolder | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const holder: CheckoutLockHolder = {
      pid: process.pid,
      hostname: os.hostname(),
      token: randomUUID(),
      purpose,
      since: new Date().toISOString(),
    };
    if (create(file, holder)) return lockHandle(root, holder, tookOver, true);

    const state = settledState(root);
    // Released between the create and the read: try again.
    if (!state.exists) continue;
    if (!state.holder || !isStaleHolder(state.holder)) {
      throw new CheckoutLockHeldError(state.holder, file);
    }
    takeOver(file, state.holder);
    tookOver = state.holder;
  }
  throw new CheckoutLockHeldError(readCheckoutLock(root).holder, file);
}

export interface AcquireCheckoutLockOptions {
  /** How long to keep trying while someone else holds it. 0, the default, is not at all. */
  waitMs?: number;
  /** How often to look again while waiting. */
  pollMs?: number;
  /** Told each holder this waits on, once. */
  onWait?: (holder: CheckoutLockHolder | null) => void;
}

/** tryAcquireCheckoutLock(), trying again for up to `waitMs`. */
export async function acquireCheckoutLock(
  root: string,
  purpose: string,
  { waitMs = 0, pollMs = 250, onWait }: AcquireCheckoutLockOptions = {},
): Promise<CheckoutLock> {
  const deadline = Date.now() + waitMs;
  let told: string | undefined;
  for (;;) {
    try {
      return tryAcquireCheckoutLock(root, purpose);
    } catch (err) {
      if (!(err instanceof CheckoutLockHeldError) || Date.now() >= deadline) throw err;
      const key = err.holder?.token ?? "";
      if (key !== told) {
        told = key;
        onWait?.(err.holder);
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(10, Math.min(pollMs, deadline - Date.now()))),
      );
    }
  }
}

/** Run `fn` holding the lock, or throw CheckoutLockHeldError without running it. */
export async function withCheckoutLock<T>(
  root: string,
  purpose: string,
  fn: (lock: CheckoutLock) => Promise<T>,
): Promise<T> {
  const lock = tryAcquireCheckoutLock(root, purpose);
  try {
    return await fn(lock);
  } finally {
    lock.release();
  }
}

/**
 * Work under the lock a parent process holds, named by its token. Throws
 * CheckoutLockLostError when the file doesn't hold that token. The handle's
 * `release()` leaves the file alone: it is the parent's.
 */
export function adoptCheckoutLock(root: string, token: string): CheckoutLock {
  const state = readCheckoutLock(root);
  if (!state.holder || state.holder.token !== token) {
    throw new CheckoutLockLostError(state.file, state.holder);
  }
  return lockHandle(root, state.holder, null, false);
}

/**
 * Remove the lock file, but only while it still reads `raw`, byte for byte:
 * what a person was shown and agreed to break. `raw` is null for a file that
 * couldn't be read when shown, which is removed only while that is still so.
 * Renamed aside and compared first, as a takeover is, so a lock taken since is
 * put back. Returns whether it was removed.
 */
export function breakCheckoutLock(root: string, raw: string | null): boolean {
  const file = checkoutLockFile(root);
  const claim = `${file}.broken-${randomUUID()}`;
  try {
    fs.renameSync(file, claim);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  let moved: string | null = null;
  try {
    moved = readSmallFile(claim);
  } catch {
    // Unreadable, as a link or a file this process may not read is.
  }
  if (moved === raw) {
    fs.rmSync(claim, { force: true });
    return true;
  }
  try {
    fs.linkSync(claim, file);
  } catch {
    // Something took its place; its holder finds it gone at its next check.
  }
  fs.rmSync(claim, { force: true });
  return false;
}
