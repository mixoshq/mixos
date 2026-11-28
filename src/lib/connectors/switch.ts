/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createServiceClient } from "@/lib/db/server";
import { identitySettingKey } from "@/lib/repository/identity";
import { ConnectorError } from "./errors";
import {
  REPLACED_KEY_PREFIX,
  SWITCH_KEY_PREFIX,
  connectorReplacedKey,
  connectorSwitchKey,
} from "./switch-keys";
import type { BaseConnector } from "./types";

export { connectorSwitchKey };

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
 *
 * The release step turns a connector off too, when a different connector has
 * taken its name (scripts/sync-identities.ts), and marks it replaced
 * (`connector.replaced.<name>`, ./switch-keys.ts). Its credentials were saved
 * for the connector before it, so enabling it then needs its name typed.
 */

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
      row.key.slice(SWITCH_KEY_PREFIX.length),
      row.value,
    ]),
  );
}

export async function isConnectorDisabled(connectorName: string): Promise<boolean> {
  return (await getDisabledConnectors([connectorName])).has(connectorName);
}

/** A connector the release step found under a name a different one had. */
export interface ConnectorReplacement {
  /** When the release step marked it (ISO 8601). */
  at: string;
  /** The identity it replaced, and the one it has (src/lib/repository/identity.ts). */
  previous: string;
  identity: string | null;
}

/**
 * Which of `names` the release step marked as replacing a different connector.
 * Enabling one needs its name typed (setConnectorEnabled() in ./switch-admin.ts).
 *
 * Throws when the marks cannot be read, as getDisabledConnectors() does.
 */
export async function getReplacedConnectors(
  names: readonly string[],
): Promise<Map<string, ConnectorReplacement>> {
  if (names.length === 0) return new Map();
  const { data, error } = await createServiceClient()
    .from("platform_settings")
    .select("key, value, updated_at")
    .in("key", [
      ...names.map(connectorReplacedKey),
      ...names.map((name) => identitySettingKey("connector", name)),
    ]);
  if (error) throw error;
  const rows = data as { key: string; value: string; updated_at: string }[];
  const identities = new Map(rows.map((row) => [row.key, row.value]));
  const replaced = new Map<string, ConnectorReplacement>();
  for (const row of rows) {
    if (!row.key.startsWith(REPLACED_KEY_PREFIX)) continue;
    const name = row.key.slice(REPLACED_KEY_PREFIX.length);
    replaced.set(name, {
      at: new Date(row.updated_at).toISOString(),
      previous: row.value,
      identity: identities.get(identitySettingKey("connector", name)) ?? null,
    });
  }
  return replaced;
}

/**
 * Turn a connector off or back on. The caller is responsible for
 * `requireAdmin()`, for the audit row, and for a typed name when the connector
 * is marked replaced; `setConnectorEnabled()` in ./switch-admin.ts does all
 * three.
 *
 * Turning off keeps the first timestamp when the connector is already off, so
 * the row always says when it went off. Turning on deletes the row, and the
 * mark that a different connector took the name.
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
    : await settings
        .delete()
        .in("key", [connectorSwitchKey(connectorName), connectorReplacedKey(connectorName)]);
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
  /** Told of each call it refuses, for detection (src/lib/apps/detection.ts). */
  onCall?: (method: string) => void,
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
      return () => {
        onCall?.(prop);
        return Promise.reject(new ConnectorDisabledError(connectorName, subject));
      };
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
