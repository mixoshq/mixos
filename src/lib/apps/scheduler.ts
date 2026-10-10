/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Universal per-app cron scheduler.
//
// A 5-minute master tick calls runDueJobs(). The tick is external — Vercel Cron
// hits /api/cron (see vercel.json) — because a serverless instance is frozen
// between requests and cannot hold a timer. Each app declares jobs in its
// manifest `schedules`; the handler lives at apps/<slug>/jobs/<name>.ts. Jobs
// run with a user-less system context.
//
// Cadence: a job runs either on a fixed interval (`everyMinutes`) or on a
// wall-clock CRON expression (`cron`, in an optional `timezone`). Cron can't be
// evaluated in Postgres, so the next fire time is computed in JS (see cron.ts)
// and materialized into `app_scheduled_jobs.next_run_at`. Due-ness therefore
// stays a single SQL compare — `next_run_at <= now()` — inside the atomic claim.
//
// Concurrency safety: cron invocations can overlap or be delivered more than
// once. A job is executed at most once per due window via an atomic Postgres
// claim
// (UPDATE ... SET running_since = now() WHERE next_run_at <= now() AND
// running_since IS NULL ... RETURNING). Because the run's release UPDATE writes
// the *next* next_run_at in the same statement that clears running_since, a
// second replica that ticks afterward sees a future next_run_at and can't
// double-run — the due-check inside the claim is load-bearing, not cosmetic.

import { sql } from "@/lib/db/client";
import { appRegistry } from "@/generated/app-registry";
import { isDefinedSync, runSync } from "@/lib/apps/sync";

/**
 * Declared syncs share the scheduled-jobs table with hand-written jobs, under a
 * reserved prefix. One table means one atomic claim, one enable/disable toggle,
 * one run history and one admin page — a sync an operator could not pause would
 * be a worse job than the hand-rolled one it replaces.
 */
const SYNC_JOB_PREFIX = "sync:";
import type { ScheduleCadence } from "./types";
import { type Cadence, computeNextRun } from "./cron";
import { buildSystemAppContext } from "./context";
import { JOB_TIMEOUT_MS } from "./job-limits";

/** A claim held longer than this is presumed crashed and may be reclaimed. */
const STALE_LEASE_MINUTES = 15;

class JobTimeoutError extends Error {}

/** In-process guard so a slow tick never overlaps itself within one pod. */
let tickInFlight = false;

/** Cadence columns selected from a job row (one of interval/cron is non-null). */
type CadenceRow = {
  interval_minutes: number | null;
  cron: string | null;
  timezone: string | null;
};
type JobRow = { app_slug: string; job_name: string } & CadenceRow;

/** Manifest schedule → the Cadence shape the cron helper understands. */
function cadenceOf(s: ScheduleCadence): Cadence {
  return {
    intervalMinutes: s.everyMinutes ?? null,
    cron: s.cron ?? null,
    timezone: s.timezone ?? null,
  };
}

function cadenceOfRow(r: CadenceRow): Cadence {
  return {
    intervalMinutes: r.interval_minutes,
    cron: r.cron,
    timezone: r.timezone,
  };
}

/**
 * The materialized next fire time for a freshly-seeded row. Cron jobs are pinned
 * to their next wall-clock slot so they never fire the moment they're declared;
 * interval jobs get `null` (= "due now") so they fire on the next tick, matching
 * the pre-cron first-run behavior.
 */
function seedNextRun(cad: Cadence, nowMs: number): Date | null {
  return cad.cron ? new Date(computeNextRun(cad, nowMs)) : null;
}

function errMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.slice(0, 2000);
}

/**
 * Reject after `ms`, and fire `onTimeout` so the caller can cancel the work.
 * Rejecting alone only stops us *waiting* — the handler's promise keeps running,
 * so without the abort an abandoned job goes on calling APIs and writing rows
 * while the next tick starts a second copy beside it. Handlers observe the abort
 * via `ctx.signal`; one that ignores it still can't outlive its recorded run.
 */
function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  onTimeout: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new JobTimeoutError(`job exceeded ${ms}ms`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Reconcile manifest-declared schedules into `app_scheduled_jobs`: insert new
 * rows, rewrite a job whose cadence definition changed, and remove rows whose
 * manifest no longer declares them. The admin-controlled `enabled` flag and
 * runtime state (`last_run_at`, history) are preserved on existing rows; only a
 * genuine cadence change reseeds `next_run_at`.
 *
 * Only a manifest in this build can stop declaring a job. An app the build
 * doesn't carry keeps its rows, and with them each job's `enabled` switch, so
 * the app comes back with its jobs as an admin left them, the way the release
 * step keeps its `apps` row (scripts/sync-app-registry.ts).
 */
async function syncSchedules(): Promise<void> {
  const nowMs = Date.now();
  const existing = (await sql`
    select app_slug, job_name, interval_minutes, cron, timezone
    from public.app_scheduled_jobs
  `) as unknown as ({ app_slug: string; job_name: string } & CadenceRow)[];
  const existingByKey = new Map(
    existing.map((r) => [`${r.app_slug} ${r.job_name}`, r]),
  );

  const declared = new Set<string>();
  for (const app of appRegistry) {
    // A declared sync is a scheduled job whose handler the PLATFORM writes. It
    // is reconciled here rather than in a parallel table so it inherits the
    // atomic claim, the enable/disable toggle, the run history and the admin
    // page for free — a sync that could not be paused would be a worse job than
    // a hand-rolled one.
    const entries = [
      ...(app.schedules ?? []).map((s) => ({ name: s.name, cadence: s })),
      ...(app.sync ?? []).map((s) => ({
        name: `${SYNC_JOB_PREFIX}${s.name}`,
        cadence: s.schedule,
      })),
    ];
    for (const { name: entryName, cadence: s } of entries.map((e) => ({
      name: e.name,
      cadence: e.cadence,
    }))) {
      const key = `${app.slug} ${entryName}`;
      declared.add(key);
      const cad = cadenceOf(s);
      const prev = existingByKey.get(key);

      if (!prev) {
        await sql`
          insert into public.app_scheduled_jobs
            (app_slug, job_name, interval_minutes, cron, timezone, next_run_at)
          values (${app.slug}, ${entryName}, ${cad.intervalMinutes}, ${cad.cron},
                  ${cad.timezone}, ${seedNextRun(cad, nowMs)})
        `;
        continue;
      }

      const changed =
        prev.interval_minutes !== cad.intervalMinutes ||
        prev.cron !== cad.cron ||
        prev.timezone !== cad.timezone;
      if (changed) {
        // Cadence redefined across a deploy: rewrite it and reseed the next
        // fire time (cron → next slot; interval → due on the next tick).
        await sql`
          update public.app_scheduled_jobs
          set interval_minutes = ${cad.intervalMinutes}, cron = ${cad.cron},
              timezone = ${cad.timezone}, next_run_at = ${seedNextRun(cad, nowMs)},
              updated_at = now()
          where app_slug = ${app.slug} and job_name = ${entryName}
        `;
      }
    }
  }

  const inBuild = new Set(appRegistry.map((a) => a.slug));
  for (const row of existing) {
    if (!inBuild.has(row.app_slug)) continue;
    if (!declared.has(`${row.app_slug} ${row.job_name}`)) {
      await sql`
        delete from public.app_scheduled_jobs
        where app_slug = ${row.app_slug} and job_name = ${row.job_name}
      `;
    }
  }
}

/**
 * Atomically claim a job if its app is active, the job is enabled, it is due
 * (`next_run_at <= now()`, with NULL meaning due now), and it is not currently
 * held (or its hold is stale). The app check is inside the claim, not before
 * it, so "Run now" on a deactivated app cannot race past it either. Returns true
 * iff this pod won the claim. The UPDATE row-locks the matched row, so
 * concurrent claimers serialize and only the first sees the row as due+free.
 */
async function claim(slug: string, job: string): Promise<boolean> {
  const rows = (await sql`
    update public.app_scheduled_jobs
    set running_since = now()
    where app_slug = ${slug}
      and job_name = ${job}
      and enabled
      and exists (
        select 1 from public.apps a
        where a.slug = app_slug and a.is_active
      )
      and (next_run_at is null or next_run_at <= now())
      and (running_since is null
           or running_since <= now() - make_interval(mins => ${STALE_LEASE_MINUTES}))
    returning id
  `) as unknown as { id: string }[];
  return rows.length > 0;
}

/**
 * The durable global on/off switch for recurring scheduling, stored in
 * `platform_settings`. Defaults to enabled if the row is missing (fresh DB
 * before the seed, or a settings table that predates this key).
 */
export async function getSchedulerEnabled(): Promise<boolean> {
  const rows = (await sql`
    select value from public.platform_settings where key = 'scheduler_enabled'
  `) as unknown as { value: string }[];
  return rows.length === 0 || rows[0].value !== "false";
}

/** Flip the global scheduler switch (the admin "Start tick" / "Stop tick"). */
export async function setSchedulerEnabled(on: boolean): Promise<void> {
  await sql`
    insert into public.platform_settings (key, value, updated_at)
    values ('scheduler_enabled', ${on ? "true" : "false"}, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()
  `;
}

async function runClaimed(
  slug: string,
  job: string,
  cadence: Cadence,
  trigger: "scheduled" | "manual",
): Promise<void> {
  const startedAt = new Date();
  let status: "ok" | "error" | "timeout" = "ok";
  let error: string | null = null;

  const abort = new AbortController();
  try {
    const ctx = await buildSystemAppContext(slug, abort.signal);
    if (job.startsWith(SYNC_JOB_PREFIX)) {
      const syncName = job.slice(SYNC_JOB_PREFIX.length);
      const definition = appRegistry
        .find((a) => a.slug === slug)
        ?.sync?.find((s) => s.name === syncName);
      if (!definition) {
        throw new Error(`apps/${slug} no longer declares sync "${syncName}"`);
      }
      const mod = await import(`@apps/${slug}/sync/${syncName}`);
      if (!isDefinedSync(mod.default)) {
        throw new Error(
          `apps/${slug}/sync/${syncName}.ts must default-export defineSync({...})`,
        );
      }
      const result = await withTimeout(
        runSync(ctx, definition, mod.default),
        JOB_TIMEOUT_MS,
        () =>
          abort.abort(new JobTimeoutError(`sync exceeded ${JOB_TIMEOUT_MS}ms`)),
      );
      // The summary line is what makes a truncated tick distinguishable from a
      // complete one on the admin page.
      console.log(
        `[sync] ${slug}/${syncName}: ${result.items} item(s) over ${result.pages} page(s), ` +
          `${result.from.slice(0, 10)}..${result.to.slice(0, 10)} ` +
          `(window ${result.windowDays}d${result.note ? ", " + result.note : ""})`,
      );
    } else {
      const mod = await import(`@apps/${slug}/jobs/${job}`);
      const handler = mod.default;
      if (typeof handler !== "function") {
        throw new Error(
          `apps/${slug}/jobs/${job}.ts must export a default function`,
        );
      }
      await withTimeout(Promise.resolve(handler(ctx)), JOB_TIMEOUT_MS, () =>
        abort.abort(new JobTimeoutError(`job exceeded ${JOB_TIMEOUT_MS}ms`)),
      );
    }
  } catch (err) {
    status = err instanceof JobTimeoutError ? "timeout" : "error";
    error = errMessage(err);
    console.error(`[scheduler] ${slug}/${job} ${status}:`, err);
  }

  const finishedMs = Date.now();
  const durationMs = finishedMs - startedAt.getTime();
  // Schedule the next run relative to completion. Writing next_run_at in the
  // SAME statement that clears running_since is what prevents a second replica
  // from double-running: once this commits, the row's next_run_at is in the
  // future so the claim's due-check fails for everyone until then.
  const nextRunAt = new Date(computeNextRun(cadence, finishedMs));
  // Record result and release the claim. Runs even on failure so a crashed
  // handler doesn't leave the job permanently locked (the stale lease is the
  // backstop for a process that dies before reaching here).
  await sql`
    update public.app_scheduled_jobs
    set last_run_at = now(), last_status = ${status}, last_error = ${error},
        last_duration_ms = ${durationMs}, next_run_at = ${nextRunAt},
        running_since = null, updated_at = now()
    where app_slug = ${slug} and job_name = ${job}
  `;
  await sql`
    insert into public.app_job_runs
      (app_slug, job_name, started_at, finished_at, status, error, duration_ms, trigger)
    values (${slug}, ${job}, ${startedAt}, now(), ${status}, ${error}, ${durationMs},
            ${trigger})
  `;
}

/**
 * Claim a job for an out-of-band manual run, ignoring due-ness and the enabled
 * flag (an admin "Run now" is explicit). The concurrency guard is preserved:
 * we still refuse if the job is currently held by a live claim, so a manual run
 * never overlaps a scheduled one.
 */
async function forceClaim(slug: string, job: string): Promise<boolean> {
  const rows = (await sql`
    update public.app_scheduled_jobs
    set running_since = now()
    where app_slug = ${slug}
      and job_name = ${job}
      and (running_since is null
           or running_since <= now() - make_interval(mins => ${STALE_LEASE_MINUTES}))
    returning id
  `) as unknown as { id: string }[];
  return rows.length > 0;
}

/**
 * Run a single job immediately, on demand (the admin "Run now" action). Bypasses
 * the due-check but shares `runClaimed`, so the run is recorded in history and
 * reschedules `next_run_at` from completion (interval → +interval; cron → its
 * next wall-clock slot, so a manual run never disturbs the cron cadence). Safe
 * against a concurrent scheduled run via the claim. Returns whether it ran and,
 * if not, why.
 */
export async function runJobNow(
  slug: string,
  job: string,
): Promise<{ ran: boolean; reason?: string }> {
  const app = appRegistry.find((a) => a.slug === slug);
  const schedule = job.startsWith(SYNC_JOB_PREFIX)
    ? app?.sync?.find((s) => `${SYNC_JOB_PREFIX}${s.name}` === job)?.schedule
    : app?.schedules?.find((s) => s.name === job);
  if (!schedule) return { ran: false, reason: "unknown job" };
  const cad = cadenceOf(schedule);

  // Ensure a state row exists — a job may never have ticked yet. Supply the full
  // cadence so the exactly-one-cadence check constraint is satisfied.
  await sql`
    insert into public.app_scheduled_jobs
      (app_slug, job_name, interval_minutes, cron, timezone, next_run_at)
    values (${slug}, ${job}, ${cad.intervalMinutes}, ${cad.cron}, ${cad.timezone},
            ${seedNextRun(cad, Date.now())})
    on conflict (app_slug, job_name) do nothing
  `;

  if (!(await forceClaim(slug, job))) {
    return { ran: false, reason: "already running" };
  }
  await runClaimed(slug, job, cad, "manual");
  return { ran: true };
}

/**
 * One scheduler tick: reconcile schedules, then attempt every enabled job. The
 * atomic claim decides due-ness and cross-replica ownership; jobs run
 * concurrently and are fully isolated (one failure never affects another).
 */
export async function runDueJobs(): Promise<void> {
  if (tickInFlight) {
    console.warn("[scheduler] previous tick still running; skipping this tick");
    return;
  }
  tickInFlight = true;
  try {
    // Durable global pause: an admin can stop recurring scheduling without a
    // redeploy. Applies to every cron invocation (they all land
    // here); explicit "Run now" (runJobNow) bypasses this on purpose.
    if (!(await getSchedulerEnabled())) {
      console.log(
        "[scheduler] paused (scheduler_enabled=false); skipping tick",
      );
      return;
    }
    await syncSchedules();
    // Joined to `apps` rather than filtered afterwards: a deactivated app runs
    // nothing, and leaving its jobs to be claimed and then skipped would still
    // advance `next_run_at`, so reactivating would silently lose a window. The
    // same goes for an app this build doesn't carry: its row and jobs are kept,
    // active or not, until it comes back, and this build has no handler to run.
    const jobs = (await sql`
      select j.app_slug, j.job_name, j.interval_minutes, j.cron, j.timezone
      from public.app_scheduled_jobs j
      join public.apps a on a.slug = j.app_slug
      where j.enabled and a.is_active
        and j.app_slug = any(${appRegistry.map((a) => a.slug)})
    `) as unknown as JobRow[];

    await Promise.all(
      jobs.map(async (j) => {
        try {
          if (await claim(j.app_slug, j.job_name)) {
            await runClaimed(
              j.app_slug,
              j.job_name,
              cadenceOfRow(j),
              "scheduled",
            );
          }
        } catch (err) {
          console.error(
            `[scheduler] claim/run failed for ${j.app_slug}/${j.job_name}:`,
            err,
          );
        }
      }),
    );
  } catch (err) {
    console.error("[scheduler] tick failed:", err);
  } finally {
    tickInFlight = false;
  }
}
