/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { appRegistry } from "@/generated/app-registry";

/**
 * Which apps depend on a connector, and how hard that dependency is.
 *
 * Read from the app manifests rather than from what an admin has enabled: the
 * question this answers is "what does changing these credentials affect", and
 * an app that is disabled today still breaks when someone re-enables it. The
 * registry is also static, so this costs no query.
 */
export interface ConnectorDependents {
  /** Apps that declare it in `connectors` — they will not register without it. */
  required: string[];
  /** Apps that declare it in `optionalConnectors` — a part of them degrades. */
  optional: string[];
  /**
   * Apps of either kind whose entry asks for `"access": "write"`: what Allow
   * changes is for. Each is also in `required` or `optional`.
   */
  writes: string[];
}

export function getConnectorDependents(connectorName: string): ConnectorDependents {
  const required: string[] = [];
  const optional: string[] = [];
  const writes: string[] = [];

  for (const app of appRegistry) {
    // The schema allows one entry per connector across both lists.
    const need = app.connectorRequirements.find((r) => r.name === connectorName);
    if (!need) continue;
    (need.optional ? optional : required).push(app.name);
    if (need.access === "write") writes.push(app.name);
  }

  const byName = (a: string, b: string) => a.localeCompare(b);
  return {
    required: required.sort(byName),
    optional: optional.sort(byName),
    writes: writes.sort(byName),
  };
}

/** "4 apps require this connector and 2 additional apps depend on it." */
export function describeDependents(d: ConnectorDependents): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (d.required.length === 0 && d.optional.length === 0) {
    return "No app uses this connector yet.";
  }
  if (d.optional.length === 0) {
    return `${plural(d.required.length, "app")} require${d.required.length === 1 ? "s" : ""} this connector.`;
  }
  if (d.required.length === 0) {
    return `${plural(d.optional.length, "app")} depend${d.optional.length === 1 ? "s" : ""} on this connector for part of what ${d.optional.length === 1 ? "it does" : "they do"}.`;
  }
  return (
    `${plural(d.required.length, "app")} require${d.required.length === 1 ? "s" : ""} this connector ` +
    `and ${plural(d.optional.length, "additional app")} depend${d.optional.length === 1 ? "s" : ""} on it.`
  );
}
