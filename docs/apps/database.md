# Database

## Overview

Apps can opt into a scoped database by setting `"database": true` in `app.json`. This gives the app its own isolated set of tables in the shared Supabase database. All tables are automatically prefixed with `_app_<app_slug>_` to prevent naming collisions between apps.

```json
// app.json
{
  "name": "My App",
  "database": true
}
```

## Table Naming

When you create tables in your migrations, use the bare table name. The platform automatically adds the `_app_<app_slug>_` prefix. For example, if your app folder is `sales-tracker`:

| You write | Actual table name |
| --- | --- |
| `orders` | `_app_sales_tracker_orders` |
| `line_items` | `_app_sales_tracker_line_items` |

## Creating Migrations

Migrations are SQL files in your app's `migrations/` directory. They run in alphabetical order and are tracked so each migration only runs once. Use a numbered prefix to control order.

```
apps/my-app/
  migrations/
    001_create_orders.sql
    002_add_status_column.sql
    003_create_line_items.sql
```

## Writing a Migration

Each migration file contains raw SQL. Write your table names without the prefix — it will be added automatically.

```sql
-- migrations/001_create_orders.sql
create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  total decimal(10, 2) not null default 0,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create index idx_orders_user on orders(user_id);
create index idx_orders_status on orders(status);
```

```sql
-- migrations/002_add_status_column.sql
alter table orders add column if not exists updated_at timestamptz;
```

## Running Migrations

Run the migration script to apply pending migrations for all apps:

```
npm run migrate:apps
```

The script scans each app's `migrations/` directory, checks which files have already been applied, and runs new ones in order. Applied migrations are tracked in the `_migrations` table so they never run twice.

This runner handles **app** migrations only. The platform's own schema lives in
`supabase/migrations/`, and which Supabase CLI command applies it depends on
which database you are pointed at:

- **The local Docker stack** — `npm run db:local` (`supabase migration up
  --local`). `npm run dev:docker` runs this for you on every boot, immediately
  before `npm run migrate:apps`, so on the default workflow there is nothing to
  apply by hand.
- **A linked hosted project** — `npm run db:push` (`supabase db push`).

Keep those two straight. `db:push` targets the *remote* project `supabase link`
points at, not your machine, so reaching for it to repair a local stack either
fails with an unhelpful "Cannot find project ref" or — if you have ever linked —
quietly pushes migrations at a cloud database instead.

Either way, the platform schema is what creates `_migrations`, the table this
runner records itself in. Apply it before running this one.

## Querying Your Tables

Use `context.db` to query your app's tables. The scoped client automatically applies the table prefix, so you always use the bare table name.

```ts
// In a page or server-side code
const db = context.db;

// Insert a row — "orders" becomes "_app_my_app_orders" automatically
const { data, error } = await db.table("orders").insert({
  user_id: context.user.id,
  total: 99.99,
  status: "pending",
});

// Query rows
const { data: orders } = await db.table("orders")
  .select("*")
  .eq("status", "pending")
  .order("created_at", { ascending: false });

// Update
await db.table("orders")
  .update({ status: "completed" })
  .eq("id", orderId);

// Delete
await db.table("orders")
  .delete()
  .eq("id", orderId);
```

### `numeric` and `decimal` come back as **strings**

This is the single most expensive surprise in this layer, so it gets its own heading.

Postgres `numeric(p, s)` / `decimal(p, s)` / `bigint` are arbitrary-precision types. The `postgres` driver will not silently narrow them to a JS `number` — that would lose precision — so it hands you a **string**:

```ts
// migration: score numeric(4, 1)
const { data } = await db.table("gar_history").select("*");
data[0].score;                 // "42.5"  ← a string
typeof data[0].score;          // "string"
data[0].score.toFixed(1);      // 💥 TypeError: score.toFixed is not a function
```

TypeScript won't save you: you declared the column `number | null` because that's what the migration says, and the driver's return type is `unknown`-ish, so the cast is accepted and the lie survives to runtime.

**Coerce at the read boundary — the function that turns rows into your domain type — and nowhere else:**

```ts
/** numeric/decimal arrive as strings; Number("") is 0, so guard the empty case. */
function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

return rows.map((r) => ({
  week: String(r.week),
  score: numOrNull(r.score),
  drain: numOrNull(r.drain),
}));
```

The crash is the *cheap* version of this bug. The expensive version is silent: `Number.isFinite("42.5")` is `false`, so any guard written that way treats a perfectly good value as missing. In one app that meant a whole row of week-over-week deltas rendered as blank — no error, no log, a feature that simply wasn't there. If you're chasing a value that's "sometimes just not shown", check the column type first.

Two smaller notes on the same theme:

- **`count`, `sum`, and `avg` are `numeric` too.** `select("count(*)")` gives you `"17"`.
- **Prefer `integer` when the value is a count.** Reach for `numeric` only when you actually need the scale, and when you do, coerce it on the way in *and* out.

### Range Filters

Alongside `eq` / `neq` / `match`, the chain supports `gte`, `lte`, `gt`, and `lt`. These matter most for scoping a *write* to a window — replacing just the slice of a cache you actually refetched, rather than the whole table:

```ts
await db.table("events_cache")
  .delete()
  .eq("user_id", userId)
  .gte("start_utc", window.startUtc)
  .lte("start_utc", window.endUtc);
```

All four are also available on the read-only client that MCP tool handlers receive, so a tool can range-query without needing write access.

### Batch Inserts

`insert()` accepts an array and issues **one** multi-row `INSERT` instead of a statement per row. Rows may be ragged — the statement covers the union of all keys and any row missing one gets `NULL`. Inserting an empty array is a no-op, not an error, so you don't need to guard it.

```ts
// One round trip, not rows.length round trips.
await db.table("events_cache").insert(rows);
```

Chunk large batches. Postgres caps a statement at 65535 bind parameters, so the row limit depends on your column count — 200 rows × ~12 columns ≈ 2400 parameters is a comfortable default:

```ts
const INSERT_CHUNK = 200;
for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
  await db.table(CACHE_TABLE).insert(rows.slice(i, i + INSERT_CHUNK));
}
```

There is currently **no** multi-row `upsert` — it takes a single object. A batch of upserts is still one statement per row, which is worth knowing when you size a job's per-tick budget.

### Partial Upserts

`upsert()` leaves columns you didn't list at their stored values. Write only the keys you own rather than read-modify-writing the whole row — otherwise two writers to the same row lose each other's updates:

```ts
// Patches one column; every other column keeps what's stored.
await db.table("sync_state").upsert(
  { id: 1, synced_through: to.toISOString() },
  { onConflict: "id" },
);
```

## Cache and Snapshot Tables

Apps that read from a slow upstream keep a local copy in their own scoped tables. Two shapes cover almost every case.

**A single-row JSONB snapshot**, when the upstream set is small and every read wants either one entity or all of them. The scoped client has no joins and no `in()`, so a row-per-entity table means an N+1 read on a path that is already fanning out to a connector:

```sql
create table if not exists customer_health_snapshot (
  id int primary key default 1,
  metrics jsonb not null,   -- { "<entityId>": { ...figures } }
  week_start date,          -- which period the figures describe
  fetched_at timestamptz not null default now()
);
```

**A keyed cache row**, when you're caching built payloads rather than upstream records — one row per cache key, holding the payload plus `fetched_at`.

Conventions for both: always store `fetched_at` so a reader can compute age and decide for itself whether the data is usable; document the JSONB shape in the migration, since it's the only schema that column will ever have; and carry a period field whenever the upstream is coarser than "now", so the UI can say which period it's showing instead of implying it's current.

Note that `_app_<slug>_` prefixing plus `context.db` is what isolates these tables. RLS is enabled on the platform's own tables, but it grants nothing to anyone — the application connects with the Supabase **service role**, which bypasses RLS entirely, so it is a lock on the public PostgREST surface rather than an isolation boundary between apps. Table-name scoping is the isolation. A cache in the scoped DB is still tenant-isolated by construction in a way a module-level JavaScript cache is not.

How to *fill* and *serve* these tables — watermarks, TTLs, stale-while-revalidate, invalidation — is [Data Freshness](data-freshness.md).
