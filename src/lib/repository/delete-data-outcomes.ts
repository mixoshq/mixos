/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What Delete data answers (./delete-data.ts), as the admin pages read it: what
 * would go, what went, why it was refused, and the words for each.
 *
 * Types and text, and no imports a browser can't load: the dialogs use this
 * module, and ./delete-data.ts, which does the work, reads the database.
 */

import type { Refusal } from "./pending-outcomes";

/** The kinds that keep data. A theme holds none. */
export type DataKind = "app" | "connector";

export function isDataKind(kind: string): kind is DataKind {
  return kind === "app" || kind === "connector";
}

/** What this database keeps for an app, row by row. */
export interface AppDataCounts {
  /** Tables in its schema, `app_<slug>`. */
  tables: number;
  grants: number;
  installs: number;
  passwords: number;
  widgets: number;
  settings: number;
  apiKeys: number;
  /** Its switches in `app_mcp_tool_settings`, one per tool an admin flipped. */
  mcpToolSwitches: number;
  scheduledJobs: number;
  jobRuns: number;
  /** Its rows in `_migrations`, the record of which of its migrations ran. */
  migrations: number;
  /** Events it was the source of. */
  telemetryEvents: number;
  appOpens: number;
  /** MCP authorizations, tokens and codes, that list it among the apps they may read. */
  mcpAccess: number;
  /** Its own credentials for connectors, in `connector_app_configs`, one per connector. */
  connectorCredentials: number;
}

/** What this database keeps for a connector, row by row. */
export interface ConnectorDataCounts {
  /** Its row in `connector_configs`: 0 or 1. */
  credentials: number;
  /** Users' own connections, in `user_connector_oauth`. */
  connections: number;
  /** Apps' own credentials for it, in `connector_app_configs`, one per app. */
  appCredentials: number;
  scopeStatus: number;
  webhookEvents: number;
  telemetryEvents: number;
  /** Its keys in `platform_settings`: the missing mark, its identity, the switch, the replaced mark. */
  settings: number;
}

export type DataCounts = AppDataCounts | ConnectorDataCounts;

/** What Delete data would do now, and whether it would be refused. Reads only. */
export interface DataPreview {
  kind: DataKind;
  slug: string;
  /** The name the database recorded for an app, or the connector's name. */
  name: string;
  counts: DataCounts;
  /** An app's schema and role, when they exist. */
  schema: string | null;
  role: string | null;
  /** When a release step marked it missing (ISO 8601), or null. */
  markedAt: string | null;
  /** Why it would be refused now, or null. The deletion checks again. */
  refusal: Refusal | null;
}

export type DataPreviewOutcome = { ok: true; preview: DataPreview } | Refusal;

/** What Delete data deleted. */
export interface DataDeleted {
  kind: DataKind;
  slug: string;
  counts: DataCounts;
  schema: string | null;
  role: string | null;
}

export type DataDeleteOutcome = { ok: true; result: DataDeleted } | Refusal;

const n = (count: number, one: string, many: string) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

/** "a, b and c". */
function joined(parts: string[]): string {
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Each part with a count above zero, joined, or null when none is. */
function some(parts: [number, string, string][]): string | null {
  const shown = parts.filter(([count]) => count > 0).map(([count, one, many]) => n(count, one, many));
  return shown.length > 0 ? joined(shown) : null;
}

/**
 * What goes, a line for each kind of thing, for the dialogs. Lines with nothing
 * to delete are left out; the record of the extension itself is always there.
 */
export function describeData(
  kind: DataKind,
  counts: DataCounts,
  names: { schema: string | null; role: string | null },
): string[] {
  if (kind === "app") {
    const c = counts as AppDataCounts;
    const lines: string[] = [];
    if (names.schema) {
      lines.push(
        `Its schema, \`${names.schema}\`, with ${n(c.tables, "table", "tables")}` +
          (names.role ? `, and its database role, \`${names.role}\`` : ""),
      );
    } else if (names.role) {
      lines.push(`Its database role, \`${names.role}\``);
    }
    for (const line of [
      some([
        [c.grants, "grant", "grants"],
        [c.installs, "user install", "user installs"],
        [c.passwords, "password", "passwords"],
        [c.widgets, "dashboard widget", "dashboard widgets"],
      ]),
      some([
        [c.settings, "setting", "settings"],
        [c.apiKeys, "API key", "API keys"],
        [c.mcpToolSwitches, "MCP tool switch", "MCP tool switches"],
      ]),
      some([
        [c.scheduledJobs, "scheduled job", "scheduled jobs"],
        [c.jobRuns, "job run", "job runs"],
      ]),
      some([[c.migrations, "record of a migration that ran", "records of migrations that ran"]]),
      some([
        [c.telemetryEvents, "telemetry event", "telemetry events"],
        [c.appOpens, "recorded open", "recorded opens"],
      ]),
      c.mcpAccess > 0 ? `Its place in ${n(c.mcpAccess, "MCP authorization", "MCP authorizations")}` : null,
      c.connectorCredentials > 0
        ? `Its own credentials for ${n(c.connectorCredentials, "connector", "connectors")}`
        : null,
    ]) {
      if (line) lines.push(line);
    }
    lines.push("Its record here: whether it is active, where it came from, and any reviews of its code");
    return lines;
  }

  const c = counts as ConnectorDataCounts;
  const lines: string[] = [];
  if (c.credentials > 0) lines.push("Its saved credentials");
  if (c.appCredentials > 0) lines.push(`${n(c.appCredentials, "app's own credentials", "apps' own credentials")} for it`);
  for (const line of [
    some([[c.connections, "user's own connection", "users' own connections"]]),
    some([
      [c.scopeStatus, "record of granted scopes", "records of granted scopes"],
      [c.webhookEvents, "webhook replay marker", "webhook replay markers"],
      [c.telemetryEvents, "telemetry event", "telemetry events"],
    ]),
  ]) {
    if (line) lines.push(line);
  }
  if (c.settings > 0) lines.push("Its settings here: whether it is switched off, its marks, and where it came from");
  return lines;
}

/** What stays, for the dialogs. */
export const KEPT_AFTER_DELETE =
  "The audit log, which records this deletion too. Each other database keeps its own copy until an admin deletes it there.";
