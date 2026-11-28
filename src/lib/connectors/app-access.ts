/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { appRegistry } from "@/generated/app-registry";
import { connectorRegistry } from "@/generated/connector-registry";
import { sql } from "@/lib/db/client";
import { recordAdminAction, type AdminActor } from "@/lib/apps/admin-audit";
import type { AppNarrowing } from "./reach";

/**
 * An admin's narrowing of one app's reach on one connector, in
 * `connector_app_access` (supabase/migrations/0008_connector_app_access.sql).
 *
 * A third key below the app's manifest and the connector's Allow changes, per
 * app: take its writes away (`writes: "deny"`), or limit it to some of the
 * methods it could reach (`methods`). It only ever narrows, and it is enforced
 * where the app is handed the connector (`appReachRules`,
 * src/lib/apps/connector-reach.ts), on every path: routes, jobs, services,
 * MCP and search.
 */

/** Each of one app's narrowings, by connector. Throws when the table can't be read. */
export async function getAppNarrowings(appSlug: string): Promise<Map<string, AppNarrowing>> {
  const rows = await sql<{ connector_name: string; writes: "inherit" | "deny"; methods: string[] | null }[]>`
    select connector_name, writes, methods from public.connector_app_access where app_slug = ${appSlug}
  `;
  return new Map(rows.map((r) => [r.connector_name, { writes: r.writes, methods: r.methods }]));
}

/** Every app's narrowing on one connector, for its Reach section. Empty when unreadable: a view. */
export async function listConnectorNarrowings(connectorName: string): Promise<Record<string, AppNarrowing>> {
  try {
    const rows = await sql<{ app_slug: string; writes: "inherit" | "deny"; methods: string[] | null }[]>`
      select app_slug, writes, methods from public.connector_app_access where connector_name = ${connectorName}
    `;
    return Object.fromEntries(rows.map((r) => [r.app_slug, { writes: r.writes, methods: r.methods }]));
  } catch (err) {
    console.error(`[connectors] ${connectorName}: could not read apps' limits:`, err);
    return {};
  }
}

/** Why a narrowing can't be set. */
export class AppAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppAccessError";
  }
}

/**
 * Set, or clear, one app's narrowing on one connector. `methods` is kept to
 * the connector's declared methods; an empty list is refused, since an app
 * limited to nothing should be deactivated instead. No limit at all deletes
 * the row. Audited as `connector.app.access`, with what was set.
 */
export async function setAppNarrowing(
  actor: AdminActor,
  connectorName: string,
  appSlug: string,
  narrowing: AppNarrowing,
): Promise<void> {
  const connector = connectorRegistry.find((c) => c.name === connectorName);
  if (!connector) throw new AppAccessError(`No connector named "${connectorName}" is in this build.`);
  const app = appRegistry.find((a) => a.slug === appSlug);
  if (!app || !app.connectorRequirements.some((r) => r.name === connectorName)) {
    throw new AppAccessError(`${app?.name ?? appSlug} doesn't declare ${connector.displayName}.`);
  }
  const declared = new Set(connector.telemetry.map((t) => t.method));
  let methods: string[] | null = null;
  if (narrowing.methods !== null) {
    methods = [...new Set(narrowing.methods)].filter((m) => declared.has(m)).sort();
    if (methods.length === 0) {
      throw new AppAccessError("Leave at least one method, or deactivate the app if it shouldn't call this connector at all.");
    }
    // Every declared method allowed is no limit.
    if (methods.length === declared.size) methods = null;
  }
  const writes = narrowing.writes === "deny" ? "deny" : "inherit";

  if (writes === "inherit" && methods === null) {
    await sql`delete from public.connector_app_access where connector_name = ${connectorName} and app_slug = ${appSlug}`;
  } else {
    await sql`
      insert into public.connector_app_access (connector_name, app_slug, writes, methods, set_by)
      values (${connectorName}, ${appSlug}, ${writes}, ${methods}, ${actor.id})
      on conflict (connector_name, app_slug) do update
        set writes = excluded.writes, methods = excluded.methods, set_by = excluded.set_by, set_at = now()
    `;
  }
  await recordAdminAction(actor, {
    action: "connector.app.access",
    targetType: "connector",
    targetId: connectorName,
    details: { app: appSlug, writes, methods },
  });
}
