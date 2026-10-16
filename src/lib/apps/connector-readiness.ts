/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Why a connector an app requires can't serve it yet, and the words for it.
 *
 * Pure, and safe on the client. The gate that decides (./connector-gates.ts)
 * reads credentials and the database; the admin screens that say what to do
 * about it are client components. The states and their labels are the
 * Connector Registry's own, so the two screens never call one condition by
 * two names.
 */

/** A state that keeps an app from being activated or granted. */
export type ConnectorBlock = "unconfigured" | "needs-authorization" | "disabled";

/** A connector an app requires that isn't ready to serve it. */
export interface MissingConnector {
  name: string;
  displayName: string;
  state: ConnectorBlock;
}

/** As the Connector Registry labels each state. */
export const BLOCK_LABEL: Record<ConnectorBlock, string> = {
  unconfigured: "Not configured",
  "needs-authorization": "Needs authorization",
  disabled: "Disabled",
};

/** What an admin does about each, in the Connector Registry. */
const STEP: Record<ConnectorBlock, string> = {
  unconfigured: "configure",
  "needs-authorization": "connect",
  disabled: "enable",
};

/** What each is once it is done: "until Gong is connected". */
const DONE: Record<ConnectorBlock, string> = {
  unconfigured: "configured",
  "needs-authorization": "connected",
  disabled: "enabled",
};

/** "A", "A and B", "A, B and C". */
export function conjoin(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The connectors grouped by state, in the order each state first appears. */
export function groupByBlock(
  missing: readonly MissingConnector[],
): [ConnectorBlock, MissingConnector[]][] {
  const groups = new Map<ConnectorBlock, MissingConnector[]>();
  for (const m of missing) {
    const group = groups.get(m.state) ?? [];
    group.push(m);
    groups.set(m.state, group);
  }
  return [...groups];
}

/**
 * What an admin has to do, as one imperative clause: "Configure Acme CRM",
 * "Connect Google Drive and enable Slack". A clause naming two connectors
 * gets a comma before the next one, so "and" never joins two lists at once.
 */
export function missingConnectorSteps(missing: readonly MissingConnector[]): string {
  const clauses = groupByBlock(missing).map(
    ([state, group]) => `${STEP[state]} ${conjoin(group.map((m) => m.displayName))}`,
  );
  const text =
    clauses.length > 1 && clauses.some((c) => c.includes(" and "))
      ? `${clauses.slice(0, -1).join(", ")}, and ${clauses[clauses.length - 1]}`
      : conjoin(clauses);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The participle for a state: "configured", "connected", "enabled". */
export function blockDone(state: ConnectorBlock): string {
  return DONE[state];
}
