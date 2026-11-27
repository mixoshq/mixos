/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The app API gateway.
 *
 * Both HTTP mounts — `/api/apps/<slug>/…` and `/api/p/<slug>/…` — are the same
 * pipeline with a different `mount` argument, so neither can grow a gate the
 * other lacks: two implementations kept in step by comment drift apart.
 *
 * Neither mount is behind the proxy (src/proxy.ts, `config.matcher`): Next
 * would cut any request body the proxy sees at 10 MB. So the gateway gives
 * these paths what the proxy gives the rest, itself: the maintenance response
 * first, and the CSP on everything else it answers.
 *
 * The order below is load-bearing and is written out so a change to it is a
 * deliberate act:
 *
 *   0. The maintenance response.                      → 503
 *   1. Body cap, before anything reads a body, and
 *      again as the route reads it.                   → 413
 *   2. App exists.                                    → 404
 *   3. Per-IP rate limit, before any authentication work.
 *   4. Resolve the URL to an on-disk route pattern.   → 404
 *   5. Pre-import eligibility, from the REGISTRY.     → 404
 *   6. The app gate, then import the module and find
 *      the declaration.                               → 404 / 503 / 405 / 500
 *   7. Live declaration must agree with the registry. → 404
 *   8. Resolve the auth tier the caller presents.     → 401 / 403 / 404
 *   9. Per-user and per-route rate limits, now that we know who is calling.
 *  10. Build the context for that tier.               → 500
 *  11. Run the route (which enforces roles).
 *
 * Step 5 exists so a route that does not serve this mount never gets the chance
 * to run its module-scope code for a caller it would have refused. The app gate
 * that opens step 6 does the same for a whole app: one an admin switched off,
 * or one whose own migrations are behind this build, never runs its
 * module-scope code, for anyone. Step 8 checks activation again, as a second
 * line. Step 7 exists because step 5 trusted the generated registry, and a
 * gate decided from one source and enforced from another is not a gate.
 */

import { NextResponse } from "next/server";
import { appRegistry } from "@/generated/app-registry";
import {
  APP_UPDATING_MESSAGE,
  MAINTENANCE_HEADERS,
  maintenanceGate,
} from "@/lib/platform/maintenance-gate";
import { resolveRoutePath } from "@/lib/apps/api-router";
import { checkAppGate } from "@/lib/apps/app-gate";
import { buildAppContext, buildPublicAppContext } from "@/lib/apps/context";
import { getClientIp } from "@/lib/apps/public-access";
import { loadRouteModule } from "@/lib/apps/route-loader";
import {
  isRouteDefinition,
  runRoute,
  type ResolvedContext,
} from "@/lib/apps/route";
import { createRateLimiter } from "@/lib/rate-limit";
import { resolveAuthTier, type AppMount } from "@/lib/apps/auth-tier";
import { needsCsrf, verifyCsrf } from "@/lib/apps/csrf";
import { capRequestBody } from "@/lib/apps/request-body";
import type { RouteAuth } from "@/lib/apps/types";
import { buildCsp, cspNonce } from "@/lib/csp";
import { maintenanceState } from "@/lib/platform/maintenance";
import { deepFreeze } from "./freeze";

/**
 * Cap request bodies at 27 MB. Routes still validate their own payloads; this is
 * the memory-DoS backstop. 27 MB = a 25 MB user-facing limit plus ~2 MB for
 * multipart boundaries and form fields. Raise consciously.
 *
 * A declared `content-length` over the cap is refused before the body is read.
 * A body sent without one (chunked transfer encoding) is counted as the route
 * reads it, and refused the same way once it passes the cap
 * (src/lib/apps/request-body.ts).
 */
const MAX_BODY_BYTES = 27_000_000;

/** Pre-auth, per-IP. The only limiter that runs before we know who is calling. */
const ipLimiter = createRateLimiter({
  scope: "ip",
  name: "app-api",
  maxTokens: 60,
  refillRatePerSecond: 10,
});

/**
 * Per (user, app). An IP bucket is shared by everyone behind one NAT and cannot
 * tell a busy office from one runaway client; this one can.
 */
const userAppLimiter = createRateLimiter({
  scope: "user_app",
  name: "app-api-user",
  maxTokens: 120,
  refillRatePerSecond: 4,
});

/**
 * Per (app, route pattern, caller). Deliberately generous — its job is to stop a
 * single expensive endpoint being hammered, not to shape normal traffic, which
 * the two limiters above already do.
 */
const routeLimiter = createRateLimiter({
  scope: "route",
  name: "app-api-route",
  maxTokens: 90,
  refillRatePerSecond: 3,
});

/** The methods both mounts export. Next serves HEAD from GET. */
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

/** What Next's own OPTIONS answer would list for the mount files. */
const ALLOW = [...HTTP_METHODS, "HEAD", "OPTIONS"].sort().join(", ");

function payloadTooLarge() {
  return NextResponse.json(
    { error: "Request body too large", code: "PAYLOAD_TOO_LARGE" },
    { status: 413 },
  );
}

function tooManyRequests(retryAfterMs: number) {
  return NextResponse.json(
    { error: "Too many requests", code: "RATE_LIMITED" },
    {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) },
    },
  );
}

/** 404 rather than 401/403 wherever telling the two apart would be an oracle. */
function notFound() {
  return NextResponse.json(
    { error: "Not found", code: "NOT_FOUND" },
    { status: 404 },
  );
}

/**
 * The app's own migrations are behind this build. Not a 404, which is a
 * switched-off app's answer and tells a client the route is gone: this one is
 * back once the release step has run, which is what 503 and `Retry-After` say
 * to every HTTP client. `UNAVAILABLE` is the code `callAppRoute()` throws for
 * it too.
 */
function appUpdating() {
  return NextResponse.json(
    { error: APP_UPDATING_MESSAGE, code: "UNAVAILABLE" },
    { status: 503, headers: MAINTENANCE_HEADERS },
  );
}

export interface DispatchOptions {
  request: Request;
  method: HttpMethod;
  appSlug: string;
  /** URL segments after the slug. */
  segments: string[];
  mount: AppMount;
}

export function dispatchAppRoute(options: DispatchOptions): Promise<Response> {
  return atTheEdge(options.request, () => dispatch(options));
}

/**
 * OPTIONS on either mount: Next's own answer for these files, 204 and the
 * methods they serve, after the maintenance response, which Next's answer
 * alone would skip.
 */
export function appRouteOptions(request: Request): Promise<Response> {
  return atTheEdge(
    request,
    async () => new Response(null, { status: 204, headers: { Allow: ALLOW } }),
  );
}

/**
 * What the proxy does for every path it runs on, done here for the two mounts
 * it doesn't (src/proxy.ts, `config.matcher`).
 */
async function atTheEdge(request: Request, serve: () => Promise<Response>): Promise<Response> {
  // 0 — the maintenance response, before anything that could reach the
  // database. Its own answer, without the CSP, as the proxy's is.
  const maintenance = await maintenanceGate(new URL(request.url).pathname, maintenanceState);
  if (maintenance) return maintenance;
  return withCsp(await serve());
}

/**
 * The proxy's CSP (src/lib/csp.ts), replacing any the route set, as the
 * proxy's did. A Response whose headers can't change, a `Response.redirect()`
 * or one passed through from `context.http`, is copied first.
 */
function withCsp(response: Response): Response {
  const csp = buildCsp(cspNonce());
  try {
    response.headers.set("Content-Security-Policy", csp);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    headers.set("Content-Security-Policy", csp);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

async function dispatch({
  request,
  method,
  appSlug,
  segments,
  mount,
}: DispatchOptions): Promise<Response> {
  // 1 — body cap. A declared length is checked here, before the body is read;
  // a body without one is counted as the route reads it (step 12).
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    return payloadTooLarge();
  }

  // 2 — the app exists.
  const manifest = appRegistry.find((a) => a.slug === appSlug);
  if (!manifest) return notFound();

  // 3 — per-IP, before any authentication work. `getClientIp` takes the
  // rightmost x-forwarded-for entry (the one our own proxy appended) to resist
  // client-side spoofing, and is shared so every limiter derives the same
  // subject — two mounts deriving it differently produce incomparable buckets.
  const ip = getClientIp(request);
  const ipLimit = await ipLimiter.consume(ip);
  if (!ipLimit.allowed) return tooManyRequests(ipLimit.retryAfterMs);

  // 4 — URL → on-disk pattern. The root route is `api/index/route.ts` and its
  // declaration key is the empty string.
  const routePath =
    segments.length === 0 ? "index" : await resolveRoutePath(appSlug, segments);
  if (!routePath) return notFound();
  const routeKey = routePath === "index" ? "" : routePath;

  // 5 — pre-import eligibility, decided from the hoisted contract so no app code
  // runs for a caller this mount would refuse. Per method: a route may serve GET
  // publicly and keep POST behind a session.
  const contract = manifest.routes?.find((r) => r.path === routeKey);
  const methodContract = contract?.methods.find((m) => m.method === method);
  const registryAuth: RouteAuth[] | undefined = methodContract?.auth;
  if (registryAuth && !servedHere(registryAuth, mount)) return notFound();

  // 6 — the app gate, before the import, because importing runs the module's
  // top-level code. An app that is off is a 404, like a route that was never
  // here, which is also what step 8 answers for it. One whose own migrations
  // are behind is a 503 until the release step has run. That answer comes
  // before authentication, because authenticating needs the declaration this
  // import would load, so it reaches anyone step 5 lets through: it says only
  // that the app is being updated.
  const gate = await checkAppGate(appSlug);
  if (!gate.open) return gate.reason === "updating" ? appUpdating() : notFound();

  // Import and dispatch are separated so a route that throws at module scope is
  // not reported as missing. That distinction cost real debugging time. Both
  // are a 404 to the caller; the log says which. The module comes from the
  // generated loader map, not a template import, so a route added under
  // `next dev` loads once `npm run registry` has run (./route-loader.ts).
  const load = await loadRouteModule(appSlug, routePath);
  if (load.kind === "missing") {
    console.warn(
      `[gateway] ${appSlug}/api/${routePath} is on disk but not in the generated route map. ` +
        `Run \`npm run registry\`.`,
    );
    return notFound();
  }
  if (load.kind === "failed") {
    console.error(`[gateway] ${appSlug}/api/${routePath} failed to load:`, load.error);
    return notFound();
  }
  const mod = load.module;

  const declaration = mod[method];
  if (declaration === undefined) {
    return NextResponse.json(
      { error: "Method not allowed", code: "METHOD_NOT_ALLOWED" },
      { status: 405 },
    );
  }
  if (!isRouteDefinition(declaration)) {
    // The generator refuses to build a route that exports anything else, so
    // reaching this means the bundle and the registry disagree. Fail closed
    // rather than calling an unknown value.
    console.error(
      `[gateway] ${appSlug}/api/${routePath} ${method} is not a defineRoute() result.`,
    );
    return NextResponse.json(
      { error: "Internal server error", code: "HANDLER_ERROR" },
      { status: 500 },
    );
  }

  // 7 — the live declaration is the authority, and it must match what step 5
  // was decided on. Any disagreement is a 404: a bundle newer or older than the
  // registry is exactly the case a defensive re-check exists for.
  if (registryAuth && !sameAuthSet(registryAuth, declaration.auth)) {
    console.error(
      `[gateway] ${appSlug}/api/${routePath} ${method}: registry auth [${registryAuth.join(",")}] ` +
        `but declaration auth [${declaration.auth.join(",")}].`,
    );
    return notFound();
  }

  // 8 — which tier has the caller actually earned?
  // Guarded like every other fallible step. `resolveAuthTier` protects its own
  // session probe, but `getUserById`, `hasAppGrant` and `isAppUnlocked` all reach
  // the database or the cookie store and can throw. Unguarded, that escaped
  // `dispatchAppRoute` entirely and Next returned a bodyless 500.
  //
  // Fails CLOSED: an authorization decision we could not make is not a decision
  // we get to skip.
  let resolution: Awaited<ReturnType<typeof resolveAuthTier>>;
  try {
    resolution = await resolveAuthTier({
      appSlug,
      accepted: declaration.auth,
      mount,
      request,
      method,
      routePattern: routeKey,
    });
  } catch (err) {
    console.error(`[gateway] ${appSlug}: auth resolution failed:`, err);
    return NextResponse.json(
      { error: "Internal server error", code: "HANDLER_ERROR" },
      { status: 500 },
    );
  }

  if (resolution.kind === "not-served") return notFound();
  if (resolution.kind === "password-required") {
    // 401 with a JSON body, so a JS client on a password-protected page can
    // detect the expired cookie and prompt the visitor to re-unlock. This is a
    // documented contract (docs/apps/api-routes.md) — do not fold it into 404.
    return NextResponse.json(
      { error: "Password required", code: "UNAUTHENTICATED" },
      { status: 401 },
    );
  }
  if (resolution.kind === "unauthenticated") {
    // On the public mount an identity challenge would confirm the route exists,
    // so it stays a 404 there. The authenticated mount is the one the browser
    // SDK calls with its session cookie, and 401 is the useful answer there.
    return mount === "public"
      ? notFound()
      : NextResponse.json(
          { error: "Sign in to continue", code: "UNAUTHENTICATED" },
          { status: 401 },
        );
  }
  if (resolution.kind === "forbidden") {
    return mount === "public"
      ? notFound()
      : NextResponse.json(
          { error: "You do not have access to this app", code: "FORBIDDEN" },
          { status: 403 },
        );
  }

  // 9 — CSRF, for cookie-authenticated mutations only.
  //
  // Placed here rather than earlier because it is only meaningful once we know
  // the caller rode in on a cookie. The `password`, `key` and `public` tiers
  // carry no ambient credential for a cross-site request to borrow, and the
  // public mount serves nothing else — requiring a token there would break every
  // API-key integration to defend against nothing.
  //
  // `SameSite=Lax` is still the primary defence (docs/security-architecture.md
  // §7). This is the second lock, and the one that does not depend on the
  // browser implementing Lax correctly.
  if (
    mount === "authenticated" &&
    needsCsrf(method) &&
    (resolution.tier === "session" || resolution.tier === "signed-in") &&
    !verifyCsrf(request)
  ) {
    // 403 with a distinct code: the SDK clears its cached token and retries once
    // on a 403, which is what recovers a token that expired mid-session.
    return NextResponse.json(
      { error: "Invalid or missing CSRF token", code: "CSRF_FAILED" },
      { status: 403 },
    );
  }

  // 10 — identity-aware limits. The subject is the user where we have one and the
  // IP where we do not, so an anonymous flood is still bounded per route.
  const subject = resolution.dbUser?.id ?? ip;
  const userLimit = await userAppLimiter.consume(`${subject}::${appSlug}`);
  if (!userLimit.allowed) return tooManyRequests(userLimit.retryAfterMs);

  const routeLimit = await routeLimiter.consume(
    `${appSlug}::${method} ${routeKey}::${subject}`,
  );
  if (!routeLimit.allowed) return tooManyRequests(routeLimit.retryAfterMs);

  // 11 — build the context the resolved tier earns. `auth` is attached here
  // rather than inside the builders so the tier decision and the context that
  // records it cannot come from two different places.
  let context: ResolvedContext;
  try {
    if (resolution.tier === "session" || resolution.tier === "signed-in") {
      const base = await buildAppContext(appSlug, resolution.dbUser);
      context =
        resolution.tier === "signed-in"
          ? { ...base, user: withoutAppRoles(base.user), auth: resolution.tier }
          : { ...base, auth: resolution.tier };
    } else {
      context = {
        ...(await buildPublicAppContext(appSlug)),
        auth: resolution.tier,
      };
    }
  } catch (err) {
    console.error(`[gateway] ${appSlug}: context build failed:`, err);
    return NextResponse.json(
      { error: "Internal server error", code: "HANDLER_ERROR" },
      { status: 500 },
    );
  }

  // 12 — run it. Role enforcement lives inside runRoute so every caller of a
  // route, including Phase 2's in-process `context.call()`, passes through it.
  // The route reads the body through step 1's cap, counted as it arrives.
  const body = capRequestBody(request, MAX_BODY_BYTES);
  const response = await runRoute(declaration, body.request, {
    context,
    appSlug,
    routePattern: routeKey,
    method,
    pathParams: extractPathParams(routePath, segments),
  });

  // The body passed the cap as the route read it. The read failed, and whatever
  // the route made of that, a raw route included, the caller gets step 1's 413.
  if (body.exceeded()) {
    await response.body?.cancel().catch(() => {});
    return payloadTooLarge();
  }
  return response;
}

/**
 * Strip app roles from a `signed-in` caller.
 *
 * `getUserAppRole` resolves to the app's `defaultRole` when there is no grant
 * row — which is correct for `session` (a global app writes no row, and a grant
 * with a null role means "the default"), and wrong for `signed-in`, which is
 * defined as "any signed-in user, grant or not".
 *
 * Without this, a user who was never granted the app is handed the app's default
 * role, and a route gated on that role — a very natural thing to declare — is
 * satisfied by every signed-in user in the deployment. That turns the role gate
 * this phase introduced into default-ALLOW for exactly the tier that skips the
 * grant check.
 *
 * A `signed-in` route is for surfaces that are meaningful without membership.
 * If it needs a role, it needs `session`.
 */
function withoutAppRoles<
  T extends { readonly roles: readonly string[]; readonly hasRole: (r: string[]) => boolean },
>(user: T): T {
  // Frozen like the user it copies (src/lib/apps/context.ts).
  return deepFreeze({ ...user, roles: [], hasRole: () => false });
}

/** Does any declared auth reach callers on this mount? */
function servedHere(accepted: readonly RouteAuth[], mount: AppMount): boolean {
  // Deliberately mirrors ELIGIBLE_BY_MOUNT in auth-tier.ts rather than
  // re-deriving the answer. Keep the two in step: a tier admitted here but not
  // there imports an app module only to refuse it a step later, and a tier
  // admitted there but not here is unreachable no matter what a route declares.
  const serves = (a: RouteAuth) =>
    mount === "public"
      ? a === "password" || a === "key" || a === "public"
      : a === "session" || a === "signed-in" || a === "public";
  return accepted.some(serves);
}

function sameAuthSet(
  a: readonly RouteAuth[],
  b: readonly RouteAuth[],
): boolean {
  return [...a].sort().join(",") === [...b].sort().join(",");
}

/**
 * Zip a resolved route pattern against the actual URL segments.
 *
 * `resolveRoutePath` returns the on-disk pattern (`items/[id]`) and the URL
 * carried the values (`items/42`), so the two line up positionally. A catch-all
 * (`[...rest]`) takes every remaining segment.
 */
export function extractPathParams(
  routePath: string,
  segments: string[],
): Record<string, string> {
  if (!routePath || routePath === "index") return {};
  const pattern = routePath.split("/");
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const part = pattern[i];
    if (!part.startsWith("[") || !part.endsWith("]")) continue;
    const bare = part
      .slice(1, -1)
      .replace(/^\.\.\./, "")
      .replace(/^\[|\]$/g, "");
    params[bare] = part.includes("...")
      ? segments.slice(i).join("/")
      : (segments[i] ?? "");
  }
  return params;
}
