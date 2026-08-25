import { redirect } from "next/navigation";
import { auth } from "./index";
import type { Session } from "next-auth";

/**
 * Session payload shape the rest of the codebase consumes.
 *
 * The previous implementation delegated to @montalbanowork/sso, where
 * session.user.id was the external SSO subject ID. With NextAuth +
 * email/password the id is now the internal users.id (UUID). Callers
 * that used to pass session.user.id to getUserBySSO() should use
 * getUserById() instead.
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

/**
 * Kept as an alias for code migrated from @montalbanowork/sso's
 * `requireServerSession`. Same behavior as `requireReadOnlySession`.
 */
export const requireServerSession = requireReadOnlySession;
