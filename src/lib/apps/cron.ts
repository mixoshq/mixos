/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Cadence math for the app scheduler. A scheduled job runs on one of two
// cadences: a fixed interval (`intervalMinutes`, minutes-since-last-run) or a
// wall-clock CRON expression (`cron`, evaluated in `timezone`, default UTC).
//
// The scheduler materializes each job's next fire time into
// `app_scheduled_jobs.next_run_at` so due-ness stays a single SQL compare inside
// the atomic claim (see scheduler.ts). This module is the only place that
// evaluates a cron expression, and it is server-only (croner is never bundled to
// the client).
import { Cron } from "croner";

/** The two cadence modes are mutually exclusive: exactly one is non-null. */
export interface Cadence {
  intervalMinutes: number | null;
  cron: string | null;
  timezone: string | null;
}

/** Wall-clock cron is evaluated in UTC unless the job pins an IANA timezone. */
const DEFAULT_TZ = "UTC";

/**
 * Compute the next fire time (epoch ms) at or after `fromMs`.
 * - interval: `fromMs + intervalMinutes` minutes.
 * - cron: the next matching wall-clock occurrence strictly after `fromMs`.
 *
 * Cron granularity is bounded by the scheduler's 5-minute tick — an expression
 * finer than 5 minutes effectively fires at tick cadence, not sub-tick.
 */
export function computeNextRun(c: Cadence, fromMs: number): number {
  if (c.cron) {
    const next = new Cron(c.cron, {
      timezone: c.timezone ?? DEFAULT_TZ,
    }).nextRun(new Date(fromMs));
    if (!next) {
      // A cron with no future occurrence (e.g. an impossible date) — schedule
      // far out rather than firing constantly. Should not happen for the
      // 5-field expressions we validate, but never return a past/NaN value.
      throw new Error(`cron expression "${c.cron}" has no next run`);
    }
    return next.getTime();
  }
  if (c.intervalMinutes != null) {
    return fromMs + c.intervalMinutes * 60_000;
  }
  throw new Error("cadence has neither cron nor intervalMinutes");
}

/**
 * Validate a cron expression (and optional timezone) at manifest-build time.
 * Throws with a readable message on a bad pattern, a 6-field (seconds)
 * expression (rejected for the 5-minute floor), or an invalid timezone.
 */
export function assertValidCron(expr: string, timezone?: string): void {
  const fields = expr.trim().split(/\s+/).length;
  if (fields !== 5) {
    throw new Error(
      `cron "${expr}" must have exactly 5 fields (minute hour day-of-month month day-of-week); ` +
        `seconds-level expressions are not supported (the scheduler ticks every 5 minutes)`,
    );
  }
  // Constructing validates the pattern; nextRun() forces timezone resolution
  // (croner defers tz errors until a date is computed).
  const cron = new Cron(expr, { timezone: timezone ?? DEFAULT_TZ });
  cron.nextRun();
}
