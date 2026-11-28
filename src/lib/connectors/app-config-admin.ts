/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { recordAdminAction, redactedKeys, type AdminActor } from "@/lib/apps/admin-audit";
import {
  AppCredentialsError,
  appCredentialTarget,
  deleteAppConnectorConfig,
  getDecryptedAppConfig,
  recordAppConnectorVerified,
  saveAppConnectorConfig,
} from "./app-config";
import { registryConfigState } from "./status";
import { runConnectorTest, type ConnectorTestOutcome } from "./test-connection";

/**
 * An admin giving one app its own credentials for a tenant connector, testing
 * them, and taking them away (./app-config.ts), each audited. Kept apart from
 * the page so the rules and the audit rows can be tested without a request:
 * the page's server actions check the session and the admin, then call these.
 *
 * Audited in the words the shared credentials use, with `app` in `details`:
 * `connector.configure` (which credential keys were given, never their
 * values; `removed: true` for taking them away), `connector.test`, and, from
 * the OAuth callback (./oauth-flow.ts), `connector.connect`.
 */

/**
 * Save what was typed for one app, merged over what it has. Whether it now
 * holds a usable set; false, saving nothing, for an app or connector that
 * can't have its own.
 */
export async function configureAppCredentials(
  actor: AdminActor,
  connectorName: string,
  appSlug: string,
  typed: Record<string, string>,
): Promise<boolean> {
  let target: ReturnType<typeof appCredentialTarget>;
  try {
    target = appCredentialTarget(connectorName, appSlug);
  } catch (err) {
    if (err instanceof AppCredentialsError) return false;
    throw err;
  }
  // Only the connector's own fields, and only those filled in: a blank field
  // keeps what is stored.
  const credentials: Record<string, string> = {};
  for (const field of target.connector.credentialFields) {
    const value = typed[field.key];
    if (typeof value === "string" && value) credentials[field.key] = value;
  }
  await saveAppConnectorConfig(connectorName, appSlug, credentials, actor.id);
  await recordAdminAction(actor, {
    action: "connector.configure",
    targetType: "connector",
    targetId: connectorName,
    details: { app: appSlug, fields: redactedKeys(credentials) },
  });
  const stored = await getDecryptedAppConfig(connectorName, appSlug);
  return registryConfigState(target.connector, stored) !== "unconfigured";
}

/** Verify connection with one app's own credentials; a success is recorded on its row. */
export async function testAppCredentials(
  actor: AdminActor,
  connectorName: string,
  appSlug: string,
): Promise<ConnectorTestOutcome> {
  const outcome = await runConnectorTest(connectorName, { appSlug });
  await recordAdminAction(actor, {
    action: "connector.test",
    targetType: "connector",
    targetId: connectorName,
    details: { ok: outcome.ok, app: appSlug },
  });
  if (outcome.ok) await recordAppConnectorVerified(connectorName, appSlug, outcome.detail);
  return outcome;
}

/**
 * Take one app's own credentials away: it uses the shared ones from its next
 * request. Whether it had any.
 */
export async function removeAppCredentials(
  actor: AdminActor,
  connectorName: string,
  appSlug: string,
): Promise<boolean> {
  try {
    appCredentialTarget(connectorName, appSlug);
  } catch (err) {
    if (err instanceof AppCredentialsError) return false;
    throw err;
  }
  const removed = await deleteAppConnectorConfig(connectorName, appSlug);
  if (removed) {
    await recordAdminAction(actor, {
      action: "connector.configure",
      targetType: "connector",
      targetId: connectorName,
      details: { app: appSlug, removed: true },
    });
  }
  return removed;
}
