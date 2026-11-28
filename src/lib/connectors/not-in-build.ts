/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { sql } from "@/lib/db/client";
import { MISSING_KEY_PREFIX } from "./switch-keys";

/** A connector this database keeps data for that the running build doesn't carry. */
export interface ConnectorNotInBuild {
  name: string;
  /** When a release step marked it missing (ISO 8601). Null when none has yet. */
  missingSince: string | null;
  /** Whether its credentials are saved here. */
  credentials: boolean;
  /** How many users connected their own account to it. */
  connections: number;
}

/**
 * The connectors Admin > Connectors lists under Not in this build: those whose
 * credentials or users' connections this database keeps, or that a release
 * step marked missing (scripts/sync-identities.ts), and that the build serving
 * the request doesn't carry. A connector keeps them after it leaves the build,
 * until an admin deletes them (src/lib/repository/delete-data.ts).
 *
 * Empty when the read fails: it is a list beside the grid, and the grid should
 * still render without it.
 */
export async function getConnectorsNotInBuild(inBuild: readonly string[]): Promise<ConnectorNotInBuild[]> {
  try {
    const rows = await sql<{ name: string; missing_since: string | null; credentials: boolean; connections: number }[]>`
      with kept as (
        select connector_name as name from public.connector_configs
        union
        select connector_name from public.user_connector_oauth
        union
        select connector_name from public.connector_app_configs
        union
        select substr(key, ${MISSING_KEY_PREFIX.length + 1}) from public.platform_settings
        where starts_with(key, ${MISSING_KEY_PREFIX})
      )
      select
        k.name,
        (select value from public.platform_settings where key = ${MISSING_KEY_PREFIX}::text || k.name) as missing_since,
        exists (select 1 from public.connector_configs c where c.connector_name = k.name) as credentials,
        (select count(*)::int from public.user_connector_oauth u where u.connector_name = k.name) as connections
      from kept k
      where not (k.name = any(${[...inBuild]}))
      order by k.name
    `;
    return rows.map((r) => ({
      name: r.name,
      missingSince: r.missing_since,
      credentials: r.credentials,
      connections: r.connections,
    }));
  } catch (err) {
    console.error("[connectors] couldn't read connectors kept outside this build:", err);
    return [];
  }
}
