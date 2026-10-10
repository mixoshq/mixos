/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { sql } from "@/lib/db/client";
import { TOKEN_KEYS, splitScopes } from "./oauth";

/**
 * What a connector is actually allowed to do, and what it has actually done.
 *
 * Two separate questions, kept separate on purpose. The grant answers the
 * first: it is the authoritative list of what the provider handed over, and it
 * can be narrower than what the manifest asks for. Recorded calls answer the
 * second, and can never answer the first — a scope nobody has exercised is not
 * a scope that was refused.
 */

/** One recorded call, newest first. */
export interface ConnectorLogEntry {
  /** The connector method — the closest thing recorded to "which endpoint". */
  method: string;
  /** Slug of the app that made the call. */
  appSlug: string | null;
  /** Display name of the user whose request drove it, when there was one. */
  userName: string | null;
  outcome: "ok" | "error" | null;
  errorCategory: string | null;
  at: number;
}

export interface ConnectorAccess {
  /**
   * Scopes the provider actually granted, split from the string it returned
   * (space- or comma-separated; see `splitScopes`). Empty when the connector is
   * not OAuth, or when no scope is stored — which is not the same as "granted
   * nothing", so `grantedKnown` distinguishes them rather than an empty list
   * being read as a fact.
   */
  granted: string[];
  grantedKnown: boolean;
  /** The most recent calls, newest first. */
  log: ConnectorLogEntry[];
}

export function grantedScopes(
  credentials: Record<string, string> | null | undefined,
): { granted: string[]; grantedKnown: boolean } {
  const granted = splitScopes(credentials?.[TOKEN_KEYS.scope]);
  return { granted, grantedKnown: granted.length > 0 };
}

/**
 * The most recent calls through one connector.
 *
 * Capped rather than paged: this is a "what has been happening" panel inside a
 * dialog, not an audit export. A deployment needing full history has the
 * telemetry table itself.
 *
 * `event_name` is the connector METHOD, not a URL path — that is what the
 * instrumentation records, and it is the more useful of the two here: one
 * method maps to one upstream operation, where a path repeats across several.
 */
export async function getConnectorLog(
  connectorName: string,
  limit = 100,
): Promise<ConnectorLogEntry[]> {
  try {
    const rows = await sql<
      {
        event_name: string;
        caller_app_slug: string | null;
        display_name: string | null;
        outcome: "ok" | "error" | null;
        error_category: string | null;
        created_at: Date;
      }[]
    >`
      select e.event_name,
             e.caller_app_slug,
             u.display_name,
             e.outcome,
             e.error_category,
             e.created_at
        from public.telemetry_events e
        left join public.users u on u.id = e.user_id
       where e.source_type = 'connector'
         and e.source_slug = ${connectorName}
       order by e.created_at desc
       limit ${limit}
    `;
    return rows.map((r) => ({
      method: r.event_name,
      appSlug: r.caller_app_slug,
      userName: r.display_name,
      outcome: r.outcome,
      errorCategory: r.error_category,
      at: new Date(r.created_at).getTime(),
    }));
  } catch {
    // The log is supporting detail, not the answer. A telemetry table that is
    // unreachable must not take the dialog down with it.
    return [];
  }
}
