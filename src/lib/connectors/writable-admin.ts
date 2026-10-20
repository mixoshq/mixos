/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { connectorRegistry } from "@/generated/connector-registry";
import { recordAdminAction, type AdminActor } from "@/lib/apps/admin-audit";
import { getConnectorDependents } from "./dependents";
import { setConnectorWritable } from "./writable";
import { declaresWrites, writeMethods } from "./write-policy";

/**
 * Admin > Connectors' Allow changes: set it (./writable.ts) and record who did.
 *
 * Not a server action, for the reason ./switch-admin.ts gives: the caller has
 * already been through `requireAdmin()` and passes that admin in as `actor`.
 *
 * The audit row names the methods allowing changes unlocks and the apps that
 * asked for them, as they were at the time, so the log says what was granted
 * without depending on what a later build carries.
 */
export async function setConnectorChanges(
  connectorName: string,
  allowed: boolean,
  actor: AdminActor,
): Promise<void> {
  const manifest = connectorRegistry.find((c) => c.name === connectorName);
  if (!manifest) throw new Error("Connector not found in registry");
  if (allowed && !declaresWrites(manifest)) {
    throw new Error(`${manifest.displayName} has no method that changes data, so there is nothing to allow.`);
  }

  await setConnectorWritable(connectorName, allowed);

  await recordAdminAction(actor, {
    action: allowed ? "connector.allow-changes" : "connector.disallow-changes",
    targetType: "connector",
    targetId: connectorName,
    details: {
      methods: writeMethods(manifest).map((m) => m.method),
      neededBy: getConnectorDependents(connectorName).writes,
    },
  });
}
