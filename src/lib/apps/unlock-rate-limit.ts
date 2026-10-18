/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Brute-force protection for app password unlock attempts.
 *
 * Keys failures by `${ip}::${appSlug}` so a single bad IP cannot lock everyone
 * out of every app, and one attacker cannot spread attempts across many apps to
 * stay under a threshold.
 *
 * Policy: 5 wrong passwords within 15 minutes locks that IP+app pair for an
 * hour. Checked BEFORE bcrypt is invoked, so a locked-out attacker cannot pin
 * CPU on cost-12 hashing or extract timing signal from the comparison. A correct
 * password clears the row, so a user is not penalised for earlier typos.
 *
 * ── Why this is not `rate_buckets` ──────────────────────────────────────────
 * A token bucket charges every call and refills continuously. This charges only
 * FAILURES and resets on success, and a lockout is a cliff rather than a slope.
 * Forcing one into the other would mean either charging honest unlocks or
 * turning the lockout into a drip.
 *
 * ── Two tiers, and why the asymmetry is sound ───────────────────────────────
 * Postgres is the authority; the in-process `Map` is a pre-filter. Memory alone,
 * on a serverless deployment, is close to no control: each instance counts
 * separately, so the real allowance would be five failures *per instance*
 * across a fleet that grows with the attack.
 *
 * The pre-filter is safe for the same reason `src/lib/rate-limit.ts` gives:
 *
 *   · memory says LOCKED → this instance alone already saw the threshold, so
 *     the global count is at least that. Short-circuit; no round trip.
 *   · memory says OK     → proves nothing, since other instances saw failures
 *     this one did not. Consult Postgres.
 *
 * An instance that has just started knows nothing, so it can only ever be too
 * permissive. It can never lock someone out on its own.
 *
 * ── Failing open, deliberately ──────────────────────────────────────────────
 * If Postgres is unreachable the lockout falls back to the in-memory result —
 * the behaviour this module had entirely, so a rarer exposure rather than a new
 * one. Note what still stands in the attacker's way: bcrypt at cost 12 is
 * ~250ms of CPU per guess whether or not this table is reachable.
 */

import { sql } from "@/lib/db/client";

const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 60 * 60 * 1000;
const EVICT_INTERVAL_MS = 5 * 60 * 1000;
/** 2x the lockout: past this, no meaningful information remains in the entry. */
const STALE_MS = LOCKOUT_MS * 2;

const WINDOW_SECONDS = FAILURE_WINDOW_MS / 1000;
const LOCKOUT_SECONDS = LOCKOUT_MS / 1000;

interface FailureWindow {
  count: number;
  windowStart: number;
  /** Epoch ms. 0 means "not currently locked". */
  lockedUntil: number;
  lastTouch: number;
}

const store = new Map<string, FailureWindow>();
let lastEvict = Date.now();

function evictStale(now: number) {
  if (now - lastEvict < EVICT_INTERVAL_MS) return;
  lastEvict = now;
  for (const [k, entry] of store) {
    if (now - entry.lastTouch > STALE_MS) store.delete(k);
  }
}

function makeKey(ip: string, appSlug: string): string {
  return `${ip}::${appSlug}`;
}

export type UnlockAttemptCheck =
  { allowed: true } | { allowed: false; retryAfterMs: number };

function checkMemory(key: string): UnlockAttemptCheck {
  const now = Date.now();
  evictStale(now);
  const entry = store.get(key);
  if (entry && entry.lockedUntil > now) {
    return { allowed: false, retryAfterMs: entry.lockedUntil - now };
  }
  return { allowed: true };
}

function recordMemory(key: string, appSlug: string, ip: string): void {
  const now = Date.now();
  let entry = store.get(key);

  if (
    !entry ||
    (entry.lockedUntil <= now && now - entry.windowStart > FAILURE_WINDOW_MS)
  ) {
    entry = { count: 1, windowStart: now, lockedUntil: 0, lastTouch: now };
    store.set(key, entry);
  } else if (entry.lockedUntil > now) {
    entry.lastTouch = now;
  } else {
    entry.count += 1;
    entry.lastTouch = now;
  }

  if (entry.lockedUntil <= now && entry.count >= MAX_FAILURES) {
    entry.lockedUntil = now + LOCKOUT_MS;
  }

  const status = entry.lockedUntil > now ? " LOCKED" : "";
  console.warn(
    `[unlock] failed attempt app=${appSlug} ip=${ip} count=${entry.count}${status}`,
  );
}

/**
 * Call BEFORE the bcrypt comparison. Does NOT count anything — a failure is
 * recorded by `recordUnlockFailure` once a wrong password is confirmed.
 */
export async function checkUnlockAttempt(
  ip: string,
  appSlug: string,
): Promise<UnlockAttemptCheck> {
  const key = makeKey(ip, appSlug);

  const memory = checkMemory(key);
  // The lenient tier saying "locked" means the strict one would too.
  if (!memory.allowed) return memory;

  try {
    const rows = (await sql`
      select extract(epoch from locked_until - now())::float8 as remaining
      from public.app_unlock_failures
      where subject = ${key} and locked_until > now()
    `) as unknown as { remaining: number }[];

    if (rows.length === 0) return { allowed: true };
    return {
      allowed: false,
      retryAfterMs: Math.max(0, Math.ceil(Number(rows[0].remaining) * 1000)),
    };
  } catch (err) {
    console.warn(
      "[unlock] postgres unavailable, falling back to in-memory:",
      err,
    );
    return memory;
  }
}

/**
 * Call after a wrong password is confirmed.
 *
 * The window arithmetic lives inside the `on conflict do update set`
 * expressions, which Postgres evaluates against the LOCKED current row. A CTE
 * or an `update ... from (select ...)` reads the statement snapshot instead and
 * is silently racy under concurrency — the same trap `rate-limit.ts` documents.
 *
 * Note the three branches are consistent across all three assignments: already
 * locked (hold everything steady, so hammering cannot extend a lockout or
 * inflate the counter), window rolled (start a fresh one), or counting (+1).
 * Only the counting branch can trip the lock, which is why `locked_until` can
 * test `f.failures + 1` without recomputing the whole `failures` expression.
 */
export async function recordUnlockFailure(
  ip: string,
  appSlug: string,
): Promise<void> {
  const key = makeKey(ip, appSlug);
  recordMemory(key, appSlug, ip);

  try {
    await sql`
      insert into public.app_unlock_failures as f
        (subject, failures, window_start, locked_until, updated_at)
      values (${key}, 1, now(), null, now())
      on conflict (subject) do update
      set failures = case
            when f.locked_until is not null and f.locked_until > now()
              then f.failures
            when now() - f.window_start > make_interval(secs => ${WINDOW_SECONDS})
              then 1
            else f.failures + 1
          end,
          window_start = case
            when f.locked_until is not null and f.locked_until > now()
              then f.window_start
            when now() - f.window_start > make_interval(secs => ${WINDOW_SECONDS})
              then now()
            else f.window_start
          end,
          locked_until = case
            when f.locked_until is not null and f.locked_until > now()
              then f.locked_until
            when now() - f.window_start <= make_interval(secs => ${WINDOW_SECONDS})
                 and f.failures + 1 >= ${MAX_FAILURES}
              then now() + make_interval(secs => ${LOCKOUT_SECONDS})
            else null
          end,
          updated_at = now()
    `;
  } catch (err) {
    // The in-memory counter above already recorded it. Losing the shared row is
    // a weaker control, not an absent one, and refusing the unlock outright
    // would take every password-protected app down with the database.
    console.warn(
      "[unlock] postgres unavailable, failure counted in-memory only:",
      err,
    );
  }
}

/** Call after a successful unlock so a user is not penalised for prior typos. */
export async function clearUnlockFailures(
  ip: string,
  appSlug: string,
): Promise<void> {
  const key = makeKey(ip, appSlug);
  store.delete(key);
  try {
    await sql`delete from public.app_unlock_failures where subject = ${key}`;
  } catch (err) {
    console.warn(
      "[unlock] postgres unavailable, could not clear failures:",
      err,
    );
  }
}

/**
 * Drop rows nobody has touched in twice the lockout window. Called from the
 * cron tick.
 *
 * THE INVARIANT, as with `pruneRateBuckets`: this retention must exceed the
 * lockout duration, or GC forgives an attacker mid-penalty. At 2x it has one
 * full lockout of headroom.
 */
export async function pruneUnlockFailures(): Promise<number> {
  try {
    const rows = (await sql`
      delete from public.app_unlock_failures
      where updated_at < now() - make_interval(secs => ${STALE_MS / 1000})
      returning 1 as pruned
    `) as unknown as { pruned: number }[];
    return rows.length;
  } catch (err) {
    console.warn("[unlock] failure prune failed:", err);
    return 0;
  }
}

/** Test-only — clears the in-process tier. */
export function _resetUnlockStoreForTests(): void {
  store.clear();
  lastEvict = Date.now();
}
