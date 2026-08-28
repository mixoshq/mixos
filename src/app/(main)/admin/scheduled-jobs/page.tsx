/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { revalidatePath } from "next/cache";
import { requireReadOnlySession } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/apps/access";
import { appRegistry } from "@/generated/app-registry";
import { createServiceClient } from "@/lib/db/server";
import { sql } from "@/lib/db/client";
import { getSchedulerEnabled, setSchedulerEnabled } from "@/lib/apps/scheduler";
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
    for (const s of app.schedules ?? []) {
      const key = `${app.slug} ${s.name}`;
      const r = state.get(key);
      jobs.push({
        appSlug: app.slug,
        appName: app.name,
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

  async function setEnabled(formData: FormData) {
    "use server";
    const appSlug = formData.get("appSlug") as string;
    const jobName = formData.get("jobName") as string;
    const enabled = formData.get("enabled") === "true";

    const session = await requireReadOnlySession();
    await requireAdmin(session);

    // Look up the cadence from the registry so a not-yet-synced row can still
    // be toggled — the upsert must supply exactly one cadence (cron or
    // interval) to satisfy the check constraint.
    const app = appRegistry.find((a) => a.slug === appSlug);
    const schedule = app?.schedules?.find((s) => s.name === jobName);
    if (!schedule) return;

    const db = createServiceClient();
    await db.from("app_scheduled_jobs").upsert(
      {
        app_slug: appSlug,
        job_name: jobName,
        interval_minutes: schedule.everyMinutes ?? null,
        cron: schedule.cron ?? null,
        timezone: schedule.timezone ?? null,
        enabled,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "app_slug,job_name" },
    );
    revalidatePath("/admin/scheduled-jobs");
  }

  async function runNow(formData: FormData) {
    "use server";
    const appSlug = formData.get("appSlug") as string;
    const jobName = formData.get("jobName") as string;

    const session = await requireReadOnlySession();
    await requireAdmin(session);

    // Runs the handler inline (up to the scheduler's job timeout) so the
    // refreshed page reflects the new status/error. Force-claim ignores
    // due-ness but still refuses to overlap a live run.
    const { runJobNow } = await import("@/lib/apps/scheduler");
    await runJobNow(appSlug, jobName);
    revalidatePath("/admin/scheduled-jobs");
  }

  async function setSchedulerEnabledAction(formData: FormData) {
    "use server";
    const enabled = formData.get("enabled") === "true";

    const session = await requireReadOnlySession();
    await requireAdmin(session);

    // The durable global switch. When off, runDueJobs() skips every tick (all
    // replicas + the CronJob), but per-job "Run now" still works as an override.
    await setSchedulerEnabled(enabled);
    revalidatePath("/admin/scheduled-jobs");
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
        setEnabledAction={setEnabled}
        runNowAction={runNow}
        setSchedulerEnabledAction={setSchedulerEnabledAction}
      />
    </div>
  );
}
