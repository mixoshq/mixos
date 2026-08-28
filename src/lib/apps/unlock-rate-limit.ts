/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Brute-force protection for app password unlock attempts.
 *
 * Keys failures by `${ip}::${appSlug}` so a single bad IP cannot lock everyone
 * out of every app, and one attacker cannot use one IP across many apps to
 * stay under a global rate limit.
 *
 * Window: 5 wrong attempts within 15 minutes triggers a 1-hour lockout for
 * that IP+app pair. The lockout is checked BEFORE bcrypt is invoked and
 * BEFORE the (cheaper) rate-limit token consumption — so a locked-out
 * attacker can't drain limiter budget or extract timing signal from the
 * password comparison. Successful unlocks clear the counter for that key.
 *
 * Storage is in-process memory, which is the same limitation that already
 * applies to `src/lib/rate-limit.ts`. Acceptable today because the app
 * deploys as a single Next.js process; would need to move to Redis (along
 * with the existing limiter) if/when we shard.
 */

interface FailureWindow {
  /** Failed attempts within the current rolling window. */
  count: number;
  /** Epoch ms — when the current window started. */
  windowStart: number;
  /** Epoch ms — unlock time. 0 means "not currently locked". */
  lockedUntil: number;
  /** Epoch ms of the last write — used for stale-entry eviction. */
  lastTouch: number;
}

const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 60 * 60 * 1000;
const EVICT_INTERVAL_MS = 5 * 60 * 1000;
// Evict entries that are well past both window and lockout — i.e. no
// meaningful information remains. Picking 2× the lockout duration is
// conservative enough that a slow attacker can't reset their counter by
// pausing between attempts.
const STALE_MS = LOCKOUT_MS * 2;

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
  // Double-colon separator: app slugs are [a-z0-9_-]+ (no colons) and an
  // IPv6 address can contain single colons. Using `::` keeps the boundary
  // unambiguous without escaping.
  return `${ip}::${appSlug}`;
}

export type UnlockAttemptCheck =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

/**
 * Call BEFORE doing the bcrypt password comparison. Returns whether this
 * IP+app pair is currently locked out. Does NOT consume a counter — that
 * happens via `recordUnlockFailure` after a wrong password is confirmed.
 */
export function checkUnlockAttempt(ip: string, appSlug: string): UnlockAttemptCheck {
  const now = Date.now();
  evictStale(now);
  const entry = store.get(makeKey(ip, appSlug));
  if (entry && entry.lockedUntil > now) {
    return { allowed: false, retryAfterMs: entry.lockedUntil - now };
  }
  return { allowed: true };
}

/**
 * Call after a wrong-password attempt. Increments the rolling-window
 * counter; once the threshold is reached the entry is marked locked for
 * the lockout duration. Logs each failure to the server console so abuse
 * is observable without external tooling.
 */
export function recordUnlockFailure(ip: string, appSlug: string): void {
  const now = Date.now();
  const k = makeKey(ip, appSlug);
  let entry = store.get(k);

  if (!entry || now - entry.windowStart > FAILURE_WINDOW_MS) {
    entry = { count: 1, windowStart: now, lockedUntil: 0, lastTouch: now };
    store.set(k, entry);
  } else {
    entry.count += 1;
    entry.lastTouch = now;
  }

  if (entry.count >= MAX_FAILURES) {
    entry.lockedUntil = now + LOCKOUT_MS;
  }

  const status = entry.lockedUntil > now ? " LOCKED" : "";
  console.warn(
    `[unlock] failed attempt app=${appSlug} ip=${ip} count=${entry.count}${status}`,
  );
}

/** Call after a successful unlock so the user isn't penalized for prior typos. */
export function clearUnlockFailures(ip: string, appSlug: string): void {
  store.delete(makeKey(ip, appSlug));
}

/** Test-only / dev-only — clears the whole store. Not exported from package. */
export function _resetUnlockStoreForTests(): void {
  store.clear();
  lastEvict = Date.now();
}
