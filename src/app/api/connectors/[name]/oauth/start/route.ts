/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { NextResponse, type NextRequest } from "next/server";
import { requireReadOnlySession } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/apps/access";
import { connectorRegistry } from "@/generated/connector-registry";
import { getDecryptedConfig } from "@/lib/connectors/config";
import {
  OAUTH_STATE_COOKIE,
  buildAuthorizeUrl,
  newFlowState,
  oauthReturnUrl,
  safeReturnPath,
  sealFlowState,
} from "@/lib/connectors/oauth";

/**
 * Begin the tenant OAuth consent flow for one connector.
 *
 * Admin-only, and deliberately NOT in the proxy's public prefixes: this is a
 * browser navigation carrying a session cookie, so bouncing an unauthenticated
 * visitor to /login is the correct behaviour.
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
  const back = (status: string) =>
    NextResponse.redirect(
      oauthReturnUrl(returnTo, request.nextUrl.origin, name, status),
    );

  const connector = connectorRegistry.find((c) => c.name === name);
  const policy = connector?.auth;
  if (!connector || policy?.strategy !== "oauth2_authorization_code") {
    return back("unsupported");
  }

  /*
    Who is allowed to start this, and whose grant it becomes.

    A tenant connector is still admin-only: pressing Connect there authorises
    an account on behalf of everyone. A user-scoped one is the opposite — the
    grant is the person's own, so any signed-in user may start it and an admin
    check would only stop people connecting their own accounts.
  */
  const userScoped = connector.userScoped === true;
  if (!userScoped) await requireAdmin(session);
  const flowUserId = userScoped ? session.user.id : null;

  const [idKey] = policy.credentialKeys ?? ["clientId", "clientSecret"];
  const credentials = await getDecryptedConfig(name);
  const clientId = credentials?.[idKey];
  if (!clientId) {
    // The admin has to save the client id and secret before consent can start.
    return back("missing-client");
  }

  const flow = newFlowState(name, returnTo, flowUserId);
  const response = NextResponse.redirect(
    buildAuthorizeUrl(policy, { connector: name, clientId, flow }),
  );
  response.cookies.set(OAUTH_STATE_COOKIE, sealFlowState(flow), {
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
