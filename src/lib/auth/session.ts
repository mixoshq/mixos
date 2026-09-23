/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { redirect } from "next/navigation";
import { auth } from "./index";
import type { Session } from "next-auth";

/**
 * Session payload shape the rest of the codebase consumes.
 *
 * `user.id` is the internal `users.id` UUID — pass it to `getUserById()`.
 */
export interface SessionPayload {
  user: {
    id: string;
    email: string;
    name: string;
    isAdmin: boolean;
  };
}

export async function getReadOnlySession(): Promise<SessionPayload | null> {
  const session = (await auth()) as Session | null;
  if (!session?.user?.id) return null;
  return {
    user: {
      id: session.user.id,
      email: session.user.email ?? "",
      name: session.user.name ?? "",
      isAdmin: session.user.isAdmin === true,
    },
  };
}

export async function requireReadOnlySession(): Promise<SessionPayload> {
  const session = await getReadOnlySession();
  // Redirect rather than throw so a stale session cookie (e.g. left over from
  // a cookie-name change) gracefully bounces the user to /login instead of
  // surfacing a 500 page. The proxy is an optimistic presence-only check and
  // can't catch invalid JWTs, so this is the authoritative redirect path.
  if (!session) redirect("/login");
  return session;
}

/** Alias retained for existing call sites. Same behavior as `requireReadOnlySession`. */
export const requireServerSession = requireReadOnlySession;
