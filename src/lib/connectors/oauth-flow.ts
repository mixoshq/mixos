/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { connectorRegistry } from "@/generated/connector-registry";
import { requireAdmin } from "@/lib/apps/access";
import { recordAdminAction, type AdminActor } from "@/lib/apps/admin-audit";
import type { SessionPayload } from "@/lib/auth/session";
import { getDecryptedConfig, saveConnectorTokens } from "./config";
import { isConnectorError } from "./errors";
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  newFlowState,
  sealFlowState,
  splitScopes,
  stateMatches,
  type OAuthFlowState,
} from "./oauth";
import { recordScopeStatus } from "./scope-status";
import { isConnectorDisabled } from "./switch";
import { saveUserTokens } from "./user-config";

/**
 * What the connector OAuth routes decide, apart from the request and the
 * response.
 *
 * `/api/connectors/<name>/oauth/start` and `/callback` read the session and the
 * flow cookie, hand them here, and turn the answer into a redirect. Keeping
 * every decision on this side of that line is what lets it be tested without a
 * request: which connector, whose grant, whether it is turned off, and what
 * gets written.
 */

type Session = Pick<SessionPayload, "user">;

export type OAuthStart =
  | { ok: true; authorizeUrl: string; sealedFlow: string }
  | { ok: false; outcome: "unsupported" | "disabled" | "missing-client" };

/** Begin the consent round trip for one connector. */
export async function startConnectorOAuth(
  name: string,
  session: Session,
  returnTo: string,
): Promise<OAuthStart> {
  const connector = connectorRegistry.find((c) => c.name === name);
  const policy = connector?.auth;
  if (!connector || policy?.strategy !== "oauth2_authorization_code") {
    return { ok: false, outcome: "unsupported" };
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

  // Turned off by an admin (./switch.ts): no round trip, so no new grant.
  if (await isConnectorDisabled(name)) return { ok: false, outcome: "disabled" };

  const [idKey] = policy.credentialKeys ?? ["clientId", "clientSecret"];
  const credentials = await getDecryptedConfig(name);
  const clientId = credentials?.[idKey];
  if (!clientId) {
    // The admin has to save the client id and secret before consent can start.
    return { ok: false, outcome: "missing-client" };
  }

  const flow = newFlowState(name, returnTo, flowUserId);
  return {
    ok: true,
    authorizeUrl: buildAuthorizeUrl(policy, { connector: name, clientId, flow }),
    sealedFlow: sealFlowState(flow),
  };
}

export type OAuthFinishOutcome =
  | "connected"
  | "expired"
  | "denied"
  | "state"
  | "unsupported"
  | "disabled"
  | "exchange-failed";

export interface OAuthFinish {
  outcome: OAuthFinishOutcome;
  /** The page whose cached render the new grant changes, when one was stored. */
  revalidate: string | null;
}

/**
 * Finish the consent round trip: verify it, exchange the code, and merge the
 * resulting tokens into the connector's encrypted credentials. A tenant
 * connector's new grant is recorded in the admin audit log, as
 * `connector.connect`.
 *
 * The outcome is reported as a coarse status, never as the provider's own
 * error text — those bodies routinely name the tenant, the account, and
 * occasionally the credential.
 */
export async function finishConnectorOAuth(opts: {
  name: string;
  session: Session;
  /** The opened flow cookie, or null when it was absent, stale or tampered. */
  flow: OAuthFlowState | null;
  params: URLSearchParams;
}): Promise<OAuthFinish> {
  const { name, session, flow, params } = opts;
  const finish = (outcome: OAuthFinishOutcome): OAuthFinish => ({
    outcome,
    revalidate: null,
  });

  // An absent or stale cookie means the flow expired, the key rotated, or this
  // callback was reached without a matching start. All are "begin again".
  if (!flow || flow.connector !== name) return finish("expired");

  if (params.get("error")) return finish("denied");

  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state || !stateMatches(state, flow.state)) return finish("state");

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
    reason. That admin is who the audit row names.
  */
  const userScoped = connector.userScoped === true;
  let admin: AdminActor | null = null;
  if (!userScoped) {
    const dbUser = await requireAdmin(session);
    admin = { id: dbUser.id, email: dbUser.email };
  } else if (!flow.userId || flow.userId !== session.user.id) {
    return finish("state");
  }

  // Turned off since the round trip began: the code is not exchanged, so no
  // grant is stored for a connector an admin has turned off.
  if (await isConnectorDisabled(name)) return finish("disabled");

  const [idKey, secretKey] = policy.credentialKeys ?? [
    "clientId",
    "clientSecret",
  ];
  const credentials = (await getDecryptedConfig(name)) ?? {};

  let granted: string[];
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
    granted = splitScopes(tokens.scope);

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
        granted,
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

  // A tenant grant is an admin acting for everyone, so it is audited, with the
  // scopes the provider granted and never a token. Only once it is stored, and
  // never able to fail it (recordAdminAction swallows its own errors). A
  // person's own grant, for a user-scoped connector, is theirs and isn't.
  if (admin) {
    await recordAdminAction(admin, {
      action: "connector.connect",
      targetType: "connector",
      targetId: name,
      details: { scopes: granted },
    });
  }

  return {
    outcome: "connected",
    revalidate: userScoped ? "/account/connections" : "/admin/connectors",
  };
}
