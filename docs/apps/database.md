# Database

## Overview

Apps can opt into a scoped database by setting `"database": true` in `app.json`. This gives the app its own isolated set of tables in the shared Postgres database. All tables are automatically prefixed with `_app_<app_slug>_` to prevent naming collisions between apps.

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
`supabase/migrations/`, and what applies it depends on which database you are
pointed at:

- **The local Docker stack** — `npm run db:local` (`supabase migration up
  --local`). `npm run dev:docker` runs this for you on every boot, immediately
  before `npm run migrate:apps`, so on the default workflow there is nothing to
  apply by hand.
- **Any other database** — `npm run db:migrate`, against `DATABASE_URL`.
- **A deployment** — the release step does both schemas in order; see
  [docs/hosting](../hosting/README.md#the-release-step).

`npm run db:push` (`supabase db push`) still works against a linked Supabase
project, and records what it applied in the same ledger as `db:migrate`. Keep it
away from a local stack: it targets the *remote* project `supabase link` points
at, so reaching for it to repair a local stack either fails with an unhelpful
"Cannot find project ref" or — if you have ever linked — quietly pushes
migrations at a cloud database instead.

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

### The query builder, in full

`context.db.table(name)` is the platform's query builder
([`src/lib/db/query.ts`](../../src/lib/db/query.ts)). It speaks the subset of the
Supabase/PostgREST client API the platform supports — same method names, same
`{ data, error }` results — directly over Postgres. Everything it has:

| | |
| --- | --- |
| **Verbs** | `select(columns?, { count: "exact", head? })`, `insert(row \| rows)`, `upsert(row \| rows, { onConflict?, ignoreDuplicates? })`, `update(row)`, `delete()` |
| **Filters** | `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `in(column, values)`, `is(column, null \| true \| false)`, `match({ column: value, ... })` |
| **Modifiers** | `order(column, { ascending?, nullsFirst? })`, `limit(n)`, `range(from, to)` |
| **Results** | `.select(columns?)` after a write returns the written rows; `.single()` returns one row or an error; `.maybeSingle()` returns one row or `null` |

A select list is `*`, column names, and `alias:column`, comma-separated. A filter
value is converted to the column's type by Postgres, so `.eq("id", "3")` and
`.eq("id", 3)` match the same row.

Rules worth knowing:

- **`update()` and `delete()` need a filter.** Without one they return an error
  instead of touching every row.
- **`upsert()` overwrites only the columns you pass.** The conflict target is
  `onConflict`, or the table's primary key. With `ignoreDuplicates` the stored
  row is kept.
- **`.single()` on a write is all or nothing.** If the write returned anything
  but one row, it is rolled back and you get the error.
- **Awaiting never throws for a database failure.** Check `error`: `code` is the
  Postgres SQLSTATE (`23505` for a unique violation, `23503` for a foreign key),
  `PGRST116` when `.single()` did not get exactly one row, or `MIXOS_QUERY` when
  the builder refused the query. The message can name tables and columns — never
  return it to the client (invariant 9 in [apps/AGENTS.md](../../apps/AGENTS.md)).
- **Not supported:** joins (embedded resources), `or()`, raw `filter()`,
  `rpc()`, and casts or JSON paths in a select list. They are absent from the
  type, so using one is a compile error. Shape data in two queries, or keep it
  in a JSONB column.

### What comes back

Rows arrive as JSON, serialized by Postgres itself — the same values the
PostgREST API this replaced returned, so code written against either reads the
same thing:

| Column type | Arrives as |
| --- | --- |
| `text`, `uuid`, `varchar` | string |
| `integer`, `smallint`, `real`, `double precision` | number |
| `numeric`, `decimal`, `bigint` | **number** — see below |
| `boolean` | boolean |
| `timestamptz` | ISO string with offset, `"2026-05-06T07:08:09.123456+00:00"` |
| `date` | `"2026-05-06"` |
| `jsonb`, `json` | the parsed value: object, array, string, number |
| `text[]` and other arrays | array |

Never a `Date` object: compare and sort timestamps as strings or convert them
where you need to.

**`numeric` and `bigint` are JSON numbers, with JSON's precision.** A `bigint`
past 2^53 (9007199254740991) and a `numeric` with more significant digits than
a double holds come back rounded. Use `integer` for counts, and keep values that
must survive exactly — money in minor units at scale, identifiers from another
system — in `text`, or in `numeric` read through a view that casts it to text.

**Coerce at the read boundary anyway** — the function that turns rows into your
domain type, and nowhere else. A `numeric` column round-tripped through other
code can arrive as a string (the raw `postgres` driver returns it that way, and
a value written into `jsonb` as `"42.5"` stays a string), so a defensive
converter costs nothing:

```ts
/** numeric values may arrive as numbers or strings; Number("") is 0, so guard the empty case. */
function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
```

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

The whole batch travels as one JSON parameter, so there is no bind-parameter limit to stay under. Chunk large batches anyway, to keep each statement's size and memory bounded — a few hundred rows is a comfortable default:

```ts
const INSERT_CHUNK = 200;
for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
  await db.table(CACHE_TABLE).insert(rows.slice(i, i + INSERT_CHUNK));
}
```

`upsert()` takes an array too, and like `insert()` writes the whole batch in one statement.

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

**A single-row JSONB snapshot**, when the upstream set is small and every read wants either one entity or all of them. The scoped client has no joins, so a row-per-entity table read alongside related rows means a query per entity on a path that is already fanning out to a connector:

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

Note that `_app_<slug>_` prefixing plus `context.db` is what isolates these tables. RLS is enabled on every table, but it grants nothing to anyone — the application connects as the role that owns the tables, which RLS does not apply to, so it is a lock on a hosted database's public API (Supabase serves one for every project) rather than an isolation boundary between apps. Table-name scoping is the isolation. A cache in the scoped DB is still tenant-isolated by construction in a way a module-level JavaScript cache is not.

How to *fill* and *serve* these tables — watermarks, TTLs, stale-while-revalidate, invalidation — is [Data Freshness](data-freshness.md).
