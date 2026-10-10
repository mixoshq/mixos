/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Time limits the scheduler enforces, in their own module so the manifest
 * schema can read them without importing the scheduler and its database client.
 */

/**
 * A handler may run at most this long before it's abandoned. Kept under the
 * 5-minute tick cadence (the `crons[].schedule` entry in vercel.json, which is
 * also the minimum schedulable granularity) so a slow job cannot still be
 * running when the next tick arrives.
 */
export const JOB_TIMEOUT_MS = 4 * 60_000;

/**
 * The largest `budgetMs` a declared sync may set.
 *
 * The budget is checked between pages, so a run can pass its deadline by one
 * page and the state write that follows it. A sync that stops on its budget
 * ends cleanly: it records a truncated run and halves its window for the next
 * tick. One still running at JOB_TIMEOUT_MS is abandoned mid-page and recorded
 * as a timeout instead. The 40 seconds left for that last page are the
 * headroom docs/apps/scheduled-jobs.md recommends for a hand-written job.
 */
export const MAX_SYNC_BUDGET_MS = JOB_TIMEOUT_MS - 40_000;
