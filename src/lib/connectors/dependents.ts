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
}

export function getConnectorDependents(connectorName: string): ConnectorDependents {
  const required: string[] = [];
  const optional: string[] = [];

  for (const app of appRegistry) {
    if (app.connectors.includes(connectorName)) {
      required.push(app.name);
    } else if ((app.optionalConnectors ?? []).includes(connectorName)) {
      // `else if`, so an app declaring the same connector both ways is counted
      // once, as required — the stricter of the two claims is the true one.
      optional.push(app.name);
    }
  }

  return {
    required: required.sort((a, b) => a.localeCompare(b)),
    optional: optional.sort((a, b) => a.localeCompare(b)),
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
