/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The per-IP limit on password sign-in attempts.
 *
 * WHERE IT IS CHARGED. Inside the password check itself, the credentials
 * provider's `authorize()` in ./config.ts, and not in front of any one route.
 * Two routes reach that check, and both draw on this one budget:
 *
 *   - the login page's server action, through Auth.js's `signIn()`;
 *   - Auth.js's own `POST /api/auth/callback/credentials`, which any client
 *     can call with a CSRF token from `/api/auth/csrf`.
 *
 * The limit used to live in the server action alone, so the second route
 * checked passwords with no limit at all. Charged here, it also covers
 * whatever reaches `authorize()` next.
 *
 * THE KEY is the client IP by the rule every limiter shares (`getClientIp`):
 * the last `x-forwarded-for` hop, then `x-real-ip`. Auth.js passes
 * `authorize()` a Request carrying the client's headers on both routes. On
 * the callback route they are the route's own request headers. On the
 * server-action path `signIn()` copies `headers()` into the Request it
 * builds, so the action's client is the one charged.
 *
 * A REFUSED ATTEMPT throws before the user row is read or a hash compared. It
 * is cheap, and it answers the same for a known and an unknown email. It
 * throws a `CredentialsSignin` with its own `code`. Auth.js's route answers it
 * in its usual form, a redirect to
 * `/login?error=CredentialsSignin&code=rate_limited`. On the server-action path
 * `signIn()` rethrows it, so the action can tell it from a wrong password.
 */

import { CredentialsSignin } from "next-auth";
import { getClientIp } from "@/lib/apps/public-access";
import { createRateLimiter } from "@/lib/rate-limit";

/** The `code` a refused attempt carries. */
export const SIGN_IN_RATE_LIMITED = "rate_limited";

export class SignInRateLimited extends CredentialsSignin {
  code = SIGN_IN_RATE_LIMITED;
  constructor() {
    // For the server log, where Auth.js prints every failed sign-in. Clients
    // see only the `code`.
    super("Sign-in limit reached");
  }
}

/**
 * 10 attempts in a burst, then one more every 10 seconds. The name, and so the
 * `rate_buckets` row, is the one the server action used.
 */
const signInLimiter = createRateLimiter({
  scope: "ip",
  name: "login-credentials",
  maxTokens: 10,
  refillRatePerSecond: 0.1,
});

/** Who an attempt is charged to. Auth.js always passes the request. */
export function signInLimitKey(request: Request | undefined): string {
  return request ? getClientIp(request) : "unknown";
}

/** Charge one attempt to the request's client, or throw `SignInRateLimited`. */
export async function chargeSignInAttempt(
  request: Request | undefined,
): Promise<void> {
  const limit = await signInLimiter.consume(signInLimitKey(request));
  if (!limit.allowed) throw new SignInRateLimited();
}

/** True for an attempt refused by this limit, false for a wrong password. */
export function isSignInRateLimited(err: unknown): boolean {
  return err instanceof CredentialsSignin && err.code === SIGN_IN_RATE_LIMITED;
}
