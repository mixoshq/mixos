# Database

## Overview

Apps can opt into a database by setting `"database": true` in `app.json`. The app gets a schema of its own in the shared Postgres database, `app_<slug>`, and reaches it as `context.db`. Its tables live there and nowhere else: another app's tables are in another schema, and the platform's are in `public`.

```json
// app.json
{
  "name": "My App",
  "database": true
}
```

Only an app with `"database": true` may ship `migrations/`. A `migrations/` folder without it fails the build.

## Where Your Tables Live

Write bare table names, in migrations and in `context.db.table(...)`. They are names in your app's schema, and nothing rewrites them. If your app folder is `sales-tracker`:

| You write | The table |
| --- | --- |
| `orders` | `app_sales_tracker.orders` |
| `line_items` | `app_sales_tracker.line_items` |

The schema's name is the slug with `-` written as `_` and `_` written as `__`, so `my-app` and `my_app` get different schemas. A slug is lowercase letters and digits, in words joined by single hyphens or underscores; the build refuses any other folder name.

The schema belongs to a role of its own, `mixos_app_<slug>`, which cannot log in. Your migrations run as that role, so they can create and change only what is in your schema.

**One MixOS database per Postgres server.** Roles belong to the whole server, not to one database, so two MixOS databases on the same server would share each app's role. The release step refuses an app role that another database on the server already uses. Give each MixOS install a Postgres server of its own.

**Your schema outlives your folder.** When the app leaves the build, because its folder is removed or renamed or the build skips it, the release step keeps its schema, its tables and the record of which migrations ran, and the app finds them all again when it comes back. Renaming the folder makes a new slug, and so a new, empty schema; the old one stays under the old name. See [docs/hosting](../hosting/README.md#when-an-app-leaves-the-build).

## Creating Migrations

Migrations are SQL files in your app's `migrations/` directory. They run in alphabetical order and are tracked so each migration only runs once. Use a numbered prefix to control order.

```
apps/my-app/
  migrations/
    001_create_orders.sql
    002_add_updated_at.sql
    003_create_line_items.sql
```

## Writing a Migration

Each migration file contains SQL, run as written. Use bare table names.

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
-- migrations/002_add_updated_at.sql
alter table orders add column if not exists updated_at timestamptz not null default now();
```

Seed rows go in a migration too, and `on conflict` works as it does anywhere else:

```sql
insert into settings (id, value) values (1, 'default') on conflict (id) do nothing;
```

## What a Migration May Contain

Every statement is parsed and checked before any of it runs: by the build, so a problem shows up on your next `npm run dev` or `npm run build`, and again by the release step, which is what applies the SQL. A refused statement is reported with its file, line and reason, and nothing in that release is applied.

A migration may:

- create, alter, rename, comment on and drop tables, indexes, views, sequences and enum types in your schema
- add, change and remove rows in your tables: `INSERT` (with `ON CONFLICT`), `UPDATE`, `DELETE`, `TRUNCATE`
- use the ordinary constraints: primary keys, unique, foreign keys between your own tables, checks, defaults, identity and generated columns

It may not:

- name anything outside your schema: another app's tables, `public.users` or any platform table, `information_schema`, or a `pg_` catalog
- create triggers, rules, functions, procedures, `DO` blocks or row-level security policies
- grant or revoke privileges, create or change roles, or change who owns something
- change session settings: `SET`, `RESET`, `SET ROLE`, `SET SESSION AUTHORIZATION`
- create extensions, schemas, domains, materialized views, partitioned, inherited or temporary tables
- use `BEGIN`, `COMMIT` or `CONCURRENTLY`: each file already runs in a transaction of its own
- be a bare `SELECT`

An expression anywhere in a migration — a default, a check, a generated column, an index, a view, a statement that fills a table — can call only these built-in functions: `now`, `gen_random_uuid`, `lower`, `upper`, `length`, `char_length`, `btrim`, `ltrim` and `rtrim` (and `TRIM(...)`), `abs`, `round`, `date_trunc`, `date_part` (and `EXTRACT(...)`), `timezone` (`AT TIME ZONE`), `jsonb_build_object`, `jsonb_build_array`, and the aggregates `count`, `sum`, `avg`, `min` and `max`. `CURRENT_TIMESTAMP`, `CURRENT_DATE` and the other clock keywords are allowed, so are operators (`SIMILAR TO` among them) and casts, and a default, check or index may not contain a subquery.

Why so strict: a default, a check, an index or a view runs later, whenever the platform reads or writes your table, and the platform's database role can read every table. Your migration runs as your app's role, but what it leaves behind would run as the platform's. So nothing an app creates may run code or reach past its own schema. The list is [`scripts/app-sql-policy.ts`](../../scripts/app-sql-policy.ts), and a change to it is a platform change.

## Keeping `updated_at` Current

A migration can't create a trigger, so the platform provides the one apps need. List the column in `app.json`:

```json
{
  "database": true,
  "updatedAt": [{ "table": "orders" }, { "table": "notes", "column": "edited_at" }]
}
```

On every `UPDATE` of a row, the platform's trigger sets the column to `now()`. `column` defaults to `updated_at`, and has to be a `timestamptz` or `timestamp` column your migrations create; the build checks that they do. The release step installs the trigger after your migrations run, and takes it off a column you stop listing. It fires on updates only, so give the column a default (`default now()`) for new rows.

## Running Migrations

Run the migration script to apply pending migrations for all apps:

```
npm run migrate:apps
```

The script takes every app in the registry with `"database": true`, creates its role and schema if they do not exist, checks every file it has not applied yet, and then runs them in order, each in its own transaction, as the app's role. Applied migrations are tracked in the `_migrations` table so they never run twice. A folder the registry did not accept never has its SQL run.

**Until they run, your app waits.** While the build carries a migration of yours that the database hasn't applied, none of your app's code runs, because it would meet tables that aren't there yet. Its pages show "This app is being updated. Try again shortly.", and its API routes answer 503 with that message and `Retry-After: 30`. Its jobs wait and stay due, a consumer of its services gets `PROVIDER_UPDATING`, its hook listeners don't run, and its MCP tools refuse. Every other app serves as usual. Your app runs again within 30 seconds of the migrations being applied, by `npm run migrate:apps` locally or the release step in a deployment, with no restart.

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

Use `context.db` to query your app's tables. It is pinned to your app's schema, so you always use the bare table name.

```ts
// In an API route handler, or other server code handed `context`.
// Pages and widgets get no `context`; they call the app's own routes.
const db = context.db;
if (!db) throw AppError.unavailable("This app has no database.");

// Insert a row into your schema's orders table
const { error } = await db.table("orders").insert({
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

**A single-row JSONB snapshot**, when the upstream set is small and every read wants either one entity or all of them. The scoped client has no joins, so a row-per-entity table read alongside related rows takes a query per table and a join in code, on a path that is already fanning out to a connector:

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

Note that your schema, and `context.db` being pinned to it, is what isolates these tables. RLS is enabled on every table, but it grants nothing to anyone — the platform reaches your tables as a member of your app's role, which RLS treats as their owner, so it is a lock against any other way in (Supabase serves a public API for every project) rather than the boundary between apps. The schema is the boundary. A cache in the scoped DB is still tenant-isolated by construction in a way a module-level JavaScript cache is not.

How to *fill* and *serve* these tables — watermarks, TTLs, stale-while-revalidate, invalidation — is [Data Freshness](data-freshness.md).
