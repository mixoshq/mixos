/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { appRegistry } from "@/generated/app-registry";
import { connectorRegistry } from "@/generated/connector-registry";
import { sql } from "@/lib/db/client";
import { recordAdminAction, type AdminActor } from "@/lib/apps/admin-audit";
import type { Anomaly, AnomalyKind } from "./anomaly";

/**
 * Per-app detection: what an app does beyond what it usually does, raised for
 * an admin to look at (supabase/migrations/0007_app_detection.sql).
 *
 * The cron tick runs `runDetection()` at most every 15 minutes. It reads the
 * `connector` and `egress` rows written since the last run and raises:
 *
 *   - **new-write**: a first call to a connector method that changes data;
 *   - **new-host**: a first contact with a host the app's egress allows only
 *     through a wildcard (a listed host is what it said it would reach);
 *   - **refused**: any call the platform refused, connector or egress, the
 *     clearest sign of an app reaching for what it wasn't given;
 *   - **spike**: more calls in the last hour than SPIKE_FACTOR times the hourly
 *     mean of the week before, and more than SPIKE_MINIMUM.
 *
 * What an app has done before is kept in `app_activity_seen`, capped at
 * MAX_SUBJECTS per app. The first run takes the last BACKFILL_DAYS as the
 * baseline and raises nothing, so an upgrade doesn't flag every app's normal
 * traffic as new.
 *
 * A record, not a gate: nothing here switches an app off. An admin reads the
 * anomaly on the app's tile, and deactivates it or marks it as expected. False
 * positives taking apps down would cost more than the delay of a click.
 */

export const DETECTION = {
  intervalMinutes: 15,
  maxSubjectsPerApp: 500,
  spikeFactor: 10,
  spikeMinimum: 100,
  baselineDays: 7,
  backfillDays: 30,
  acknowledgedRetentionDays: 180,
} as const;

const LAST_RUN_KEY = "detection.last_run";

export interface DetectionOutcome {
  /** False when the last run was less than the interval ago. */
  ran: boolean;
  /** The first run: what it read became the baseline, and nothing was raised. */
  backfill: boolean;
  raised: number;
}

/** Whether `method` of `connector` changes data, by its manifest. */
function mutates(connector: string, method: string): boolean {
  return connectorRegistry.find((c) => c.name === connector)?.telemetry.some((t) => t.method === method && t.mutates) === true;
}

/** Whether `host` is listed literally in the app's egress, rather than matched by a wildcard. */
function listedLiterally(appSlug: string, host: string): boolean {
  const egress = appRegistry.find((a) => a.slug === appSlug)?.egress ?? [];
  return egress.some((e) => e.toLowerCase() === host.toLowerCase());
}

interface ActivityRow {
  app: string;
  source_type: "connector" | "egress";
  source_slug: string;
  event_name: string;
  outcome: string | null;
  error_category: string | null;
  n: number;
  first: Date;
  last: Date;
}

/**
 * Run the detector, if it is due. Never throws for an app's sake; the cron
 * tick calls it in a catch of its own anyway.
 */
export async function runDetection(now: Date = new Date()): Promise<DetectionOutcome> {
  return sql.begin(async (tx) => {
    // The row lock is what keeps two ticks from running it at once: the
    // second waits, then finds the timestamp fresh.
    const [last] = await tx<{ value: string }[]>`
      select value from public.platform_settings where key = ${LAST_RUN_KEY} for update
    `;
    const previous = last ? new Date(last.value) : null;
    if (previous && now.getTime() - previous.getTime() < DETECTION.intervalMinutes * 60_000) {
      return { ran: false, backfill: false, raised: 0 };
    }
    await tx`
      insert into public.platform_settings (key, value) values (${LAST_RUN_KEY}, ${now.toISOString()})
      on conflict (key) do update set value = excluded.value, updated_at = now()
    `;
    const backfill = previous === null;
    const since = backfill ? new Date(now.getTime() - DETECTION.backfillDays * 86_400_000) : previous;

    const rows = await tx<ActivityRow[]>`
      select e.caller_app_slug as app, e.source_type, e.source_slug, e.event_name,
             e.outcome, e.error_category,
             count(*)::int as n, min(e.created_at) as first, max(e.created_at) as last
        from public.telemetry_events e
       where e.source_type in ('connector', 'egress')
         and e.caller_app_slug is not null
         and e.created_at > ${since} and e.created_at <= ${now}
         and exists (select 1 from public.apps a where a.slug = e.caller_app_slug)
       group by 1, 2, 3, 4, 5, 6
    `;

    let raised = 0;
    const raise = async (app: string, kind: AnomalyKind, subject: string, detail: object, first: Date, lastAt: Date, count: number) => {
      if (backfill) return;
      await tx`
        insert into public.app_anomalies (app_slug, kind, subject, detail, first_seen_at, last_seen_at, count)
        values (${app}, ${kind}, ${subject}, ${tx.json(detail as never)}, ${first}, ${lastAt}, ${count})
        on conflict (app_slug, kind, subject) do update set
          last_seen_at = greatest(public.app_anomalies.last_seen_at, excluded.last_seen_at),
          count = public.app_anomalies.count + excluded.count,
          detail = excluded.detail
      `;
      raised += 1;
    };

    // What each app has been seen doing, and how many subjects it has.
    const apps = [...new Set(rows.map((r) => r.app))];
    const seen = new Map<string, Set<string>>();
    if (apps.length > 0) {
      const known = await tx<{ app_slug: string; kind: string; subject: string }[]>`
        select app_slug, kind, subject from public.app_activity_seen where app_slug = any(${apps}::text[])
      `;
      for (const k of known) {
        const set = seen.get(k.app_slug) ?? new Set<string>();
        set.add(`${k.kind}\0${k.subject}`);
        seen.set(k.app_slug, set);
      }
    }

    for (const r of rows) {
      const connector = r.source_type === "connector";
      const kind = connector ? "connector-method" : "egress-host";
      const subject = connector ? `${r.source_slug}.${r.event_name}` : r.source_slug;

      if (r.outcome === "refused") {
        await raise(
          r.app,
          "refused",
          `${connector ? "connector" : "egress"}:${subject}:${r.error_category ?? "unknown"}`,
          { reason: r.error_category },
          r.first,
          r.last,
          r.n,
        );
        continue;
      }

      const mine = seen.get(r.app) ?? new Set<string>();
      seen.set(r.app, mine);
      const key = `${kind}\0${subject}`;
      if (mine.has(key)) {
        await tx`
          update public.app_activity_seen
             set last_seen_at = greatest(last_seen_at, ${r.last})
           where app_slug = ${r.app} and kind = ${kind} and subject = ${subject}
        `;
        continue;
      }
      if (mine.size >= DETECTION.maxSubjectsPerApp) {
        await raise(r.app, "too-many-subjects", "subjects", { cap: DETECTION.maxSubjectsPerApp }, r.first, r.last, 1);
        continue;
      }
      mine.add(key);
      await tx`
        insert into public.app_activity_seen (app_slug, kind, subject, first_seen_at, last_seen_at)
        values (${r.app}, ${kind}, ${subject}, ${r.first}, ${r.last})
        on conflict (app_slug, kind, subject) do nothing
      `;
      if (connector && mutates(r.source_slug, r.event_name)) {
        await raise(r.app, "new-write", subject, { connector: r.source_slug, method: r.event_name }, r.first, r.last, r.n);
      } else if (!connector && !listedLiterally(r.app, r.source_slug)) {
        await raise(r.app, "new-host", subject, { host: r.source_slug }, r.first, r.last, r.n);
      }
    }

    // Volume: the last hour against the week before it, per app.
    if (!backfill) {
      const hourAgo = new Date(now.getTime() - 3_600_000);
      const weekBefore = new Date(hourAgo.getTime() - DETECTION.baselineDays * 86_400_000);
      const volumes = await tx<{ app: string; last_hour: number; earlier: number }[]>`
        select e.caller_app_slug as app,
               (count(*) filter (where e.created_at > ${hourAgo}))::int as last_hour,
               (count(*) filter (where e.created_at <= ${hourAgo}))::int as earlier
          from public.telemetry_events e
         where e.source_type in ('connector', 'egress')
           and e.caller_app_slug is not null
           and e.created_at > ${weekBefore} and e.created_at <= ${now}
           and exists (select 1 from public.apps a where a.slug = e.caller_app_slug)
         group by 1
      `;
      for (const v of volumes) {
        const hourlyMean = v.earlier / (DETECTION.baselineDays * 24);
        if (v.last_hour > DETECTION.spikeMinimum && v.last_hour > DETECTION.spikeFactor * hourlyMean) {
          const hour = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000).toISOString().slice(0, 13);
          await raise(v.app, "spike", hour, { lastHour: v.last_hour, hourlyMean }, hourAgo, now, 1);
        }
      }
    }

    return { ran: true, backfill, raised };
  }) as Promise<DetectionOutcome>;
}

/** Each app's open anomalies, newest first. Empty when the table can't be read: a status view. */
export async function getOpenAnomalies(): Promise<Record<string, Anomaly[]>> {
  const out: Record<string, Anomaly[]> = {};
  try {
    const rows = await sql<
      {
        id: string;
        app_slug: string;
        kind: Anomaly["kind"];
        subject: string;
        detail: Record<string, unknown>;
        first_seen_at: Date;
        last_seen_at: Date;
        count: number;
      }[]
    >`
      select id, app_slug, kind, subject, detail, first_seen_at, last_seen_at, count
        from public.app_anomalies
       where acknowledged_at is null
       order by last_seen_at desc
    `;
    for (const r of rows) {
      (out[r.app_slug] ??= []).push({
        id: r.id,
        kind: r.kind,
        subject: r.subject,
        detail: r.detail,
        firstSeenAt: r.first_seen_at.toISOString(),
        lastSeenAt: r.last_seen_at.toISOString(),
        count: r.count,
      });
    }
  } catch (err) {
    console.error("[detection] could not read open anomalies:", err);
  }
  return out;
}

/**
 * Mark an app's anomalies as expected: `ids`, or every open one when omitted.
 * Audited as `app.anomaly.acknowledge`, with what was marked. Returns how many.
 */
export async function acknowledgeAnomalies(actor: AdminActor, appSlug: string, ids?: string[]): Promise<number> {
  const rows = await sql<{ id: string; kind: string; subject: string }[]>`
    update public.app_anomalies
       set acknowledged_by = ${actor.id}, acknowledged_at = now()
     where app_slug = ${appSlug}
       and acknowledged_at is null
       ${ids ? sql`and id = any(${ids}::uuid[])` : sql``}
    returning id, kind, subject
  `;
  if (rows.length > 0) {
    await recordAdminAction(actor, {
      action: "app.anomaly.acknowledge",
      targetType: "app",
      targetId: appSlug,
      details: { anomalies: rows.map((r) => ({ kind: r.kind, subject: r.subject })) },
    });
  }
  return rows.length;
}

/** Drop anomalies an admin marked as expected more than 180 days ago. */
export async function pruneAcknowledgedAnomalies(days: number = DETECTION.acknowledgedRetentionDays): Promise<number> {
  try {
    const result = (await sql`
      delete from public.app_anomalies
       where acknowledged_at is not null and acknowledged_at < now() - ${days} * interval '1 day'
    `) as unknown as { count: number };
    return result.count ?? 0;
  } catch (err) {
    console.warn("[detection] anomaly prune failed:", err);
    return 0;
  }
}

/** What one app was seen doing in the last `days` days, for its Reach tab. */
export interface ObservedActivity {
  connectorMethods: Array<{ subject: string; calls: number; refused: number }>;
  hosts: Array<{ host: string; calls: number; refused: number }>;
}

export async function getObservedActivity(appSlug: string, days = 30): Promise<ObservedActivity> {
  const rows = await sql<{ source_type: string; source_slug: string; event_name: string; calls: number; refused: number }[]>`
    select source_type, source_slug, event_name,
           count(*)::int as calls,
           (count(*) filter (where outcome = 'refused'))::int as refused
      from public.telemetry_events
     where caller_app_slug = ${appSlug}
       and source_type in ('connector', 'egress')
       and created_at > now() - ${days} * interval '1 day'
     group by 1, 2, 3
     order by calls desc
  `;
  return {
    connectorMethods: rows
      .filter((r) => r.source_type === "connector")
      .map((r) => ({ subject: `${r.source_slug}.${r.event_name}`, calls: r.calls, refused: r.refused })),
    hosts: rows
      .filter((r) => r.source_type === "egress")
      .map((r) => ({ host: r.source_slug, calls: r.calls, refused: r.refused })),
  };
}
