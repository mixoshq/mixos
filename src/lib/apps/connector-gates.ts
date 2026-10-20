/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { appRegistry } from "@/generated/app-registry";
import { connectorRegistry } from "@/generated/connector-registry";
import { grantedScopes } from "@/lib/connectors/access";
import { getDecryptedConfig } from "@/lib/connectors/config";
import type { ConnectorRequirement } from "@/lib/connectors/requirements";
import { registryConfigState } from "@/lib/connectors/status";
import { getDisabledConnectors } from "@/lib/connectors/switch";
import { getWritableConnectors } from "@/lib/connectors/writable";
import { grantHoldsWriteScopes } from "@/lib/connectors/write-policy";
import {
  missingConnectorSteps,
  type ConnectorBlock,
  type MissingConnector,
} from "./connector-readiness";

/**
 * UX gate that pre-empts confusing runtime failures by refusing to activate an
 * app, or grant it to anyone, while a connector it requires can't serve it.
 * This is not a security boundary: runtime widgets and routes still degrade
 * gracefully if state changes afterwards.
 *
 * Each connector it reports carries why (./connector-readiness.ts), so callers
 * can say what to do without re-resolving the registry.
 */

export type { MissingConnector } from "./connector-readiness";
export { missingConnectorSteps };

/**
 * Why one connector can't serve the app's requests, or null when it can.
 *
 * READINESS IS THE CONNECTOR REGISTRY'S RULE (`registryConfigState`, in
 * src/lib/connectors/status.ts). A `connector_configs` row existing is not
 * enough: for a three-legged OAuth connector that row appears the moment an
 * admin saves the client ID and secret, before anyone presses Connect, and the
 * connector refuses every call until then.
 * Under the registry's rule a tenant connector has to be `ready`. A
 * user-scoped one only needs its client credentials, because each person's
 * grant is their own and is never stored tenant-wide. A connector that asks
 * for no credentials at all is ready as soon as it is installed.
 *
 * An admin's switch comes first: a disabled connector refuses every call
 * however complete its credentials are (src/lib/connectors/switch.ts).
 *
 * An app that changes data in the connector also needs its admin to have
 * allowed changes (src/lib/connectors/writable.ts). A tenant OAuth grant taken
 * before that holds only the read scopes, so the connector needs connecting
 * again until it holds the ones it requests with "write".
 */
async function connectorBlock(
  name: string,
  disabled: ReadonlySet<string>,
  writable: ReadonlySet<string>,
  need: ConnectorRequirement | undefined,
): Promise<ConnectorBlock | null> {
  const connector = connectorRegistry.find((c) => c.name === name);
  if (!connector) return "unconfigured";
  if (disabled.has(name)) return "disabled";

  let credentials: Record<string, string> | null;
  try {
    credentials = await getDecryptedConfig(name);
  } catch (err) {
    // Credentials that can't be decrypted (the key changed, say) can't serve
    // a call either. The admin pages still render, with the connector shown
    // as not configured, rather than failing on the one row.
    console.error(`[connector-gates] ${name}: stored credentials unreadable:`, err);
    return "unconfigured";
  }

  const state = registryConfigState(connector, credentials);
  if (state !== "ready") return state;

  if (need?.access === "write") {
    if (!writable.has(name)) return "read-only";
    if (connector.auth?.strategy === "oauth2_authorization_code" && !connector.userScoped) {
      const { granted, grantedKnown } = grantedScopes(credentials);
      if (grantHoldsWriteScopes(connector.auth, granted, grantedKnown) === false) {
        return "needs-authorization";
      }
    }
  }
  return null;
}

/**
 * Connectors declared by the app that are not ready to serve it.
 *
 * Connector names declared in app.json that aren't in the registry at all
 * are reported as unconfigured with displayName === name, so the admin sees
 * something actionable rather than silently passing the gate.
 *
 * `forDisplay` is for a page that only shows the answer. See below.
 */
export async function getMissingTenantConfigConnectors(
  appSlug: string,
  { forDisplay = false }: { forDisplay?: boolean } = {},
): Promise<MissingConnector[]> {
  const app = appRegistry.find((a) => a.slug === appSlug);
  if (!app || app.connectors.length === 0) return [];

  // `app.connectors` only, never `optionalConnectors`: refusing an app because
  // an optional connector is unconfigured is precisely what makes it not
  // optional. The sub-component that needs it degrades instead.
  //
  // The switch is read once for all of them. When it can't be read, the gate
  // throws: one that can't tell whether a connector is off must not pass it on
  // the guess that it is on. A page that only shows the answer is drawn from
  // the credentials alone instead, and the error is logged: the activation
  // or grant it offers reads the switch again, and fails rather than pass.
  let disabled: ReadonlySet<string>;
  try {
    disabled = new Set((await getDisabledConnectors(app.connectors)).keys());
  } catch (err) {
    if (!forDisplay) throw err;
    console.error(
      `[connector-gates] ${appSlug}: could not read which connectors are disabled; showing their credentials alone:`,
      err,
    );
    disabled = new Set();
  }
  // Allow changes, for the connectors this app asks to change data in, read
  // the same way: a gate that can't tell refuses, and a page that only shows
  // the answer shows the connector as read-only. An app that only reads asks
  // nothing of it, so nothing is read.
  const writers = app.connectorRequirements
    .filter((r) => !r.optional && r.access === "write")
    .map((r) => r.name);
  let writable: ReadonlySet<string> = new Set();
  try {
    if (writers.length > 0) writable = await getWritableConnectors(writers);
  } catch (err) {
    if (!forDisplay) throw err;
    console.error(
      `[connector-gates] ${appSlug}: could not read which connectors may change data; showing them as read-only:`,
      err,
    );
    writable = new Set();
  }
  const checks = await Promise.all(
    app.connectors.map(async (name): Promise<MissingConnector | null> => {
      const need = app.connectorRequirements.find((r) => r.name === name);
      const state = await connectorBlock(name, disabled, writable, need);
      if (state === null) return null;
      const meta = connectorRegistry.find((c) => c.name === name);
      return { name, displayName: meta?.displayName ?? name, state };
    }),
  );

  return checks.filter((c): c is MissingConnector => c !== null);
}
