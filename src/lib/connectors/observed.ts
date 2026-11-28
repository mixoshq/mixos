/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { appRegistry } from "@/generated/app-registry";
import { sql } from "@/lib/db/client";
import { OBSERVED_DAYS, type ObservedCalls } from "./reach";

/**
 * What apps have actually called through each connector lately, for the Reach
 * section of Admin → Connectors, beside what each one may call
 * (./reach.ts).
 *
 * Read from `telemetry_events`, which records a call to a declared method when
 * it settles, with the app that made it (`instrumentConnector`,
 * src/lib/apps/telemetry.ts). So it is evidence, not a full account:
 *
 *   - a call the app's facade refused never reached the connector, so it isn't
 *     here (src/lib/apps/connector-reach.ts);
 *   - recording is best-effort, so a call can be missing;
 *   - an app's own SQL can't write the table, since it runs as the app's role
 *     (docs/security-architecture.md §8), but code that gets around the build's
 *     checks runs as the platform and could.
 */

/**
 * The calls made through each of `names` in the last `OBSERVED_DAYS` days,
 * grouped by app and method. Null when the table can't be read: the section
 * then says it doesn't know, rather than that nothing was called.
 *
 * One query for the whole page, bounded by the
 * `(source_type, source_slug, created_at)` index.
 */
export async function getObservedConnectorCalls(
  names: readonly string[],
): Promise<ObservedCalls | null> {
  const out: ObservedCalls = Object.fromEntries(names.map((n) => [n, []]));
  if (names.length === 0) return out;
  try {
    const rows = await sql<
      {
        source_slug: string;
        caller_app_slug: string | null;
        event_name: string;
        calls: number;
        errors: number;
      }[]
    >`
      select source_slug,
             caller_app_slug,
             event_name,
             count(*)::int as calls,
             (count(*) filter (where outcome = 'error'))::int as errors
        from public.telemetry_events
       where source_type = 'connector'
         and source_slug = any(${[...names]}::text[])
         and created_at >= now() - make_interval(days => ${OBSERVED_DAYS})
       group by source_slug, caller_app_slug, event_name
       order by source_slug, calls desc, caller_app_slug nulls last, event_name
    `;
    const nameOf = new Map(appRegistry.map((a) => [a.slug, a.name]));
    for (const r of rows) {
      out[r.source_slug]?.push({
        appSlug: r.caller_app_slug,
        appName: r.caller_app_slug ? (nameOf.get(r.caller_app_slug) ?? null) : null,
        method: r.event_name,
        calls: Number(r.calls),
        errors: Number(r.errors),
      });
    }
    return out;
  } catch (err) {
    console.error("[connectors] could not read which methods apps called:", err);
    return null;
  }
}
