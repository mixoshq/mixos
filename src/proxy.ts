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
    (p) => pathname === p || pathname.startsWith(`${p}/`) || pathname.startsWith(`${p}?`)
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

export default function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublic(pathname)) return NextResponse.next();

  if (!hasSessionCookie(request)) {
    const url = new URL("/login", request.url);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // App-icon routes are exempt alongside favicon.ico. Next serves every
  // `icon`/`apple-icon` file convention from a hashed path at the root
  // (`/icon.png`, `/icon-1c1a04.png` for a nested segment), and without this
  // they redirect to /login for anyone without a session — so the browser drops
  // them and falls back to /favicon.ico. That is why the customer portal and the
  // login page both showed the root favicon whatever their <link> tags said.
  // These are logos: public by nature, and never a place a secret can hide.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon\\.|icon-|apple-icon\\.|apple-icon-).*)",
  ],
};
