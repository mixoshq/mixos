/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createServiceClient } from "@/lib/db/server";
import { ConnectorError } from "./errors";
import type { BaseConnector } from "./types";

/**
 * The admin switch that turns a connector off.
 *
 * One `platform_settings` row per disabled connector, keyed
 * `connector.disabled.<name>`, whose value is when it was turned off. No row
 * means on. It is kept in the database rather than in `connector.json` so the
 * person who publishes a connector cannot flip it: only an admin of this
 * instance can.
 *
 * Off means nothing reaches the connector. Each place that would build or call
 * it asks here first and refuses:
 *
 *   - the app context (`loadTenantConnectors` in src/lib/apps/context.ts),
 *     which hands apps `disabledConnector()` instead of the connector, so MCP
 *     tools and App Services providers get it too;
 *   - the webhook route, which answers 401 as it does for a connector with no
 *     signing secret saved;
 *   - OAuth start and callback (./oauth-flow.ts);
 *   - Test Connection (./test-connection.ts).
 *
 * The credentials are not touched. Turning a connector back on needs nothing
 * re-entered, and turning it off is not how to get rid of a leaked secret:
 * revoke it at the provider and save a new one.
 */

const KEY_PREFIX = "connector.disabled.";

/** The `platform_settings` key that holds one connector's switch. */
export function connectorSwitchKey(connectorName: string): string {
  return `${KEY_PREFIX}${connectorName}`;
}

/**
 * Which of `names` are turned off, each with when it was.
 *
 * Throws when the setting cannot be read. A caller that cannot tell whether a
 * connector is off must not run it on the guess that it is on.
 */
export async function getDisabledConnectors(
  names: readonly string[],
): Promise<Map<string, string>> {
  if (names.length === 0) return new Map();
  const { data, error } = await createServiceClient()
    .from("platform_settings")
    .select("key, value")
    .in("key", names.map(connectorSwitchKey));
  if (error) throw error;
  return new Map(
    (data as { key: string; value: string }[]).map((row) => [
      row.key.slice(KEY_PREFIX.length),
      row.value,
    ]),
  );
}

export async function isConnectorDisabled(connectorName: string): Promise<boolean> {
  return (await getDisabledConnectors([connectorName])).has(connectorName);
}

/**
 * Turn a connector off or back on. The caller is responsible for
 * `requireAdmin()` and for the audit row; `setConnectorEnabled()` in
 * ./switch-admin.ts does both.
 *
 * Turning off keeps the first timestamp when the connector is already off, so
 * the row always says when it went off. Turning on deletes the row.
 */
export async function setConnectorDisabled(
  connectorName: string,
  disabled: boolean,
): Promise<void> {
  const settings = createServiceClient().from("platform_settings");
  const now = new Date().toISOString();
  const { error } = disabled
    ? await settings.upsert(
        { key: connectorSwitchKey(connectorName), value: now, updated_at: now },
        { onConflict: "key", ignoreDuplicates: true },
      )
    : await settings.delete().eq("key", connectorSwitchKey(connectorName));
  if (error) throw error;
}

/**
 * What a call to a disabled connector fails with.
 *
 * The `unconfigured` category, with its own message: an app already handles
 * that category as "an administrator has to act", and its envelope is a 503
 * with no Retry, which is right for a connector that stays off until someone
 * turns it back on. The message is what tells the two apart.
 */
export class ConnectorDisabledError extends ConnectorError {
  constructor(connectorName: string, subject: string = connectorName) {
    super({
      category: "unconfigured",
      connectorName,
      subject,
      userMessage: `${subject} has been disabled by an administrator.`,
      adminHint:
        "Enable it in Administration → Connectors. Its credentials were kept, so nothing needs to be entered again.",
    });
  }
}

const DISABLED = Symbol.for("mixos.connector.disabled");

/**
 * What `context.connectors.<name>` holds for a disabled connector.
 *
 * Not the connector: it is never imported, constructed or given credentials.
 * Every method called on this fails with `ConnectorDisabledError`, as a
 * rejected promise, the way a connector's own async methods fail. `configured`
 * is false, so an app that checks it first treats this as it would a connector
 * nobody has set up.
 */
export function disabledConnector(
  connectorName: string,
  subject: string = connectorName,
): BaseConnector {
  const target = { name: connectorName, configured: false, [DISABLED]: true };
  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return Reflect.get(t, prop);
      // Not a thenable and not something JSON.stringify calls, so awaiting or
      // logging the object does not set off the refusal.
      if (typeof prop !== "string" || prop === "then" || prop === "toJSON") {
        return undefined;
      }
      return () =>
        Promise.reject(new ConnectorDisabledError(connectorName, subject));
    },
  }) as unknown as BaseConnector;
}

/** Whether `value` is the stand-in `disabledConnector()` returns. */
export function isDisabledConnector(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [DISABLED]?: unknown })[DISABLED] === true
  );
}
