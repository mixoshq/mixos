/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { requireReadOnlySession } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/apps/access";
import { connectorRegistry } from "@/generated/connector-registry";
import { recordScopeStatus } from "@/lib/connectors/scope-status";
import {
  getDecryptedConfig,
  saveConnectorTokens,
} from "@/lib/connectors/config";
import { saveUserTokens } from "@/lib/connectors/user-config";
import { isConnectorError } from "@/lib/connectors/errors";
import {
  OAUTH_STATE_COOKIE,
  exchangeAuthorizationCode,
  oauthReturnUrl,
  openFlowState,
  splitScopes,
  stateMatches,
} from "@/lib/connectors/oauth";

/**
 * Finish the tenant OAuth consent flow: verify the round trip, exchange the
 * code, and merge the resulting tokens into the connector's encrypted
 * credentials.
 *
 * Outcomes are reported to the admin as a coarse `?oauth=` status, never as the
 * provider's own error text — those bodies routinely name the tenant, the
 * account, and occasionally the credential.
 */
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ name: string }> },
) {
  const session = await requireReadOnlySession();

  const { name } = await ctx.params;
  const flow = openFlowState(request.cookies.get(OAUTH_STATE_COOKIE)?.value);
  const returnTo = flow?.returnTo ?? "/admin/connectors";

  const finish = (status: string) => {
    const response = NextResponse.redirect(
      oauthReturnUrl(returnTo, request.nextUrl.origin, name, status),
    );
    // One-shot: the flow cookie never outlives the round trip it authorises.
    response.cookies.delete({
      name: OAUTH_STATE_COOKIE,
      path: "/api/connectors",
    });
    return response;
  };

  // An absent or stale cookie means the flow expired, the key rotated, or this
  // callback was reached without a matching start. All are "begin again".
  if (!flow || flow.connector !== name) return finish("expired");

  const params = request.nextUrl.searchParams;
  if (params.get("error")) return finish("denied");

  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state || !stateMatches(state, flow.state))
    return finish("state");

  const connector = connectorRegistry.find((c) => c.name === name);
  const policy = connector?.auth;
  if (!connector || policy?.strategy !== "oauth2_authorization_code") {
    return finish("unsupported");
  }

  /*
    Whose grant is this, and is that still who is here?

    The flow cookie records who started it. If the session changed during the
    round trip — a shared machine, a re-login in another tab — writing the
    returned tokens to the *current* session would file one person's access
    under another person's name. Refusing is the only safe answer; the cookie is
    the only thing that knows the original intent.

    A tenant flow carries no owner and stays admin-only, checked here rather
    than at the top so a user-scoped callback is not rejected for the wrong
    reason.
  */
  const userScoped = connector.userScoped === true;
  if (!userScoped) {
    await requireAdmin(session);
  } else if (!flow.userId || flow.userId !== session.user.id) {
    return finish("state");
  }

  const [idKey, secretKey] = policy.credentialKeys ?? [
    "clientId",
    "clientSecret",
  ];
  const credentials = (await getDecryptedConfig(name)) ?? {};

  try {
    const tokens = await exchangeAuthorizationCode({
      policy,
      connectorName: name,
      subject: connector.displayName,
      clientId: credentials[idKey] ?? "",
      clientSecret: credentials[secretKey] ?? "",
      code,
      codeVerifier: flow.codeVerifier,
    });
    if (userScoped) {
      // Only the grant is personal — the client id and secret above stay where
      // the admin put them.
      await saveUserTokens(session.user.id, name, tokens);
    } else {
      await saveConnectorTokens(name, tokens);
    }

    // Snapshot what the provider actually granted, against what the manifest
    // documents. This is the only moment the answer can change.
    //
    // Deliberately after the tokens are stored and deliberately swallowed: the
    // grant is the thing that matters and it is already safe, so a reporting
    // write must never turn a successful authorization into a failed one.
    try {
      await recordScopeStatus({
        connectorName: name,
        scopes: policy.scopes ?? [],
        granted: splitScopes(tokens.scope),
        userId: userScoped ? session.user.id : null,
      });
    } catch (err) {
      console.error(`[connector-oauth] ${name} scope snapshot failed:`, err);
    }
  } catch (err) {
    // Log our own classification only — never the upstream body.
    console.error(
      `[connector-oauth] ${name} code exchange failed:`,
      isConnectorError(err) ? `${err.category} (HTTP ${err.status})` : err,
    );
    return finish("exchange-failed");
  }

  revalidatePath(userScoped ? "/account/connections" : "/admin/connectors");
  return finish("connected");
}
