/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic auth check at the proxy layer.
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
  // expected state for the public surface.
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
 * Per-request CSP with a fresh nonce.
 *
 * WHY HERE AND NOT next.config.ts. A nonce has to be unique per request, so it
 * cannot come from static header config. Next reads the nonce out of this header
 * during SSR and applies it to its own framework scripts and bundles, which is
 * what makes `strict-dynamic` workable without hand-annotating every tag.
 *
 * The CSP is set in exactly ONE place. Two `Content-Security-Policy` headers are
 * INTERSECTED by the browser, not merged, so leaving the old static
 * `frame-ancestors` header in next.config.ts alongside this one would silently
 * produce a policy stricter than either.
 *
 * `frame-ancestors 'self'` is carried over deliberately — MixOS frames its own
 * pages, and this is the only clickjacking control (X-Frame-Options is not set,
 * and frame-ancestors supersedes it).
 *
 * `script-src` is the point of the exercise. `'strict-dynamic'` means a script
 * that carries the nonce may load further scripts, and nothing else may — so an
 * injected `<script>` an attacker plants in the DOM does not run, because it
 * cannot guess the nonce.
 *
 * `style-src` keeps `'unsafe-inline'`, and that is a considered trade rather than
 * an oversight: React writes `style={{...}}` attributes throughout the dashboard
 * (the drag-and-drop grid computes positions inline), a style attribute cannot
 * execute script, and the XSS protection here comes from `script-src`. Tightening
 * this means moving to `style-src-attr` plumbing for no meaningful gain.
 *
 * `connect-src 'self'` reinforces the egress boundary from the browser side: app
 * client code reaches its own routes through the SDK and has no business opening
 * a socket to anywhere else. Raw `fetch` is already lint-banned in `apps/**`.
 *
 * DEV. React uses `eval` in development to reconstruct server error stacks, so
 * `'unsafe-eval'` is required there and only there.
 *
 * COST, stated plainly: a nonce forces every page to be dynamically rendered,
 * because the nonce only exists once a request does. Static optimization, ISR and
 * PPR are off. For a signed-in dashboard that already reads a session cookie on
 * every page this changes almost nothing; the one surface that could have been
 * cached is the public `/p/<slug>` view.
 */
function buildCsp(nonce: string): string {
  const isDev = process.env.NODE_ENV === "development";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

/**
 * Attach the nonce to the REQUEST headers as well as the response.
 *
 * Next parses the nonce out of the request's `Content-Security-Policy` during
 * render; `x-nonce` is what a server component reads if it ever needs to hand
 * the nonce to a third-party script tag itself.
 */
function withCsp(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp(nonce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export default function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublic(pathname)) return withCsp(request);

  if (!hasSessionCookie(request)) {
    const url = new URL("/login", request.url);
    return NextResponse.redirect(url);
  }

  return withCsp(request);
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
  // `themes/` is exempt for the same reason, and one sharper one: the sign-in
  // page itself is themed. With the theme's fonts and logo behind the auth
  // redirect, the one page every user sees before they have a session is the
  // one page that renders unstyled. A theme asset is a font file, a logo or a
  // favicon — the same "public by nature" category as the icons above.
  //
  // `connector-assets/` is a connector's icon, copied out of
  // connectors/<name>/assets by the registry generator. Same category again: a
  // third party's logo, committed in the repo, never a place a secret can hide.
  // It is deliberately NOT served from `/connectors/`, which is a signed-in
  // page route (/connectors/guide) — exempting that prefix would take the guard
  // off a real page, and leaving it unexempted breaks the icons, because
  // next/image's optimizer fetches the source URL server-side with no cookies
  // and gets the redirect to /login.
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
  matcher: [
    "/((?!_next/static|_next/image|themes/|connector-assets/|screenshots/|branding/|favicon.ico|icon\\.|icon-|apple-icon\\.|apple-icon-).*)",
  ],
};
