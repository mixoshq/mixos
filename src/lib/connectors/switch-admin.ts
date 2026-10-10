/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { connectorRegistry } from "@/generated/connector-registry";
import { recordAdminAction, type AdminActor } from "@/lib/apps/admin-audit";
import { getConnectorDependents } from "./dependents";
import { setConnectorDisabled } from "./switch";

/**
 * Admin > Connectors' Disable and Enable: flip the switch (./switch.ts) and
 * record who did it.
 *
 * Not a server action. The caller has already been through `requireAdmin()`
 * and passes that admin in as `actor`; exported from a "use server" file, this
 * would let any caller name the actor.
 *
 * The audit row names the apps that declare the connector, as Disable's
 * confirmation did, so the log says what was affected at the time without
 * depending on which apps a later build carries.
 */
export async function setConnectorEnabled(
  connectorName: string,
  enabled: boolean,
  actor: AdminActor,
): Promise<void> {
  if (!connectorRegistry.some((c) => c.name === connectorName)) {
    throw new Error("Connector not found in registry");
  }

  await setConnectorDisabled(connectorName, !enabled);

  const dependents = getConnectorDependents(connectorName);
  await recordAdminAction(actor, {
    action: enabled ? "connector.enable" : "connector.disable",
    targetType: "connector",
    targetId: connectorName,
    details: {
      requiredBy: dependents.required,
      optionalFor: dependents.optional,
    },
  });
}
