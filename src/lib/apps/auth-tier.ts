/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Resolving which auth tier a caller actually presents.
 *
 * A route declares a SET of accepted auths; this decides which one of them the
 * caller has earned. Two rules govern it:
 *
 *   1. **Strongest wins.** `session` > `signed-in` > `password` > `key` >
 *      `public`. A signed-in user reading a `["session", "public"]` route gets
 *      the session context, not the anonymous one.
 *   2. **The mount narrows the field.** Not every tier is reachable on every
 *      surface, and that is a property of the transport, not a policy choice —
 *      see `ELIGIBLE_BY_MOUNT` below.
 *
 * Probe order is also cost order: `getReadOnlySession()` is a JWT decode with no
 * database hit, `hasAppGrant()` is one indexed query (skipped outright for a
 * global app), and `isAppUnlocked()` is pure crypto over a cookie. So identity
 * is probed first and the unlock cookie is only read when no identity tier
 * matched.
 */

import { getReadOnlySession } from "@/lib/auth/session";
import { getUserById, hasAppGrant, isAppActive } from "@/lib/apps/access";
import { isAppUnlocked } from "@/lib/apps/public-access";
import { keyAllows, presentedApiKey, resolveApiKey } from "@/lib/apps/api-keys";
import type { RouteAuth } from "@/lib/apps/types";

export type AppMount = "authenticated" | "public";

type DbUser = NonNullable<Awaited<ReturnType<typeof getUserById>>>;

/**
 * Which tiers each mount can serve.
 *
 * `password` is absent from the authenticated mount for a concrete reason, not
 * a policy one: the unlock cookies are path-scoped to `/p/<slug>` and
 * `/api/p/<slug>`, so a browser will never send one to `/api/apps/...`. A
 * password tier declared there would silently never match.
 *
 * `public` IS eligible on the authenticated mount. A widget calls its own app
 * through `createAppClient`, which always targets `/api/apps/...`; without this
 * a route the app deliberately made public would 404 for its own UI. Serving a
 * public route to a signed-in user gives away nothing that wasn't already given
 * away.
 *
 * `key` is served on the PUBLIC mount only. Not a policy choice: `/api/apps` sits
 * behind the proxy's cookie-presence check, so a machine-to-machine caller with
 * no cookie is redirected to /login before any of this runs. `/api/p` is the
 * non-cookie surface, which is exactly what an integration needs.
 */
const ELIGIBLE_BY_MOUNT: Record<AppMount, readonly RouteAuth[]> = {
  authenticated: ["session", "signed-in", "public"],
  public: ["password", "key", "public"],
};

/** Strongest first. Resolution walks this order and stops at the first match. */
const STRENGTH: readonly RouteAuth[] = [
  "session",
  "signed-in",
  "password",
  "key",
  "public",
];

export type AuthResolution =
  | { kind: "resolved"; tier: "session" | "signed-in"; dbUser: DbUser }
  | { kind: "resolved"; tier: "password" | "key" | "public"; dbUser: null }
  /** The route wants an identity and the caller presented none. */
  | { kind: "unauthenticated" }
  /** The caller is known and holds no grant, and no weaker tier is declared. */
  | { kind: "forbidden" }
  /**
   * The route is password-gated and the visitor has not unlocked it. Distinct
   * from `unauthenticated` because the remedy is different and documented: a JS
   * client on a password-protected page treats this as the cue to send the
   * visitor back through the unlock form.
   */
  | { kind: "password-required" }
  /** This mount does not serve this route at all. */
  | { kind: "not-served" };

export async function resolveAuthTier(opts: {
  appSlug: string;
  /** The route's declared auth set. */
  accepted: readonly RouteAuth[];
  mount: AppMount;
  /** Needed to read a presented API key, and to scope-check it. */
  request?: Request;
  method?: string;
  routePattern?: string;
}): Promise<AuthResolution> {
  const { appSlug, accepted, mount, request, method, routePattern } = opts;
  const eligible = ELIGIBLE_BY_MOUNT[mount];
  const candidates = STRENGTH.filter(
    (tier) => accepted.includes(tier) && eligible.includes(tier),
  );

  if (candidates.length === 0) return { kind: "not-served" };

  // A deactivated app serves nothing, at any tier. This is above the tier loop
  // deliberately: `public` and `password` routes never consult a grant, so
  // gating `hasAppGrant` alone would leave an app's public surface answering
  // after an admin switched it off — the one surface where that matters most.
  // `not-served` rather than a 403, because from outside there is no such
  // route: an app that is off should not be distinguishable from one that was
  // never here.
  if (!(await isAppActive(appSlug))) return { kind: "not-served" };

  // Track why an identity tier failed, so a signed-in user who simply lacks the
  // grant gets 403 rather than a misleading 401 — but only when no weaker tier
  // rescues them.
  let sawIdentityTier = false;
  let hadSession = false;
  let lackedGrant = false;
  let lockedOut = false;

  for (const tier of candidates) {
    switch (tier) {
      case "session":
      case "signed-in": {
        sawIdentityTier = true;
        const session = await safeSession();
        if (!session) break;
        hadSession = true;

        const dbUser = await getUserById(session.user.id);
        // A valid JWT for a user row that no longer exists. Not an error: the
        // token outlived its subject, and the caller should re-authenticate.
        if (!dbUser) break;

        if (tier === "signed-in") {
          return { kind: "resolved", tier, dbUser };
        }
        if (await hasAppGrant(dbUser.id, appSlug)) {
          return { kind: "resolved", tier, dbUser };
        }
        lackedGrant = true;
        break;
      }

      case "password": {
        if (await isAppUnlocked(appSlug)) {
          return { kind: "resolved", tier, dbUser: null };
        }
        lockedOut = true;
        break;
      }

      case "key": {
        if (!request) break;
        const resolved = await resolveApiKey(presentedApiKey(request), appSlug);
        if (!resolved) break;
        // A valid key still has to be SCOPED to this route. A key minted for
        // one endpoint must not become a key for the whole app.
        if (
          method &&
          routePattern !== undefined &&
          !keyAllows(resolved.scopes, method, routePattern)
        ) {
          break;
        }
        return { kind: "resolved", tier, dbUser: null };
      }

      case "public":
        return { kind: "resolved", tier, dbUser: null };
    }
  }

  if (sawIdentityTier && hadSession && lackedGrant)
    return { kind: "forbidden" };
  // Checked before `unauthenticated`: for a route declaring both, the visitor on
  // the public surface has a password to enter, not a login to complete.
  if (lockedOut) return { kind: "password-required" };
  if (sawIdentityTier) return { kind: "unauthenticated" };
  return { kind: "not-served" };
}

/**
 * `auth()` builds its options from the database on every call, so a database
 * blip can make it throw. Treat that as "no session" rather than a 500: the
 * caller then falls through to whatever weaker tier the route declares, which
 * is the same answer they would get with an expired cookie.
 */
async function safeSession() {
  try {
    return await getReadOnlySession();
  } catch (err) {
    console.warn(
      "[auth-tier] session probe failed, treating as anonymous:",
      err,
    );
    return null;
  }
}
