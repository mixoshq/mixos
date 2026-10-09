/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { HttpConnector, TOKEN_SKEW_MS } from "./http-connector";
import { TOKEN_KEYS } from "./oauth";
import { getValidUserTokens, refreshUserTokens } from "./user-config";
import type { BaseConnector, ConnectorManifest } from "./types";

/**
 * Hand a user-scoped connector one person's grant.
 *
 * Shared by the context builder, which does it for the caller of every
 * request, and by Test Connection, which does it for the admin running the
 * test — so the two cannot disagree about what "connected" means.
 *
 * Returns false, leaving the instance untouched, when that person holds no
 * usable grant: never connected, or a grant the provider will no longer renew.
 * Otherwise the grant is renewed first if its access token has expired, the
 * instance is bound to it — so a token that expires mid-request is renewed
 * against the same grant, never the tenant row — and initialized.
 */
export async function initializeWithUserGrant(
  instance: BaseConnector,
  opts: {
    userId: string;
    manifest: Pick<ConnectorManifest, "name" | "displayName" | "auth">;
    /** The tenant row, which holds the application's client id and secret. */
    tenantCredentials: Record<string, string> | null;
  },
): Promise<boolean> {
  const { userId, manifest } = opts;
  const policy = manifest.auth ?? { strategy: "none" };
  const [idKey, secretKey] = policy.credentialKeys ?? [
    "clientId",
    "clientSecret",
  ];

  // Only the grant is personal. The tenant row contributes the application's
  // credentials and nothing else: a token in it is not this person's to use.
  const application = withoutGrant(opts.tenantCredentials ?? {});

  const refresh = () =>
    refreshUserTokens({
      userId,
      connectorName: manifest.name,
      subject: manifest.displayName,
      policy,
      clientId: application[idKey] ?? "",
      clientSecret: application[secretKey] ?? "",
      skewMs: TOKEN_SKEW_MS,
    });

  const grant = await getValidUserTokens({
    userId,
    connectorName: manifest.name,
    refresh,
    skewMs: TOKEN_SKEW_MS,
  });
  if (!grant) return false;

  HttpConnector.bindUserGrant(instance, refresh);
  await instance.initialize({ ...application, ...grant });
  return true;
}

const GRANT_KEYS: ReadonlySet<string> = new Set(Object.values(TOKEN_KEYS));

function withoutGrant(
  credentials: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(credentials).filter(([key]) => !GRANT_KEYS.has(key)),
  );
}
