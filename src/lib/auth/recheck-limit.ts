/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The limit on re-checking a signed-in person's own password.
 *
 * WHERE. Two server actions ask the person already signed in for their own
 * password and compare it with a bcrypt hash:
 *
 *   - "Change my password" (`updatePassword`, src/lib/account/actions.ts)
 *     checks the current password;
 *   - "Set a user's password" (`adminSetPassword`,
 *     src/lib/admin/user-actions.ts) checks the acting admin's password, which
 *     is what keeps someone at an admin's unlocked laptop from taking over
 *     another account.
 *
 * Both re-check the same secret, the acting user's password, so they share one
 * budget per user. With two budgets, whoever holds the session would get twice
 * the guesses.
 *
 * THE KEY is the user id from the session. The session already says whose
 * password is being guessed, and it can be used from any address, so an IP
 * key would add nothing.
 *
 * CHARGED FIRST, right or wrong, as the sign-in limit is (./sign-in-limit.ts).
 * A refused attempt runs no hash, and its answer is the same whether the
 * password was right.
 */

import { createRateLimiter, type RateLimiterOptions } from "@/lib/rate-limit";
import { verifyPassword } from "./password";

/** What a refused re-check tells the person. */
export const RECHECK_LIMITED_MESSAGE = "Too many attempts. Please try again shortly.";

/**
 * 5 attempts in a burst, then one more every 5 minutes. A person who mistypes
 * has five tries; someone guessing gets 12 an hour. A full bucket refills in
 * 25 minutes, inside the hour after which idle buckets are pruned
 * (`pruneRateBuckets`).
 *
 * `user_app` is the scope keyed by a user. The name keeps these rows apart
 * from the app gateway's (user, app) buckets.
 */
export const RECHECK_LIMIT: RateLimiterOptions = {
  scope: "user_app",
  name: "password-recheck",
  maxTokens: 5,
  refillRatePerSecond: 1 / 300,
};

const recheckLimiter = createRateLimiter(RECHECK_LIMIT);

export type RecheckResult = "ok" | "wrong" | "limited";

/**
 * Re-check `userId`'s own password against `hash`, charging their budget
 * first. `verify` is swappable so a test can count the hashes.
 */
export async function recheckOwnPassword(
  userId: string,
  plaintext: string,
  hash: string,
  verify: (plaintext: string, hash: string) => Promise<boolean> = verifyPassword,
): Promise<RecheckResult> {
  const limit = await recheckLimiter.consume(userId);
  if (!limit.allowed) return "limited";
  return (await verify(plaintext, hash)) ? "ok" : "wrong";
}
