# Data Freshness (incremental sync, snapshots, caching)

## Declare the sync; don't hand-roll it

Everything below describes a shape apps used to build by hand — and one app got
it wrong in the most expensive way available: it persisted a provider's
pagination cursor between scheduler ticks, the provider expired it before the
next tick, and the job failed on the same dead cursor **278 times over 19 days**
without the watermark advancing once.

That shape is now the platform's, and the cursor never leaves the run:

```jsonc
// app.json — a sync needs "database": true, where its watermark is kept
"database": true,
"sync": [{
  "name": "calls",
  "schedule": { "everyMinutes": 60 },
  "source": "gong",
  "window": { "coldStartDays": 30, "defaultDays": 7, "minDays": 1 },
  "budgetMs": 200000
}]
```

```ts
// apps/<slug>/sync/calls.ts
import { defineSync } from "@/lib/apps/sync";

export default defineSync<Call>({
  fetchPage: async (ctx, { from, to, cursor, signal }) => {
    const page = await ctx.connectors.gong.listCalls({ from, to, cursor, signal });
    return { items: page.calls, nextCursor: page.cursor };
  },
  upsert: async (ctx, calls) => {
    for (const c of calls) await ctx.db!.table("calls").upsert(toRow(c), { onConflict: "id" });
  },
});
```

That is the whole app. The platform owns:

| Concern | What it does |
| --- | --- |
| The cursor | Lives inside one run's loop and is **never handed to you**. There is nowhere to persist it, which is what makes the 19-day bug unrepresentable rather than merely documented. |
| The watermark | Advances **only** on a window that actually drained. An interrupted run costs nothing, because the writes are upserts. |
| The budget | Checked at every page boundary against both the clock and `ctx.signal` — the deadline alone misses an admin abort, the signal alone fires only once you have overrun. |
| Window tuning | Halved when a window does not drain, relaxed back toward the default when it does, and the size persisted so a shrink survives the tick boundary. Relaxing matters as much as shrinking. |
| The empty guard | A drained window that reaches the present and returned nothing does **not** advance the watermark — an upstream outage returns zero rows, not an error, and writing that through blanks every card. The next tick reads it again, grown by the time since. An empty window that ends in the past does advance: it can never grow, so holding it would stop the sync for good. |
| The state table | `_sync_state` is created for you by `npm run migrate:apps`. You never write a migration for it, and it has **no cursor column**. |

A sync appears at **Administration → Scheduled Jobs** like any other job — same
atomic claim, same enable/disable toggle, same run history — because it *is* one,
under a reserved `sync:` name.

Everything below is still worth reading: it is why the platform does what it
does, and it is the reference for the cases a declared sync does not cover (a
stepped backfill, a snapshot table, a stale-while-revalidate cache).

## Overview

Most MixOS apps show data that lives somewhere slow — a CRM, a call recorder, a
warehouse, a mailbox. Fetching it on the request path makes a page that takes
fifteen seconds to open; fetching all of it on every scheduler tick makes a job
that times out. This guide is the standard shape for the middle: **a background
job maintains a local copy incrementally, and the read path serves that copy.**

Three rules carry most of the value, and each one is here because it broke
production:

1. **Budget by wall clock**, not by item count. A count can't predict runtime
   when per-item cost varies. See
   [scheduled-jobs.md](scheduled-jobs.md#staying-inside-the-budget).
2. **Never persist a provider cursor across ticks.** Cursors expire in less time
   than the interval between runs.
3. **Serve reads from your own table**, and let a missed job degrade to a slower
   page rather than an empty one.

Related: [Scheduled Jobs](scheduled-jobs.md) for the job lifecycle,
[Database](database.md) for the tables, [Connectors](connectors.md) for what a
connector owes a job.

## Pick the right tier

Most timeouts are a tier mistake — deep history attempted on a cron tick.

| Tier | Cadence | Scope | Where it lives |
| --- | --- | --- | --- |
| Steady state | Every tick | The **recent** window only | `jobs/<name>.ts` |
| Catch-up | Successive ticks | Whatever the watermark hasn't reached | The same job, returning `hasMore` |
| Deep history | Once, or on request | All time | An ops Job, or a user-driven stepped backfill |

A steady-state job should pull weeks, not years. Give the incremental path a
`COLD_START_DAYS` (30 is a reasonable default) and leave all-time history to an
explicit `runFullBackfill`; a calendar sync might pull one `DEFAULT_MONTHS_BACK`
and leave 3/6/9-month pulls to a user-initiated backfill. If a cold population
would take weeks to converge at your per-tick cap, it belongs in an ops Job — say
so in a comment rather than hoping the cron catches up.

## Incremental sync

### Use a date window, not a stored cursor

A provider's pagination cursor is valid **only inside one run**. Persisting one
across ticks is the single most expensive mistake this platform has seen: a sync
stored the provider's cursor, the next tick arrived an hour later, the provider
had expired it, and every subsequent tick failed on the same dead cursor — 278
consecutive errors over 19 days, with the watermark never advancing once.

A date range has no server-side TTL, so it resumes across ticks for free:

```ts
// lib/server/<source>-sync.ts
const startMs = state?.synced_through
  ? Date.parse(String(state.synced_through))
  : nowMs - COLD_START_DAYS * DAY_MS;
const from = new Date(startMs);
const endMs = Math.min(from.getTime() + windowDays * DAY_MS, nowMs);
```

Cursors are fine *within* a single call — drain them in a loop and discard them.
They are also fine in a long-running ops backfill, where one process drains them
in seconds. They are never fine in `sync_state`.

### Advance the watermark only on a drained window

If the window didn't finish inside the budget, leave the watermark alone. The
rows already written are simply written again next tick, which costs nothing
because the write is an upsert. This is what makes an interrupted run free, and
it is why idempotency is not optional here.

```ts
// Drained: advance and record how far we got.
await writeState(db, { synced_through: to.toISOString(), cursor: null });
// Not drained: watermark stays put. Next tick re-scans from the same point.
```

### Let the window tune itself

A fixed window is wrong for any upstream with uneven density. Halve it when it
doesn't drain, relax it back toward the default when it does, and **persist the
current size** so the shrink survives the tick boundary:

```ts
// on success
const relaxed = clampWindow(Math.min(windowDays * 2, DEFAULT_WINDOW_DAYS));
// ...and on overflow
const shrunk = clampWindow(windowDays / 2);
```

Relaxing matters as much as shrinking: without it, one dense stretch shrinks the
window permanently. Store the size in your state table and clamp it between a
floor and the default.

### Pass an explicit mode; never infer intent from null state

If two callers want different things from the same function, give them a
parameter. A backfill that clears `synced_through` relies on "null means
all-time"; the scheduler wants "null means 30 days back". Overloading null
silently truncates an all-time backfill to one month:

```ts
export type SyncMode = "incremental" | "history";
```

### An error caused by your own stored state must clear that state

Anything you persisted can go stale, and re-raising on it wedges the job forever.
Recognize those errors and treat them as "start over", not as failures. Two
recognizers earn their keep in most syncs — an `isCursorExpiredError` (clear the
cursor and retry) and an `isEmptyWindowError`, where the provider 404s on an empty
window and the correct reading is *drained*, so the watermark should still
advance.

### Patch state by column

The scoped DB's `upsert` leaves unlisted columns as stored, so write only the keys
you own. A read-modify-write of the whole row loses updates the moment a second
job touches it:

```ts
/** Upsert a partial `sync_state`; unlisted columns keep their stored values. */
async function writeState(db: ScopedDb, patch: Record<string, unknown>) {
  await db.table("sync_state").upsert({ id: 1, ...patch }, { onConflict: "id" });
}
```

## Snapshots and caches

### The single-row snapshot table

When the upstream is small and every read wants either one entity or all of them,
one row holding a JSONB map beats one row per entity. The scoped client has no
joins and no `in()`, so a per-entity table means an N+1 read on a path that is
already fanning out to a connector.

```sql
-- migrations/012_customer_health_snapshot.sql
create table if not exists customer_health_snapshot (
  id int primary key default 1,
  metrics jsonb not null,
  week_start date,            -- which period the numbers describe
  fetched_at timestamptz not null default now()
);
```

This is the house shape, and it generalizes to any small keyed lookup — an owner
directory, an id map. Document the JSONB shape in the migration; it is the only
schema that column will ever have. Carry a period field (`week_start`) whenever
the upstream is coarser than "now", so the UI can say which period it is showing
instead of implying it is current.

### One resolver, two entry points

Never let the job and the read path fetch independently — they will disagree. Put
the fetch and the persist in one pair of functions and have both callers use them:

```ts
// lib/server/health-snapshot.ts
export async function fetchHealthSnapshot(db: DatabricksConnector) { /* pure */ }
export async function writeHealthSnapshot(db: ScopedClient, snap: Snapshot) { /* */ }
```

The scheduled job is then the *fast* path, not the only path: the read path warms
a cold or expired snapshot itself, so a missed run degrades to one slower page
load rather than a blank card. The scheduled job and the read path's
`loadHealthLookup` both call the same pair.

### `load*` may write; `peek*` never does

MCP tool handlers get a read-only `ctx.db` and must not trigger an expensive
rebuild as a side effect of a model asking a question. Ship two entry points over
one shared resolver rather than a boolean flag:

| Function | `db` type | Behavior |
| --- | --- | --- |
| `load*` | `ScopedClient` | Serves fresh; queries and **persists** when cold or stale |
| `peek*` | `ReadOnlyScopedClient` | Serves whatever is cached, at any age; never writes |

Keep them as separate exports. The read-only client throwing is a real signal, and
swallowing it inside a shared function hides a genuine mistake later. Name them in
pairs — `loadHealthLookup` / `peekHealthLookup`, `loadOwnerDirectory` /
`peekOwnerDirectory` — so the caller picks deliberately.

A `peek*` caller should report the age it served, so a stale answer is at least an
explicitly dated one — and set a threshold past which it says so out loud.

### Size the TTL from the cadence, and the cadence from the upstream

Pick the cadence from the upstream's grain: a weekly-grained mart has nothing new
to say between Mondays, so schedule that job `"0 6 * * 1"`. Then set the read
path's refresh bar to **one cadence plus a margin**, so a healthy snapshot never
trips it but a missed run self-heals:

```ts
// lib/server/health-snapshot.ts
/** The job syncs weekly, so a healthy snapshot is at most 7 days old and never
 *  trips this. 8 days means a missed week, a failing job, or a first deploy
 *  self-heals on the next page load instead of showing em-dashes. */
const SNAPSHOT_TTL_MS = 8 * 24 * 60 * 60 * 1000;
```

### Never blank a good snapshot with an empty result

An upstream outage or a permissions change returns zero rows, not an error. Write
that through and every card goes blank until someone notices. Guard it in both
places, with **opposite** failure modes chosen by which surface can act on it:

```ts
// The job — throw, so /admin/scheduled-jobs shows `error` and someone sees it.
if (count === 0) {
  throw new Error("mart returned 0 rows; keeping the previous snapshot");
}
```

```ts
// The read path — degrade to the stale snapshot. Health is one card on a page
// that still has renewal, tickets and NPS; an outage should cost the card,
// not the page.
```

Related: a null value means *unknown*, never zero. Make that explicit in the
shape you hand out (`size: 0` means "no data", not "all zeros") so a caller can't
report a warehouse gap as a decline.

### Stale-while-revalidate for connector-heavy payloads

For a built payload that is expensive but not period-grained — a book, a detail
page — cache it in the scoped DB keyed by a string, and layer two TTLs:

| Age | Behavior |
| --- | --- |
| < soft TTL | Serve as-is |
| soft → hard TTL | Serve stale, refresh in the background |
| > hard TTL, or cold | Build synchronously, then cache |
| `refresh: true` | Always rebuild (wire to the client's post-edit refetch) |

Two things this must get right, and both are easy to miss:

- **Coalesce concurrent builds** of the same key. A cold page load mounts several
  widgets at once and would otherwise drive N identical connector crawls.
- **An invalidation during a build must stop that build from writing**, or a
  rebuild that started before a write resurrects the pre-write payload. Keep a
  per-key generation counter, bump it on invalidation, and skip the cache write
  when the generation moved.

**Don't write this yourself, and don't copy it.** It ships at
[`@/lib/apps/swr-cache`](../../src/lib/apps/swr-cache.ts). Create one instance per
app, in one module, and import `getCached` / `peekCached` / `deleteCached` from
there:

```ts
// apps/<slug>/lib/server/swr-cache.ts — the app's single instance.
import { createSwrCache } from "@/lib/apps/swr-cache";

export const { getCached, peekCached, deleteCached } = createSwrCache({
  namespace: "<slug>",        // namespaces the process-local coalescing maps
  softTtlMs: 5 * 60 * 1000,   // serve as-is below this
  hardTtlMs: 60 * 60 * 1000,  // rebuild synchronously above this
});
```

One instance per app is the invariant, not a style preference. The TTLs and the
`namespace` have to be identical for every caller of a given key, or two routes
caching the same payload will neither coalesce nor agree on when it's stale. And
`namespace` is what keeps two apps that both cache `"metrics:current"` from
sharing an in-flight slot — the DB rows are already isolated by the scoped `db`
you pass; the in-memory maps are not.

The app needs a `swr_cache` table (bare name — the platform prefixes it):

```sql
create table if not exists swr_cache (
  cache_key  text primary key,
  payload    jsonb not null,
  fetched_at timestamptz not null default now()
);
```

Note that this caches in the **tenant-scoped DB**, not a module-level map — a
process-local cache has no tenant key on this platform.

> **Earlier versions of this guide said "copy it rather than reinventing it"**,
> pointing at one app's implementation, while also listing "copying a cache helper
> and letting it drift" as an anti-pattern below. Those pulled against each other,
> and the copy that resulted proved the anti-pattern right. The implementation was
> promoted into `src/`; apps now import it and keep only their namespace and
> TTLs.

Caching here is a database layer, not an HTTP one. Don't reach for
`Cache-Control` or `revalidate` on an app route.

### Resolve dependencies inside the build closure

A background revalidation runs later than the call that triggered it. If you
resolve a snapshot outside the build function and close over the value, the
rebuild reuses a lookup captured before the sync that prompted it:

```ts
// Resolved inside the closure, so a background revalidation picks up a snapshot
// written since the cached payload was built.
getCached(db, BOOK_CACHE_KEY, async () =>
  buildAccountBook(monday, db, directory, await loadHealthLookup(db, databricks)),
);
```

When a builder is shared by a route and an MCP tool, take a **resolver** rather
than a resolved value, so each caller supplies `load*` or `peek*` — declare the
dependency as `healthLookup: () => Promise<HealthLookup>` rather than
`healthLookup: HealthLookup`.

### A job that refreshes data invalidates the caches built on it

Materializing a new snapshot is only half the work — anything cached on top of it
is now wrong:

```ts
// jobs/sync-health-metrics.ts
await deleteCached(ctx.db, BOOK_CACHE_KEY);
```

The shim has no `.like()`, so wildcard invalidation is impossible and **cache-key
layout is a design decision**. Keys you will need to invalidate as a set should be
enumerable; for keys that aren't (`detail:<companyId>:<dealId>`), rely on the soft
TTL and say so in a comment.

### Delete exactly what you refetched

Scope every cache-replacing delete to the window you actually pulled. This is the
invariant that lets a shallow scheduled sync and a deep on-demand backfill share
one table:

```ts
// lib/server/calendar-sync.ts
await db.table(CACHE_TABLE).delete()
  .eq("implementation_id", implementationId)
  .eq("user_id", userId)
  .gte("start_utc", window.startUtc)
  .lte("start_utc", window.endUtc);
```

Without the `gte`/`lte` bound, the next 1-month tick silently erases all nine
backfilled months. The cost is that an item deleted upstream *outside* the synced
window stays cached until a backfill covers it again — usually the right trade for
history that rarely changes, but state it in a comment either way.

## Stepped backfill: work that doesn't fit in one tick

Deep history belongs in an ops Job or a user-driven backfill. For the
user-driven kind, do **not** put a multi-minute loop in one request — it dies on a
proxy timeout with no way to resume. Slice it and let the client drive:

- Put the slicing rules in a **client-safe module** under `lib/` (not
  `lib/server/`) so the UI builds the step list from the same definition the route
  validates against. One definition means the client can't request a slice the
  route would reject — export a `backfillSlices` list and an `isValidBackfillSlice`
  guard from that one module, and have both sides import them.
- One short request per `(entity, slice)`, run sequentially by the client, with
  real progress rather than a guessed bar.
- Thread `request.signal` into the connector, so a caller navigating away stops
  the pull instead of leaving it running unattended.
- Go **oldest-first**, and stamp the watermark only on the slice that reaches the
  present — an old slice landing must not make a stale entity look freshly synced.
- An interrupted run keeps every slice it already committed. Report "stopped early
  after syncing N", not a failure.

This works for the same reason the tick-bounded job does: each step replaces
exactly the window it fetched, so the slices are order-independent and safe to
repeat.

## Anti-patterns (do not do these)

- Persisting a provider pagination cursor in your state table between job runs.
  Use a date window.
- Advancing a watermark past work you didn't finish.
- Inferring caller intent from a null watermark instead of taking an explicit
  mode parameter.
- Re-raising an error that was caused by your own stored state — clear the state
  and retry instead.
- Read-modify-writing a whole state row when you only own one column.
- Overwriting a good snapshot with an empty upstream result, in either the job or
  the read path.
- Reporting a missing snapshot as zeros rather than as unknown.
- An unbounded `delete()` before re-inserting a window's worth of rows.
- Calling a connector on the request path for data a job could have materialized.
- Building a cache payload from dependencies resolved outside the build closure.
- Triggering a rebuild (`getCached`) from an MCP tool handler — use `peekCached`
  and report the age.
- Caching in a module-level map or on `Cache-Control`. Cache in the scoped DB,
  which is tenant-isolated by construction.
- Hand-rolling or copying an SWR cache. Instantiate `@/lib/apps/swr-cache`.
- Creating more than one instance of it per app, or giving two apps the same
  `namespace`.
