/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { connectorRegistry } from "@/generated/connector-registry";
import { recordAdminAction, type AdminActor } from "@/lib/apps/admin-audit";
import { identityDetails } from "@/lib/repository/identity";
import { getConnectorDependents } from "./dependents";
import { getReplacedConnectors, setConnectorDisabled } from "./switch";

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
 *
 * A connector the release step marked as replacing a different one is enabled
 * only with its name typed, `typedName`: the credentials it would be handed
 * were saved for the connector before it. Enabling it clears the mark, and its
 * row records the identity it replaced.
 */
export async function setConnectorEnabled(
  connectorName: string,
  enabled: boolean,
  actor: AdminActor,
  typedName?: string,
): Promise<void> {
  if (!connectorRegistry.some((c) => c.name === connectorName)) {
    throw new Error("Connector not found in registry");
  }

  const replacement = enabled
    ? (await getReplacedConnectors([connectorName])).get(connectorName)
    : undefined;
  if (replacement && typedName?.trim() !== connectorName) {
    throw new Error(
      `${connectorName} replaces a different connector with the same name. Type its name to enable it.`,
    );
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
      ...(replacement ? { replaced: identityDetails(replacement.previous) } : {}),
    },
  });
}
