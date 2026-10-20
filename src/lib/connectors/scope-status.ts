/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { sql } from "@/lib/db/client";
import type { ConnectorScope } from "./types";
import { isScopeRequested } from "./write-policy";

/**
 * What the provider actually granted, per scope.
 *
 * The catalogue of what an API offers lives in `connector.json` — it is a
 * property of the connector and belongs with the code. This is the half the
 * manifest cannot know: which of those scopes this deployment actually holds.
 *
 * Written once, at the OAuth callback, because that is the only moment the
 * answer can change. Recomputing it on every render would produce the same
 * numbers at more cost; recording it means the registry can show that a
 * connector update added a scope and this install is still running on the
 * older, narrower grant — which otherwise surfaces only as calls quietly
 * beginning to fail.
 */

export type ScopeStatus = "granted" | "refused" | "unknown";

export interface ScopeStatusRow {
  scope: string;
  status: ScopeStatus;
  /** Epoch millis of the grant this verdict was taken from. */
  recordedAt: number;
}

/**
 * Classify every documented scope against a grant.
 *
 * Exported for its own sake: it is pure, and it is the rule the whole feature
 * turns on, so it should be testable without a database.
 *
 * `unknown` deliberately carries most of the rows. A scope the provider
 * documents but this connector never asks for is not a fault, and rendering
 * those as refused would report a dozen failures on a healthy connector. A
 * scope requested only once changes are allowed is one of them on a grant
 * that didn't ask for it: `writes` is what the authorization asked.
 */
export function classifyGrant(
  scopes: ConnectorScope[],
  granted: string[],
  { writes = false }: { writes?: boolean } = {},
): Array<{ scope: string; status: ScopeStatus }> {
  const held = new Set(granted);
  return scopes.map((s) => ({
    scope: s.scope,
    status: !isScopeRequested(s, writes) ? "unknown" : held.has(s.scope) ? "granted" : "refused",
  }));
}

/**
 * Snapshot a grant. Call this after the token exchange has stored `oauth_scope`.
 *
 * `userId` is null for the tenant-wide grant an admin connected, and the user's
 * id for a `userScoped` connector — where each person holds their own grant and
 * a single per-connector answer would report one user's refusal as everybody's.
 *
 * Rows for scopes no longer in the manifest are deleted rather than left
 * behind: a scope the connector dropped is not refused, it is gone, and a stale
 * row would render as a permanent false alarm nobody can clear.
 */
export async function recordScopeStatus(opts: {
  connectorName: string;
  scopes: ConnectorScope[];
  granted: string[];
  /** Whether the authorization asked for the scopes requested with "write". */
  writes: boolean;
  userId?: string | null;
}): Promise<void> {
  const userId = opts.userId ?? null;
  const rows = classifyGrant(opts.scopes, opts.granted, { writes: opts.writes });

  // One transaction: a half-written snapshot is worse than the previous one,
  // because it reads as authoritative.
  await sql.begin(async (tx) => {
    await tx`
      delete from public.connector_scope_status
       where connector_name = ${opts.connectorName}
         and user_id is not distinct from ${userId}
    `;
    if (rows.length === 0) return;
    await tx`
      insert into public.connector_scope_status ${tx(
        rows.map((r) => ({
          connector_name: opts.connectorName,
          user_id: userId,
          scope: r.scope,
          status: r.status,
        })),
        "connector_name",
        "user_id",
        "scope",
        "status",
      )}
    `;
  });
}

/**
 * The snapshot for one connector and grant-holder.
 *
 * Returns an empty array when nobody has connected yet — which the tab renders
 * as "not connected", not as a list of refusals. There is a real difference
 * between "we asked and were told no" and "we have never asked".
 */
export async function getScopeStatus(
  connectorName: string,
  userId?: string | null,
): Promise<ScopeStatusRow[]> {
  try {
    const rows = await sql<
      { scope: string; status: ScopeStatus; recorded_at: Date }[]
    >`
      select scope, status, recorded_at
        from public.connector_scope_status
       where connector_name = ${connectorName}
         and user_id is not distinct from ${userId ?? null}
    `;
    return rows.map((r) => ({
      scope: r.scope,
      status: r.status,
      recordedAt: r.recorded_at.getTime(),
    }));
  } catch {
    // A reporting view must never take the page down with it.
    return [];
  }
}
