/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { NextResponse, type NextRequest } from "next/server";
import { isUpdatingAppPage } from "@/lib/apps/app-gate";
import { buildCsp, cspNonce, formActionsFor } from "@/lib/csp";
import { maintenanceState, type MaintenanceState } from "@/lib/platform/maintenance";
import { appMaintenanceGate, maintenanceGate } from "@/lib/platform/maintenance-gate";

/**
 * The maintenance response, then an optimistic auth check.
 *
 * While the platform schema is behind this build, every request this sees but
 * the two health probes gets a 503 from here, before anything that could reach
 * a route and query the database (src/lib/platform/maintenance.ts). That needs
 * the database, which a proxy can reach because in Next 16 it runs on the
 * Node.js runtime, always: `runtime` can't be set in this file. The routes
 * `config.matcher` leaves out below give the same response themselves: the app
 * API gateway on its two mounts, and the webhook route.
 *
 * While one app's own migrations are behind, that app's pages get the same
 * 503 from here, saying the app is being updated, and everything else serves.
 * From here because a page can't set its own status. A public page gets it
 * only where its route would serve it; a signed-in page once the cookie check
 * has passed, which is as far as this file reads the session. The app's API
 * routes are answered by the gateway, and the rest of its code is held back
 * by the app gate (src/lib/apps/app-gate.ts). Every other page is decided from
 * the answer already kept, with no query.
 *
 * Per Next.js guidance (docs/01-app/01-getting-started/16-proxy.md), proxy
 * middleware should not be used for full authorization. We only do a
 * cookie-presence check here to redirect obvious unauthenticated requests
 * to /login. Every protected page and API route does its own authoritative
 * check via `requireReadOnlySession()` / `requireAdmin()`.
 */

const PUBLIC_ROUTE_PREFIXES = [
  "/login",
  "/api/auth",
  "/api/health",
  "/manifest.webmanifest",
  // App public surface — pages and API routes whose manifest declares
  // `visibility: "public"` or `"password"`. The visibility gate is
  // enforced inside the route handlers themselves (see
  // src/app/(public)/p/[appSlug]/[[...path]]/page.tsx and
  // src/app/api/p/[appSlug]/[[...slug]]/route.ts); the proxy must NOT
  // bounce unauthenticated visitors here, since "no session" is the
  // expected state for the public surface. The matcher below also leaves
  // `/api/p/` out of the proxy entirely; `/api/p` stays here so that undoing
  // that cannot send the public API's callers to /login.
  "/p",
  "/api/p",
  // MCP server. Authenticated by an OAuth 2.1 bearer token, not a session
  // cookie — "no cookie" is the expected state, and the endpoint's own 401
  // (with the WWW-Authenticate discovery header) is what a client needs to see.
  // A redirect to /login here would break the flow silently. See
  // src/app/api/mcp/route.ts.
  "/api/mcp",
  // Inbound connector webhooks. Authenticated by an HMAC signature over the
  // raw body, not by a session cookie — the caller is a third-party server, so
  // "no cookie" is the expected state. As with /api/cron, removing this from
  // the list does not harden the route: the delivery would 307 to /login, which
  // the provider records as a successful delivery, and the event is lost
  // silently. The signature check in src/lib/connectors/webhook.ts is the gate.
  // Note this is deliberately NOT /api/connectors, which stays session-gated —
  // the OAuth start/callback routes live there and must not become public.
  // The matcher below also leaves `/api/webhooks/` out of the proxy entirely;
  // this entry stays so that undoing that cannot send deliveries to /login.
  "/api/webhooks",
  // Scheduler tick — driven by Vercel Cron in production (vercel.json) and by
  // the compose `cron` sidecar locally. Authenticated by the timing-safe bearer
  // comparison against CRON_SECRET in src/app/api/cron/route.ts; that
  // comparison is the real gate, and "no session cookie" is the expected state
  // for a caller that is not a browser.
  //
  // Leaving it off this list does not harden the route, it disables it — and
  // silently. The proxy answers 307 -> /login, which is a perfectly successful
  // HTTP exchange: the sidecar's `curl` has no -L, so it records the status and
  // keeps ticking, Vercel Cron counts the invocation as delivered, and
  // runDueJobs() is never reached. Nothing throws, nothing retries, no log line
  // looks wrong — the scheduler just stops. The route's own 401 is what an
  // operator needs to see when the secret is actually wrong.
  "/api/cron",
  // OAuth 2.1 authorization-server endpoints (register / token / revoke). The
  // /oauth/authorize consent screen is deliberately NOT listed: it must require
  // a session, and the redirect to /login is exactly the behavior we want.
  "/api/oauth",
  // OAuth discovery documents, rewritten to /api/well-known in next.config.ts.
  // Both spellings are listed because the proxy runs before config rewrites.
  "/.well-known",
  "/api/well-known",
];

function isPublic(pathname: string): boolean {
  return PUBLIC_ROUTE_PREFIXES.some(
    (p) =>
      pathname === p ||
      pathname.startsWith(`${p}/`) ||
      pathname.startsWith(`${p}?`),
  );
}

function hasSessionCookie(request: NextRequest): boolean {
  // NextAuth v5 uses `authjs.session-token` on http and
  // `__Secure-authjs.session-token` on https.
  return (
    !!request.cookies.get("authjs.session-token")?.value ||
    !!request.cookies.get("__Secure-authjs.session-token")?.value
  );
}

/**
 * The per-request CSP (src/lib/csp.ts), with the nonce attached to the REQUEST
 * headers as well as the response.
 *
 * Next parses the nonce out of the request's `Content-Security-Policy` during
 * render; `x-nonce` is what a server component reads if it ever needs to hand
 * the nonce to a third-party script tag itself.
 */
function withCsp(request: NextRequest): NextResponse {
  const nonce = cspNonce();
  const csp = buildCsp(nonce, { formActions: formActionsFor(request.nextUrl.pathname) });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export default async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // One answer per request, read only by the paths that need it: the health
  // probes never ask, and a slow check is waited on once.
  let asked: Promise<MaintenanceState> | undefined;
  const state = () => (asked ??= maintenanceState());

  // First, ahead of the public list: a public route queries the database as
  // readily as a signed-in one, and the whole instance is waiting.
  const maintenance = await maintenanceGate(pathname, state);
  if (maintenance) return maintenance;

  if (isPublic(pathname)) {
    return (await appMaintenanceGate(pathname, state, isUpdatingAppPage)) ?? withCsp(request);
  }

  if (!hasSessionCookie(request)) {
    const url = new URL("/login", request.url);
    return NextResponse.redirect(url);
  }

  return (await appMaintenanceGate(pathname, state, isUpdatingAppPage)) ?? withCsp(request);
}

export const config = {
  // App-icon routes are exempt alongside favicon.ico. Next serves every
  // `icon`/`apple-icon` file convention from a hashed path at the root
  // (`/icon.png`, `/icon-1c1a04.png` for a nested segment), and without this
  // they redirect to /login for anyone without a session — so the browser drops
  // them and falls back to /favicon.ico. That is why the customer portal and the
  // login page both showed the root favicon whatever their <link> tags said.
  // These are logos: public by nature, and never a place a secret can hide.
  //
  // Theme files, `/themes/<id>/<file>`, are exempt for the same reason, and one
  // sharper one: the sign-in page itself is themed. With the theme's fonts and
  // logo behind the auth redirect, the one page every user sees before they
  // have a session is the one page that renders unstyled. A theme asset is a
  // font file, a logo or a favicon — the same "public by nature" category as
  // the icons above. The pattern is `themes/<id>/`, not `themes/`: only a
  // theme's own files are exempt, so a page under /themes would stay under the
  // proxy.
  //
  // `connector-assets/` is a connector's icon, copied out of
  // connectors/<name>/assets by the registry generator. Same category again: a
  // third party's logo, committed in the repo, never a place a secret can hide.
  // It has a prefix of its own rather than `/connectors/`, so the exemption
  // can't take the guard off a page, and it must be exempt: next/image's
  // optimizer fetches the source URL server-side with no cookies and would get
  // the redirect to /login.
  //
  // `screenshots/` is an app's or theme's listing gallery, copied out of
  // <ext>/screenshots/ by the same generator. The category argument is the
  // same, but the reason it MUST be unauthenticated is stronger than for the
  // others: a screenshot exists to be looked at by someone deciding whether to
  // install, which is necessarily before they have a session — a gallery behind
  // the auth redirect is a gallery with no audience. Only manifest-declared
  // files are copied here, so an undeclared draft sitting in the source
  // directory never reaches this path.
  //
  // `branding/` is the marks an app ships for the brand hooks, copied out of
  // apps/<slug>/branding/. The sign-in page draws them before anyone has a
  // session, which is the theme-assets argument exactly — and, like
  // screenshots, only declared files are copied.
  //
  // A path left out here gets neither of the proxy's maintenance responses, so
  // leave out only files that are served without reading the database, or a
  // route that runs the maintenance gate itself. Three routes do:
  //
  // `api/webhooks/` is left out so that a delivery's body is read only by the
  // route, which stops at its cap, and the route runs the maintenance gate
  // first, as this file does (src/app/api/webhooks/[name]/route.ts).
  //
  // `api/apps/` and `api/p/`, the two app API mounts, are left out for their
  // request bodies too. On every request the proxy runs for, Next buffers a
  // copy of the body so the proxy and the route can both read it, and keeps
  // only the first 10 MB of it (`proxyClientMaxBodySize`, an experimental
  // option): the route gets the body cut short as if it ended there, and the
  // only trace is a warning in the server log. The gateway accepts bodies up to
  // 27 MB (MAX_BODY_BYTES in src/lib/apps/dispatch.ts), so an upload between
  // the two arrived truncated. Left out, the route reads the body as it was
  // sent, and the gateway does for these paths what the proxy does for the
  // rest: the maintenance response first, then this CSP on what it answers.
  // One app's "being updated" answer comes from its app gate, as for any of
  // that app's routes. The gateway has no cookie check, and needs none: a
  // cookie's presence is not a session, and its auth tiers decide who is
  // served on both mounts.
  matcher: [
    "/((?!_next/static|_next/image|themes/[^/]+/|connector-assets/|screenshots/|branding/|api/webhooks/|api/apps/|api/p/|favicon.ico|icon\\.|icon-|apple-icon\\.|apple-icon-).*)",
  ],
};
