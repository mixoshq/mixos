/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { NextResponse, type NextRequest } from "next/server";
import { requireReadOnlySession } from "@/lib/auth/session";
import {
  OAUTH_STATE_COOKIE,
  oauthReturnUrl,
  safeReturnPath,
} from "@/lib/connectors/oauth";
import { startConnectorOAuth } from "@/lib/connectors/oauth-flow";

/**
 * Begin the tenant OAuth consent flow for one connector.
 *
 * Admin-only, and deliberately NOT in the proxy's public prefixes: this is a
 * browser navigation carrying a session cookie, so bouncing an unauthenticated
 * visitor to /login is the correct behaviour. Who may start which flow, and
 * when it is refused, is decided in src/lib/connectors/oauth-flow.ts.
 *
 * The PKCE verifier goes into an encrypted, HttpOnly cookie rather than into
 * `state` — the provider sees `state`, and handing it the verifier would
 * defeat the binding PKCE exists to create.
 */
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ name: string }> },
) {
  const session = await requireReadOnlySession();

  const { name } = await ctx.params;
  const returnTo = safeReturnPath(request.nextUrl.searchParams.get("return"));

  const start = await startConnectorOAuth(name, session, returnTo);
  if (!start.ok) {
    return NextResponse.redirect(
      oauthReturnUrl(returnTo, request.nextUrl.origin, name, start.outcome),
    );
  }

  const response = NextResponse.redirect(start.authorizeUrl);
  response.cookies.set(OAUTH_STATE_COOKIE, start.sealedFlow, {
    httpOnly: true,
    // Lax, not Strict: the provider sends the admin back via a top-level GET
    // navigation, which Strict would strip the cookie from.
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
    path: "/api/connectors",
    maxAge: 600,
  });
  return response;
}
