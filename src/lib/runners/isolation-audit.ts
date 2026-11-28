/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where connectors run, in the audit log (Item 7b). The operator decides it
 * with MIXOS_ISOLATION, outside the app, so nothing an admin clicks records
 * it. Instead the cron tick compares the tier with the one it last recorded,
 * in `platform_settings`, and audits a change as `platform.isolation.connectors`
 * by the scheduler. A deploy with MIXOS_ISOLATION=off shows in the log within
 * a tick, with the reason, and so does turning it back on.
 */

import { sql } from "@/lib/db/client";
import { recordAdminAction } from "@/lib/apps/admin-audit";
import { SCHEDULER_ACTOR } from "@/lib/apps/audit-actors";
import { connectorIsolation } from "./remote-connector";

const KEY = "isolation.connectors";

export type IsolationAuditOutcome = "unchanged" | "recorded" | "error";

/** Audit the connector tier if it changed since the last tick. Never throws. */
export async function auditConnectorIsolation(): Promise<IsolationAuditOutcome> {
  const state = connectorIsolation();
  const value = state.on ? "isolated" : `in-process: ${state.reason}`;
  try {
    const rows = await sql<{ value: string }[]>`select value from public.platform_settings where key = ${KEY}`;
    const previous = rows[0]?.value ?? null;
    if (previous === value) return "unchanged";
    await sql`
      insert into public.platform_settings (key, value) values (${KEY}, ${value})
      on conflict (key) do update set value = excluded.value, updated_at = now()
    `;
    await recordAdminAction(
      { id: null, email: SCHEDULER_ACTOR },
      {
        action: "platform.isolation.connectors",
        targetType: "platform",
        targetId: "connectors",
        details: { isolated: state.on, reason: state.on ? null : state.reason, previous },
      },
    );
    return "recorded";
  } catch (error) {
    console.warn("[isolation] couldn't record where connectors run:", error);
    return "error";
  }
}
