/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Session revocation under a JWT session strategy.
 *
 * There is no server-side session row to delete (`session: { strategy: "jwt" }`),
 * so signing out clears a cookie and nothing else: an already-issued token stays
 * valid until it expires. Rotating `AUTH_SECRET` invalidates every session at
 * once — the right hammer for a suspected secret leak, the wrong one for "this
 * person left" or "that laptop was stolen".
 *
 * `users.session_version` is a counter carried in the token and compared against
 * the row on every session resolution. Bumping it invalidates every token minted
 * before that moment, for that user only.
 *
 * WHAT SHOULD BUMP IT: a password change (the credential the token was minted
 * from is gone), an admin forcing sign-out, and offboarding. Granting or
 * revoking an app grant should NOT — those are re-read live on every request
 * (§3.1) and do not need the session torn down.
 */

import { sql } from "@/lib/db/server";

/**
 * Invalidate every session issued to this user before now.
 *
 * Read-modify-write is avoided deliberately: two concurrent revocations that
 * both read `3` would both write `4`, and the second would be a no-op rather
 * than a second revocation. Incrementing in the database is atomic and, more
 * importantly, monotonic — a revocation can never fail to move the number.
 */
export async function revokeUserSessions(userId: string): Promise<number> {
  try {
    const [row] = await sql<{ version: number | null }[]>`
      select public.bump_session_version(${userId}::uuid) as version
    `;
    return Number(row?.version ?? 0);
  } catch (error) {
    // Loud and rethrown, unlike the audit log. Revocation is a GATE: an admin
    // told to believe a session was killed when it was not is worse than an
    // error message.
    console.error(`[auth] failed to revoke sessions for ${userId}:`, error);
    throw new Error("Could not revoke sessions for this user.");
  }
}
