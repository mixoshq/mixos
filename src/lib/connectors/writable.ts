/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createServiceClient } from "@/lib/db/server";
import { WRITABLE_KEY_PREFIX, connectorWritableKey } from "./switch-keys";

/**
 * Allow changes: whether a connector may change data on this install.
 *
 * One `platform_settings` row per connector an admin allowed, keyed
 * `connector.writable.<name>`, whose value is when. No row means read-only,
 * which is how every connector starts. Like the switch (./switch.ts), it is
 * kept in the database rather than in `connector.json`, so the person who
 * publishes a connector cannot allow it: only an admin of this install can.
 *
 * Read-only means a method the connector declares `mutates` is refused before
 * it runs, for every app (src/lib/apps/context.ts), and a scope the connector
 * requests with `"write"` is not asked for at Connect (./oauth.ts) or when a
 * client-credentials token is minted (./http-connector.ts). Allowing changes
 * lets an app whose entry says `"access": "write"` call those methods; an app
 * that only reads is narrowed to reads either way.
 */

/**
 * Which of `names` may change data.
 *
 * Throws when the setting cannot be read. Callers fail closed: a connector
 * whose setting is unknown is treated as read-only, never as allowed.
 */
export async function getWritableConnectors(names: readonly string[]): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  const { data, error } = await createServiceClient()
    .from("platform_settings")
    .select("key")
    .in("key", names.map(connectorWritableKey));
  if (error) throw error;
  return new Set(
    (data as { key: string }[]).map((row) => row.key.slice(WRITABLE_KEY_PREFIX.length)),
  );
}

export async function isConnectorWritable(connectorName: string): Promise<boolean> {
  return (await getWritableConnectors([connectorName])).has(connectorName);
}

/**
 * Allow a connector to change data, or make it read-only again. The caller is
 * responsible for `requireAdmin()` and the audit row; `setConnectorChanges()`
 * in ./writable-admin.ts does both.
 *
 * Allowing keeps the first timestamp when changes were already allowed, so the
 * row always says since when.
 */
export async function setConnectorWritable(connectorName: string, writable: boolean): Promise<void> {
  const settings = createServiceClient().from("platform_settings");
  const now = new Date().toISOString();
  const { error } = writable
    ? await settings.upsert(
        { key: connectorWritableKey(connectorName), value: now, updated_at: now },
        { onConflict: "key", ignoreDuplicates: true },
      )
    : await settings.delete().in("key", [connectorWritableKey(connectorName)]);
  if (error) throw error;
}
