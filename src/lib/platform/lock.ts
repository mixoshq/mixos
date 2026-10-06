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
 * ── THE EXPIRY IS A CEILING, NOT A DEADLINE ─────────────────────────────────
 *
 * Nothing interrupts a holder when its lock expires — this is cooperative, and
 * an operation that overruns keeps running. What the expiry buys is that a
 * crashed holder does not wedge the feature until someone finds the row. Set it
 * comfortably above the slowest legitimate run: `regenerateRegistry` already
 * caps its child process at 120s, so a register cannot legitimately take
 * anywhere near the default below.
 */

import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db/client";

/** Named so that two unrelated operations do not serialise against each other. */
export type LockName = "repository.register";

/** Long enough that no honest register comes near it; short enough to self-heal. */
const DEFAULT_TTL_SECONDS = 15 * 60;

export class LockUnavailableError extends Error {
  constructor(
    readonly lock: LockName,
    /** How long the current holder has held it, in seconds. */
    readonly heldForSeconds: number,
  ) {
    super(
      `Another administrator is already running this operation on this ` +
        `instance (started ${Math.round(heldForSeconds)}s ago). Wait for it to ` +
        `finish and try again.`,
    );
    this.name = "LockUnavailableError";
  }
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
  fn: () => Promise<T>,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
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
    const rows = (await sql`
      select extract(epoch from (now() - acquired_at)) as held
      from public._platform_locks
      where name = ${name}
      limit 1
    `) as unknown as { held: string | number }[];
    throw new LockUnavailableError(name, Number(rows[0]?.held ?? 0));
  }

  try {
    return await fn();
  } finally {
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
