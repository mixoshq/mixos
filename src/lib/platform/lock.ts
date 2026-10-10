/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A cross-instance mutual exclusion for privileged, instance-wide operations.
 *
 * The case that motivated it: registering an extension writes a directory into
 * `apps/`, `connectors/` or `themes/` and then re-runs
 * `scripts/generate-project-registry.ts`, which rewrites the shared
 * `src/generated/*.ts` modules. Two admins registering at the same time produce
 * two concurrent generator processes writing the same three files — and the
 * rollback path, which removes a rejected directory and regenerates, runs on
 * top of whatever the other one has just written. Neither admin did anything
 * wrong and the registry ends up describing neither state.
 *
 * ── WHY NOT pg_advisory_lock ────────────────────────────────────────────────
 *
 * Postgres has advisory locks and they are the wrong tool here twice over.
 * Session-scoped locks do not survive a transaction pooler — Supabase's runs in
 * transaction mode, so the acquire and the release can land on different
 * backends, which is the deployment this project actually targets. And the
 * transaction-scoped variant, which does survive pooling, only lasts as long as
 * the transaction: a register holds this across a network download and a child
 * process, and holding a database transaction open for that is its own problem.
 *
 * So the lock is a row with an expiry, per
 * `supabase/migrations/0007_platform_schema_version.sql`. A row because it has
 * to outlive a connection, and an expiry because it has to self-heal when the
 * holder dies mid-operation without releasing.
 *
 * ── A LEASE, RENEWED AND FENCED ─────────────────────────────────────────────
 *
 * The expiry makes the row a lease: once it has gone `ttlSeconds` without being
 * renewed, anyone may take it, so a crashed holder does not wedge the feature
 * until someone finds the row. But nothing can interrupt the holder it was taken
 * from, and a holder can be paused for longer than any TTL: a laptop running
 * `next dev` goes to sleep mid-download, or the terminal running it gets a
 * Ctrl-Z. When it resumes it carries on from where it was, and by then the lock
 * may be someone else's.
 *
 * So a holder does two things while it works. It renews the lease every minute,
 * which keeps a live holder's lock from lapsing however long the work takes. And
 * immediately before each change the lock protects, it calls
 * `lease.assertHeld()`, which renews the lease only while the row still names
 * this acquisition, and throws `LockLostError` when it does not. A holder that
 * resumes after losing the lock stops at its next `assertHeld()`, before it
 * touches anything the new holder is working on.
 *
 * `acquired_at` therefore means "last known alive": acquiring sets it, and so
 * does every renewal.
 *
 * Renewal also makes the holder's own time limits the lock's. A holder that
 * hangs while its process stays up keeps renewing, and keeps the lock, so
 * everything that runs under it needs a limit of its own. The install path's
 * are its download timeouts and the generator's, which ends the generator's
 * whole process group.
 */

import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db/client";

/** Named so that two unrelated operations do not serialise against each other. */
export type LockName = "repository.register";

/**
 * Many renewals long, so a database that drops a few cannot cost a live holder
 * its lock; short enough that a crashed holder's row clears itself.
 */
const DEFAULT_TTL_SECONDS = 15 * 60;

/** Well inside the TTL, so a live holder's lease never comes near lapsing. */
const DEFAULT_RENEW_EVERY_MS = 60_000;

export class LockUnavailableError extends Error {
  constructor(readonly lock: LockName) {
    super(
      `Another administrator is already running this operation on this ` +
        `instance. Wait for it to finish and try again.`,
    );
    this.name = "LockUnavailableError";
  }
}

/**
 * The lock is no longer this holder's: it lapsed and was taken over, or its
 * row was removed. Thrown by `assertHeld()`, and final — the token that named
 * this acquisition can never name it again.
 */
export class LockLostError extends Error {
  constructor(readonly lock: LockName) {
    super(
      `This operation no longer holds the ${lock} lock. It went longer than the ` +
        `lock's expiry without renewing it, and the lock was taken over or cleared.`,
    );
    this.name = "LockLostError";
  }
}

/** What `fn` is handed while it holds the lock. */
export interface PlatformLease {
  /**
   * Renew the lease, or throw `LockLostError` if it is no longer this holder's.
   *
   * Call it immediately before every change the lock protects. After a
   * `LockLostError`, change nothing more, cleanup included: once the lock is
   * someone else's, so may be the files a cleanup would remove. Any other
   * error means the lease could not be confirmed, and calls for the same.
   */
  assertHeld(): Promise<void>;
}

export interface PlatformLockOptions {
  /** How long another holder's lease must have gone unrenewed before this one takes it over. */
  ttlSeconds?: number;
  /** How often this holder renews its own lease. */
  renewEveryMs?: number;
}

/**
 * Run `fn` while holding `name`, or throw `LockUnavailableError`.
 *
 * The release is in a `finally` and is scoped to this acquisition's own token,
 * so a holder that overran its TTL and had the lock taken from it cannot delete
 * the new holder's row on its way out. A release that fails is logged and
 * swallowed: `fn` has already run, its result is what the caller asked for, and
 * the TTL is what makes a leaked row temporary.
 */
export async function withPlatformLock<T>(
  name: LockName,
  fn: (lease: PlatformLease) => Promise<T>,
  {
    ttlSeconds = DEFAULT_TTL_SECONDS,
    renewEveryMs = DEFAULT_RENEW_EVERY_MS,
  }: PlatformLockOptions = {},
): Promise<T> {
  const holder = randomUUID();

  // Insert, or steal a row whose holder has passed its TTL. The `where` on the
  // conflict target is what makes this a try-lock: when the existing row is
  // still live, no row is updated and none is returned.
  const acquired = (await sql`
    insert into public._platform_locks (name, holder, acquired_at)
    values (${name}, ${holder}, now())
    on conflict (name) do update
      set holder = excluded.holder,
          acquired_at = excluded.acquired_at
      where public._platform_locks.acquired_at
            < now() - make_interval(secs => ${ttlSeconds})
    returning holder
  `) as unknown as { holder: string }[];

  if (acquired.length === 0) {
    throw new LockUnavailableError(name);
  }

  // Renewing and checking are one statement. It moves the expiry forward only
  // while the row still names this acquisition, so it can never take back a
  // lock that has passed to someone else — and a lease that lapsed but that
  // nobody took is still this holder's, which is right: nobody else has acted
  // on it.
  let lost = false;
  const renew = async (): Promise<boolean> => {
    if (lost) return false;
    const rows = (await sql`
      update public._platform_locks
      set acquired_at = now()
      where name = ${name} and holder = ${holder}
      returning 1 as held
    `) as unknown as { held: number }[];
    if (rows.length === 0) lost = true;
    return !lost;
  };

  let renewing = false;
  const timer = setInterval(() => {
    // assertHeld() found it gone first, and said so to its caller.
    if (lost) {
      clearInterval(timer);
      return;
    }
    // One at a time: a database slow enough to overlap renewals should not
    // also collect a queue of them.
    if (renewing) return;
    renewing = true;
    renew()
      .then((held) => {
        if (held) return;
        clearInterval(timer);
        console.warn(
          `[platform-lock] ${name} was taken over or cleared while this holder ` +
            `was still running; it stops at its next check.`,
        );
      })
      .catch((err) => {
        // Not fatal. The next renewal may get through, and assertHeld() is
        // what decides before anything changes.
        console.error(`[platform-lock] failed to renew ${name}:`, err);
      })
      .finally(() => {
        renewing = false;
      });
  }, renewEveryMs);

  const lease: PlatformLease = {
    async assertHeld() {
      if (!(await renew())) throw new LockLostError(name);
    },
  };

  try {
    return await fn(lease);
  } finally {
    clearInterval(timer);
    try {
      await sql`
        delete from public._platform_locks
        where name = ${name} and holder = ${holder}
      `;
    } catch (err) {
      // Loud, but not fatal — see the doc comment. The TTL bounds the damage.
      console.error(`[platform-lock] failed to release ${name}:`, err);
    }
  }
}
