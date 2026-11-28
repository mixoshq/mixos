/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AppManifest } from "./types";

/**
 * What an app asks for, as a set an admin approves (Item 8,
 * src/lib/apps/capability-approvals.ts). One function reads it from the
 * manifest, and it is a set: reordering the manifest is no change, removing
 * something is no prompt, and only something new is.
 *
 * Pure, and safe on the client.
 */

export type CapabilityKind =
  | "global"
  | "egress"
  | "connector"
  | "optional-connector"
  | "connector-write"
  | "consumes"
  | "provides"
  | "listens"
  | "mcp"
  | "search"
  | "notifications"
  | "database"
  | "schedule"
  | "route-tier"
  | "branding";

export interface Capability {
  kind: CapabilityKind;
  /** What within the kind: a host, a connector, `<app>/<service>`, a tier. Empty for one with nothing within. */
  capability: string;
}

/**
 * The kinds an admin can deny while the app keeps running, because the app
 * already has to handle their absence (a missing optional connector, a null
 * `context.notifications`, a refused host or service). Everything else is all
 * or nothing: the app can't run without it, so it is approved with the app.
 * Connector writes are 7a's "Can't change data"; MCP tools have their own
 * switches.
 */
export const DENIABLE: ReadonlySet<CapabilityKind> = new Set(["egress", "optional-connector", "consumes", "notifications"]);

/** "egress:api.example.com", the key a capability is stored and compared by. */
export function capabilityKey(c: Capability): string {
  return `${c.kind}:${c.capability}`;
}

/** Every capability the manifest asks for, sorted, with no repeats. */
export function appCapabilities(app: Partial<Pick<
  AppManifest,
  | "global"
  | "egress"
  | "connectorRequirements"
  | "consumes"
  | "provides"
  | "listensTo"
  | "mcp"
  | "search"
  | "notifications"
  | "database"
  | "schedules"
  | "routes"
  | "branding"
>>): Capability[] {
  const out = new Map<string, Capability>();
  const add = (kind: CapabilityKind, capability = "") => out.set(`${kind}:${capability}`, { kind, capability });

  if (app.global) add("global");
  for (const host of app.egress ?? []) add("egress", host.toLowerCase());
  for (const need of app.connectorRequirements ?? []) {
    add(need.optional ? "optional-connector" : "connector", need.name);
    if (need.access === "write") add("connector-write", need.name);
  }
  for (const c of app.consumes ?? []) add("consumes", `${c.app}/${c.service}`);
  for (const s of app.provides ?? []) add("provides", s.name);
  for (const l of app.listensTo ?? []) add("listens", `${l.app}/${l.hook}`);
  for (const t of app.mcp ?? []) add("mcp", t.name);
  for (const s of app.search ?? []) add("search", s.name);
  if (app.notifications) add("notifications");
  if (app.database) add("database");
  for (const s of app.schedules ?? []) add("schedule", s.name);
  for (const route of app.routes ?? []) {
    for (const m of route.methods) {
      for (const tier of m.auth) if (tier === "public" || tier === "password" || tier === "key") add("route-tier", tier);
    }
  }
  for (const hook of app.branding?.hooks ?? []) add("branding", hook);

  return [...out.values()].sort((a, b) => capabilityKey(a).localeCompare(capabilityKey(b)));
}

/** What `now` asks for that `approved` doesn't hold, sorted. */
export function addedCapabilities(now: readonly Capability[], approved: ReadonlySet<string>): Capability[] {
  return now.filter((c) => !approved.has(capabilityKey(c)));
}

/** One capability in words, for the admin pages. */
export function describeCapability(c: Capability): string {
  switch (c.kind) {
    case "global":
      return "Everyone gets it, without a grant";
    case "egress":
      return `Reaches ${c.capability} itself`;
    case "connector":
      return `Uses the ${c.capability} connector`;
    case "optional-connector":
      return `Uses the ${c.capability} connector, if it is set up`;
    case "connector-write":
      return `Changes data through ${c.capability}`;
    case "consumes":
      return `Asks ${c.capability.replace("/", "'s ")} service`;
    case "provides":
      return `Offers the ${c.capability} service to other apps`;
    case "listens":
      return `Listens to ${c.capability.replace("/", "'s ")} hook`;
    case "mcp":
      return `Answers the ${c.capability} MCP tool`;
    case "search":
      return `Answers search for ${c.capability}`;
    case "notifications":
      return "Sends push notifications";
    case "database":
      return "Has tables of its own";
    case "schedule":
      return `Runs the ${c.capability} job`;
    case "route-tier":
      return c.capability === "public"
        ? "Has routes anyone can call, signed in or not"
        : c.capability === "password"
          ? "Has password-protected routes"
          : "Has routes an API key can call";
    case "branding":
      return `Changes the install's ${c.capability.replace(/-/g, " ")}`;
  }
}
