# Scheduled Jobs

## Overview

Apps can run periodic server-side work — refreshing a cache, syncing a
connector, sending a digest — via the platform **cron scheduler**. A single
master tick fires every **5 minutes** and dispatches to each app's due jobs.
Jobs are declared in the manifest (like `connectors` or `database`) and
implemented as handler files; the platform runs them with a server context.

You do **not** write any timer, endpoint, or queue code. Declare the schedule,
write the handler, done.

## Declaring a job

Add a `schedules` array to your `app.json`. Each entry names a handler and
**exactly one** cadence — a fixed interval (`everyMinutes`) **or** a wall-clock
CRON expression (`cron`):

```json
{
  "name": "My App",
  "schedules": [
    { "name": "refresh-cache", "everyMinutes": 60 },
    { "name": "weekly-digest", "cron": "0 8 * * 1" },
    { "name": "market-open", "cron": "30 9 * * 1-5", "timezone": "America/New_York" }
  ]
}
```

| Field | Required | Description |
| --- | --- | --- |
| `name` | ✅ | Handler name. Must resolve to `apps/<slug>/jobs/<name>.ts`. The registry generator fails the build if the file is missing. |
| `everyMinutes` | one of | Interval cadence in minutes. **Minimum 5, and a multiple of 5** (the tick size). A job runs when `now − lastRun ≥ everyMinutes`. |
| `cron` | one of | Standard **5-field** CRON expression (`minute hour day-of-month month day-of-week`). Fires at the matching wall-clock times. |
| `timezone` | | IANA timezone for `cron` (e.g. `"America/New_York"`). Defaults to **UTC**. Only valid alongside `cron`. |

Set **exactly one** of `everyMinutes` / `cron` — declaring both, neither, or a
`timezone` without a `cron` fails the manifest build.

### Interval vs. cron

- **`everyMinutes`** is interval-based (drifts): with `everyMinutes: 60` the job
  runs on the first tick at least 60 minutes after its **last run**. There is no
  fixed wall-clock time. A brand-new interval job fires on the next tick.
- **`cron`** is wall-clock: `"0 8 * * 1"` means "Mondays at 08:00" in the job's
  timezone. A brand-new cron job does **not** fire immediately — it waits for
  its next matching slot.

Both are evaluated at **5-minute resolution** (the master tick). A cron finer
than 5 minutes (e.g. `* * * * *`) effectively fires every 5 minutes, not every
minute — seconds-level (6-field) expressions are rejected. If a scheduled slot
is missed (process down, tick skipped under load), the job fires **once** on
recovery and then resumes its schedule — it does not backfill every missed slot.

## Writing a handler

Create `apps/<slug>/jobs/<name>.ts` with a default async function. It receives a
`SystemAppContext` — a user-less, trusted server context:

```ts
// apps/my-app/jobs/refresh-cache.ts
import type { SystemAppContext } from "@/lib/hooks/types";

export default async function refreshCache(ctx: SystemAppContext): Promise<void> {
  // ctx.db          — scoped DB client (when the app declares "database": true)
  // ctx.connectors  — the app's declared connectors (see below)
  // ctx.notifications — Web Push sender (when "notifications": true)
  // ctx.user        — always null: there is no logged-in user
  const rows = await ctx.db?.table("cache").select("*");
  // ...do the work...
}
```

### What's in `SystemAppContext`

| Field | Value |
| --- | --- |
| `user` | Always `null` — a job runs for the app, not a person. Reading a user identity is a type error. |
| `connectors` | The app's declared connectors, with the same tenant-wide credentials any request gets. A job has no user, so it can't use a [user-scoped](../connectors/architecture.md#user-scoped-connectors) connector: the build fails an app that declares one alongside `schedules` or `sync`. Always check `connector?.configured` before calling. |
| `db` | The scoped DB client if the app declares `"database": true`, else `null`. |
| `notifications` | A real Web Push sender if the app declares `"notifications": true`, else `null`. |
| `signal` | An `AbortSignal` aborted when the platform gives up on this run (the ~4-minute timeout). Always present. |
| `manifest`, `hooks` | Same as other contexts. |

### Handler rules

- **Be idempotent and self-contained.** A job may run late, or be skipped for a
  tick under load — it must tolerate that. Don't assume an exact wall-clock time.
- **Finish within ~4 minutes.** A handler that exceeds the timeout is abandoned
  (recorded as `timeout`) so it can't outlive its window; the next tick may start
  a fresh run.
- **Respect `ctx.signal`.** Abandonment stops the platform *waiting* for you; it
  does not stop your code. A job that loops over external calls must pass
  `ctx.signal` to each of them (`ctx.http.fetch(url, { signal: ctx.signal })`,
  or a connector method that takes one) and check `ctx.signal.aborted` between
  iterations, or it will keep burning API quota and writing rows after being
  abandoned — while the next tick runs a second copy alongside it.
- **Budget by wall clock, not by item count.** If the work is a queue, stop at a
  deadline and leave the rest for the next tick (process the stalest first so it
  drains fairly). A count-based cap can't predict runtime when per-item cost
  varies, which is the usual way a job ends up timing out.
- **Fail loudly, locally.** Throwing marks the run `error` and stores the message
  for the admin page — it never affects other jobs. Guard external calls
  (`if (!ctx.connectors.x?.configured) return;`).
- **Don't touch the scheduler tables.** Never read or write
  `public.app_scheduled_jobs` / `public.app_job_runs` from app code — the
  platform owns them.

A job that maintains a local copy of connector or warehouse data has a second set
of obligations — sync incrementally, serve reads from a snapshot, don't blank good
data. Those live in [Data Freshness](data-freshness.md).

## Staying inside the budget

The two rules above ("finish within ~4 minutes", "budget by wall clock") need a
shape. This is it.

**Own a relative constant in the job file; thread an absolute deadline into
libraries.** The job knows its budget; the library just needs to know when to
stop.

```ts
// apps/<slug>/jobs/sync-calendars.ts
/**
 * Wall-clock budget per tick, under the platform's 4-minute job timeout. The
 * headroom matters: the run stops on its own between mailboxes and commits what
 * it finished, instead of being abandoned mid-write with the next tick starting a
 * second copy on top of it.
 */
const DEADLINE_MS = 200_000;
```

`200_000` (~3m20s) is the convention — roughly 40 seconds of headroom under the
240-second timeout, enough for one more unit of work plus its writes.

**Check the budget and the signal together, at every boundary.** Not once at the
top:

```ts
const deadline = Date.now() + DEADLINE_MS;
const outOfBudget = () => ctx.signal.aborted || Date.now() >= deadline;
```

Call it between items, between stages, and between pages of a paginated read.
`ctx.signal.aborted` alone is not enough (it fires only once you've already
overrun); checking it as well costs nothing, and still stops a run whose
deadline was set too generously.

**Stop by breaking, not by throwing.** A deadline is a normal outcome, not a
failure. Commit what finished, return a summary that says the run was truncated,
and log it — otherwise a partial tick is indistinguishable from a complete one:

```ts
// A truncated run says so in its summary line.
`processed ${summary.processed} (…, mailboxes pulled ${summary.mailboxesPulled}` +
  `${summary.deadlineHit ? ", stopped on time budget" : ""})`
```

**Process the stalest first**, so truncation is a fair drain rather than
starvation. Group the work, key each group on its *oldest* timestamp, and sort
ascending — never-synced sorts to `0` and is always reached first.

**Loop by the expensive call's key, not the table's.** One calendar sync iterated
`(project, user)` rows while the costly Graph pull depends only on
`(user, window)`. A user on four projects paid for four identical pulls.
Grouping by user and reusing one fetch took that job from a 240s `timeout` to an
18.6s `ok`, and from 4 mailbox pulls to 1. Before tuning anything else, check that
the loop variable matches what actually costs money.

**Count caps are still right when the constraint is count-shaped** — a cost-based
API rate limit, or LLM calls per tick. Use both: a count cap for the external
limit and a deadline for the clock. Just don't use a count cap *as* a timeout
guard, because per-item cost varies and a count can't predict runtime.

Note that a per-tick cap interacts with the cadence: at one tick a day, the cap is
also the daily ceiling. When you slow a job down, re-check that its cap still
drains the population inside the freshness window it promises.

## Splitting a job into phases

Two reasons to split one job into two `schedules` entries, both learned the hard
way:

1. **The cadences differ.** Cheap ingest wants to run often; LLM enrichment does
   not. Sharing one tick meant nine sequential stages and up to fifteen model
   calls competing for a single 4-minute budget.
2. **Blast radius.** The old combined job returned early while its first stage was
   still paginating, so when that stage wedged on an expired cursor it silently
   took four unrelated sources down with it for 19 days.

```json
"schedules": [
  { "name": "ingest", "everyMinutes": 720 },
  { "name": "enrich", "everyMinutes": 1440 }
]
```

**Coordinate phases through stored state, never a return value.** Separate jobs
can't pass each other results. The downstream phase reads the watermark the
upstream maintains and holds off when it's too far behind — with a tolerance sized
from the upstream's cadence, not picked arbitrarily:

```ts
// jobs/enrich.ts — hold off rather than synthesize from a partial corpus
const lagMs = Date.now() - new Date(syncedThrough).getTime();
if (!Number.isFinite(lagMs) || lagMs > CORPUS_LAG_TOLERANCE_MS) return;
```

**Isolate each stage's failure.** Wrap stages in a helper that checks the budget
and swallows errors:

```ts
// jobs/ingest.ts
const stage = async (name: string, fn: () => Promise<string | null>) => {
  if (ctx.signal.aborted || Date.now() >= deadline) {
    out.push(`${name} skipped (out of budget)`);
    return;
  }
  try {
    const note = await fn();
    if (note) out.push(note);
  } catch (err) {
    // Never rethrow: one bad source must not cost the others this tick, and
    // must not mark the whole job `error` and hide the stages that worked.
    out.push(`${name} FAILED`);
    console.warn(`[<slug>/ingest] ${name} failed:`, err);
  }
};
```

This is the one deliberate exception to "fail loudly": with independent stages,
throwing marks the whole job `error` and hides the stages that worked. Log each
failure and keep the summary line honest instead.

**When stages depend on each other, yield to the upstream — but only while it's
making progress.** A batch that completed zero items is wedged on failures that
will recur every tick, and yielding to it forever starves everything downstream.

## How it runs

1. Something outside the app GETs `/api/cron` every 5 minutes — your host's
   scheduler in production, a compose sidecar locally. See
   [What drives the tick](#what-drives-the-tick).
2. Each tick reconciles the manifest into `public.app_scheduled_jobs`. Each row
   carries a materialized `next_run_at` (the platform computes the next fire time
   in JS — cron can't be evaluated in Postgres — and stores it; `NULL` means "due
   now"). For every enabled job whose `next_run_at ≤ now()`, the tick
   **atomically claims** it (`UPDATE … WHERE next_run_at ≤ now() AND
   running_since IS NULL … RETURNING`). Cron invocations can overlap or be
   delivered more than once; the claim guarantees a job runs **at most once**
   per due window regardless.
3. The claimed job runs with `buildSystemAppContext(slug)`; the result
   (`ok` / `error` / `timeout`, duration, error message) is written back, the
   **next** `next_run_at` is computed and stored in the same statement, and a
   history row is appended to `public.app_job_runs`.

Reconciliation also **deletes** rows for jobs the manifest no longer declares.
Their `public.app_job_runs` history survives under the old name, in the table
only: the admin page lists the jobs the manifest declares, so a renamed or
removed job's history no longer shows there.

An app that leaves the build is different: its rows are kept, each with its
enabled switch, and its jobs don't run until the app is back.

## Observing and pausing jobs

Admins see every declared job at **Administration → Scheduled Jobs**: its
schedule (interval or cron), last run, status/error, next-due, an
**enable/disable toggle**, and a **Run now** button. Disabling a job stops it on
the next tick without a redeploy — the safety valve for a misbehaving job. An
inactive app's jobs show as **App inactive** and don't run, on the tick or by
Run now. While an app's own migrations are behind this build, its jobs show as
**App updating** and don't run either; they stay due, so they run on the first
tick after the migrations are applied.

## What drives the tick

The tick is always an outside HTTP caller doing `GET /api/cron` with
`Authorization: Bearer $CRON_SECRET` — never a timer inside the app process. It
used to be an in-process `setInterval` started from `instrumentation.ts`; that
cannot work on Vercel, where a function instance is frozen between requests and
torn down when idle, so a timer set 5 minutes out would rarely fire.

Who that caller is depends on how you are running MixOS. **This is the part to get
straight before you conclude a job "isn't running":**

- **In production — your host's scheduler.** Each hosting path sets one up:
  Vercel Cron from `vercel.json`, the `mixos-cron` cron job on Render, a `cron`
  service on Railway, and the `cron` service in `deploy/docker-compose.yml` on
  your own server. Each sends the same request with `CRON_SECRET`. See
  [Install at popular providers](../hosting/providers/README.md).

- **On the Docker workflow (`npm run dev:docker`, `npm run docker:prod`) — the
  compose `cron` sidecar.** It is declared with `profiles: ["dev", "prod"]`, so
  it runs under *both*: it waits for the app container to report healthy, then
  GETs the same URL with the same bearer header every 300 seconds, forever.
  Jobs really do fire locally. Watch them:

  ```bash
  docker compose -p mixos logs -f cron
  # [cron] 2026-08-24T19:35:07Z GET /api/cron -> 200
  ```

  Read the status code, not just the fact that lines are appearing: `200` is a
  tick that reached `runDueJobs()`, `401` means the container's `CRON_SECRET`
  does not match the app's, and `000` means the request never landed at all
  (app container restarting, or unhealthy). The sidecar deliberately never exits
  on a failed tick, so a wall of `000` is what a broken app looks like from
  here. Details in
  [docs/local-docker.md](../local-docker.md#the-cron-sidecar).

- **On the own-Postgres path — nothing.** A bare `npm run dev` on the host is
  just the Next.js server; there is no sidecar and no timer, so no job will ever
  become due on its own. Fire ticks by hand (below).

Even when ticks arrive, jobs don't run in three cases, each shown on
**Administration → Scheduled Jobs**:

- **Scheduler paused.** The switch above the job list skips every tick while
  it's off: `/api/cron` still answers `200`, but no job runs until an admin
  clicks **Start tick**. **Run now** still works while it's paused.
- **App inactive.** A job whose app is switched off doesn't run, on the tick or
  by **Run now**, until an admin activates the app.
- **App updating.** While the app's own migrations are behind this build, its
  jobs don't run, on the tick or by **Run now**. They stay due, and run on the
  first tick after the release step applies the migrations.

On Vercel, the 5-minute tick needs a Pro plan: the Hobby plan allows only daily
cron schedules. See [Vercel with Supabase](../hosting/providers/vercel-supabase.md).

## Local development

Under `npm run dev:docker` / `npm run docker:prod` there is nothing to set up —
the sidecar above is already ticking every 5 minutes. When you don't want to
wait for the next tick, **Run now** on the admin page fires a single job
immediately.

The manual tick is for the own-Postgres path, where nothing is ticking at
all, and for driving a tick from a terminal:

```bash
npx tsx scripts/run-scheduled-jobs.ts
```

This runs one `runDueJobs()` tick. Running it while the sidecar (or a
deployment) is also ticking is safe and does **not** double-run anything: each
due job is taken by the atomic claim in step 2 above, so whichever tick reaches
it first runs it and the other simply finds nothing due.
