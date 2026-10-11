/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { requireReadOnlySession } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/apps/access";
import { checkAppGate } from "@/lib/apps/app-gate";
import { appRegistry } from "@/generated/app-registry";
import { createServiceClient } from "@/lib/db/server";
import { sql } from "@/lib/db/client";
import { getSchedulerEnabled } from "@/lib/apps/scheduler";
import {
  runJobNowAction,
  setJobEnabledAction,
  setSchedulerEnabledAction,
} from "@/lib/apps/scheduler-actions";
import ScheduledJobsList, {
  type JobView,
  type RunView,
} from "@/components/admin/scheduled-jobs-list";

// Runtime job state changes constantly; never cache this page.
export const dynamic = "force-dynamic";

/** Most recent runs shown per job in its expanded history panel. */
const RUNS_PER_JOB = 20;

type StateRow = {
  app_slug: string;
  job_name: string;
  enabled: boolean;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  last_duration_ms: number | null;
  running_since: string | null;
  next_run_at: string | null;
};

type RunRow = {
  app_slug: string;
  job_name: string;
  started_at: string;
  finished_at: string | null;
  status: string | null;
  error: string | null;
  duration_ms: number | null;
  trigger: string;
};

export default async function ScheduledJobsAdminPage() {
  const session = await requireReadOnlySession();
  await requireAdmin(session);

  const db = createServiceClient();
  const schedulerEnabled = await getSchedulerEnabled();

  const { data } = await db
    .from("app_scheduled_jobs")
    .select(
      "app_slug, job_name, enabled, last_run_at, last_status, last_error, last_duration_ms, running_since, next_run_at",
    );
  const state = new Map<string, StateRow>();
  for (const r of (data as StateRow[] | null) ?? []) {
    state.set(`${r.app_slug} ${r.job_name}`, r);
  }

  // Recent run history (append-only): the latest RUNS_PER_JOB runs PER job,
  // newest first. A per-job window (not a global limit) so an infrequent job
  // isn't starved by a chatty one. The (app_slug, job_name, started_at desc)
  // index backs the partitioned ordering. Grouped by job for the expand panels.
  const runData = (await sql`
    select app_slug, job_name, started_at, finished_at, status, error,
           duration_ms, trigger
    from (
      select *,
             row_number() over (
               partition by app_slug, job_name order by started_at desc
             ) as rn
      from public.app_job_runs
    ) t
    where rn <= ${RUNS_PER_JOB}
    order by app_slug, job_name, started_at desc
  `) as unknown as RunRow[];
  const runsByJob = new Map<string, RunView[]>();
  for (const r of runData) {
    const key = `${r.app_slug} ${r.job_name}`;
    const list = runsByJob.get(key) ?? [];
    list.push({
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      status: r.status,
      error: r.error,
      durationMs: r.duration_ms,
      trigger: r.trigger === "manual" ? "manual" : "scheduled",
    });
    runsByJob.set(key, list);
  }

  // The manifest is the source of truth for which jobs exist; the DB row carries
  // runtime state (may not exist yet before the first tick).
  const jobs: JobView[] = [];
  for (const app of appRegistry) {
    const schedules = app.schedules ?? [];
    if (schedules.length === 0) continue;
    // The gate Run now asks, so the page shows what the server will decide: the
    // jobs of an app that is inactive, or being updated, don't run, on the
    // tick or by hand.
    const gate = await checkAppGate(app.slug);
    const appState = gate.open ? "active" : gate.reason;
    for (const s of schedules) {
      const key = `${app.slug} ${s.name}`;
      const r = state.get(key);
      jobs.push({
        appSlug: app.slug,
        appName: app.name,
        appState,
        jobName: s.name,
        intervalMinutes: s.everyMinutes ?? null,
        cron: s.cron ?? null,
        timezone: s.timezone ?? null,
        enabled: r?.enabled ?? true,
        lastRunAt: r?.last_run_at ?? null,
        lastStatus: r?.last_status ?? null,
        lastError: r?.last_error ?? null,
        lastDurationMs: r?.last_duration_ms ?? null,
        running: !!r?.running_since,
        // next_run_at is runtime state; null before the first sync/run means
        // "due on the next tick" for interval jobs.
        nextRunAt: r?.next_run_at ?? null,
        runs: runsByJob.get(key) ?? [],
      });
    }
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">Scheduled Jobs</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Per-app jobs run by the platform scheduler (a 5-minute tick). Each job
          runs on its own schedule — a fixed interval or a CRON expression;
          disable one to pause it without a redeploy.
        </p>
      </div>
      <ScheduledJobsList
        jobs={jobs}
        schedulerEnabled={schedulerEnabled}
        setEnabledAction={setJobEnabledAction}
        runNowAction={runJobNowAction}
        setSchedulerEnabledAction={setSchedulerEnabledAction}
      />
    </div>
  );
}
