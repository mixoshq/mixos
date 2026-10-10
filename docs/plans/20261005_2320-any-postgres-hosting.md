# Any Postgres, and hosting it

## Context

MixOS reached its database two ways: supabase-js over PostgREST for nearly
everything, including every app's `context.db`, and a raw postgres.js pool for
the handful of queries PostgREST could not express. The first path made every
deployment a Supabase deployment, or one that ran and secured its own PostgREST:
`SUPABASE_URL` plus a service-role JWT, roles named `anon`, `authenticated` and
`service_role`, and an `auth.users` table for one foreign key. The schema itself
could only be applied with the Supabase CLI.

The goal: run MixOS on any Postgres 13+ with nothing but a `DATABASE_URL`, and
make hosting it easy — one server with Docker Compose (and Coolify or Dokploy on
top of it), Render, Railway, and Vercel with any database.

Found on the way: migration 0002 pointed `connector_scope_status.user_id` at
`auth.users`, which MixOS never populates, so every per-user scope snapshot
failed its foreign key and the scope tab never filled in for user-scoped
connectors (0008).

## Decisions

- **Replace PostgREST with an in-process query builder, not a hosted PostgREST.**
  The codebase used a small part of the client API — `from`, `select` (columns
  only), `eq`/`neq`/`in`/`match`, `order`, `single`/`maybeSingle`,
  `insert`/`update`/`upsert`/`delete`, one count, two RPCs — so matching it is
  bounded work, and it removes a service from every hosting story. Keeping
  PostgREST would have meant a sidecar, JWT minting, role bootstrap and a
  schema-reload trigger on every host.
- **Match PostgREST's observable behaviour, not just its method names.** Rows are
  serialized by Postgres (`to_json`), writes go through
  `json_populate_recordset(null::<table>, …)`, filter values are converted to the
  column's type by `json_populate_record`, results keep `{ data, error, count,
  status }` with SQLSTATE codes and PGRST116 for `.single()`, and a write that
  breaks `.single()` is rolled back. Proven by a parity suite run against
  PostgREST v16.1 (see Verification).
- **Bind everything as `::json` or `::text`.** postgres.js asks the server for
  each untyped parameter's type and re-encodes the JS value for it — an untyped
  `"true"` against a boolean is sent as `f`, and a JSON string is stringified
  twice. Typed parameters avoid both, and the conversion happens in a scalar
  subquery so it runs once per statement and keeps indexes usable (checked with
  EXPLAIN).
- **Identifiers are the security boundary.** Every table, column, alias and
  conflict target must be a plain identifier (≤ 63 characters) and is quoted;
  everything else is refused before SQL is written. That is what keeps the
  `_app_<slug>_` prefix a boundary. Builder state lives in private fields so a
  builder cannot be retargeted after the prefix is applied. `update()` and
  `delete()` refuse to run without a filter.
- **`.rpc()` is not part of the builder.** Its two callers are platform code and
  now call the schema's functions through `sql`.
- **Migrations stay in `supabase/migrations/` and share the Supabase CLI's
  ledger** (`supabase_migrations.schema_migrations`). `npm run db:migrate` and
  `supabase db push` see each other's work, so existing installs need no
  conversion. Each file applies in a transaction under a transaction-scoped
  advisory lock (safe behind a transaction pooler, safe to run concurrently).
- **Make the old migrations portable in place.** The `anon`/`authenticated`/
  `service_role` grants in 0001, 0005 and 0006 are now skipped where those roles
  do not exist, and 0002 references `public.users`. Applied migrations never
  re-run, so existing databases are unaffected; 0008 repairs the foreign key on
  them.
- **One release step, inside the image.** `scripts/release.ts` runs the platform
  schema, the app registry and app migrations, then the first admin
  (create-only, so a redeploy never resets a changed password). It is bundled to
  `ops/release.cjs` because Render and Railway run pre-deploy commands in the
  service's own image and cannot pick a build stage.
- **The Compose stack is its own file, not a profile.** `deploy/docker-compose.yml`
  has its own database and secrets, publishes for a reverse proxy, and is what
  Coolify and Dokploy point at. The root `docker-compose.yml` is the dev stack
  on the Supabase CLI with committed dev secrets — mixing the two would put a
  production service next to public keys. HTTPS (Caddy) is a second file so a
  host with its own proxy never starts one.
- **Platform keys accept base64 as well as hex.** Render's `generateValue` and
  Coolify's `SERVICE_REALBASE64_32_*` are 32 random bytes in base64, so a
  one-click deploy can generate every key.
- **The public URL falls back to the platform's own.** `RENDER_EXTERNAL_URL` and
  `RAILWAY_PUBLIC_DOMAIN` join `VERCEL_*` as environment-only (never
  header-derived) fallbacks for `NEXTAUTH_URL`.
- **Render uses paid instances.** Free ones run no pre-deploy command and cannot
  receive private network traffic (the cron tick). The free variant is
  documented, not defaulted.
- **Local development keeps the Supabase CLI** for its Postgres. Nothing in it
  is required by the app any more.

## Structure

- `src/lib/db/query.ts` — the builder; `src/lib/db/server.ts` — the entry point;
  `src/lib/db/supabase.ts` removed; `@supabase/supabase-js` removed.
- `src/lib/db/query.test.ts` (no database) and
  `src/lib/db/query.integration.test.ts` (runs when `MIXOS_TEST_DATABASE_URL` is
  set).
- `src/lib/auth/revocation.ts`, `src/lib/apps/admin-actions.ts` — RPCs to `sql`.
- `supabase/migrations/0001`, `0002`, `0005`, `0006` — portable;
  `0008_connector_scope_status_user_fk.sql` — the foreign key fix, schema 8.
- `scripts/platform-migrations.ts` + `scripts/db-migrate.ts`;
  `scripts/app-migrations.ts` (moved out of `migrate.ts`); `scripts/admin-seed.ts`
  (out of `seed-admin.ts`); `scripts/release.ts`; `npm run db:migrate`,
  `release`, `build:ops`.
- `Dockerfile` — builds and ships `ops/` and `supabase/migrations/`.
- `deploy/docker-compose.yml`, `deploy/docker-compose.https.yml`,
  `deploy/new-env.sh`, `deploy/.env.example`; `render.yaml`; `railway.json`.
- `src/lib/env/keys.ts` (+ test), `scripts/generate-keys.ts`,
  `src/lib/env/origin.ts`.
- `scripts/docker-up.ts` — stops writing `SUPABASE_URL` / the service-role key.
- Docs: `docs/hosting/` (new), `docs/apps/database.md` (the builder's full
  contract), `docs/security-architecture.md`, `docs/local-docker.md`, README,
  `apps/AGENTS.md`, `.env.local.example`, `.env.docker`, `OS-UPDATES.md`,
  `WHATS-NEW.md`, the `/mixos` deploy and init actions.

## Verification

- Parity: 81 chains — reads, every filter, ordering, ranges, counts,
  single/maybeSingle, inserts (ragged, empty, undefined fields, Dates), upserts
  (partial, batch, ignoreDuplicates, primary-key default), updates, deletes,
  rollbacks, escaping — run through postgrest-js against PostgREST v16.1 and
  through the builder against identical tables. 76 identical in data, count and
  error code; the 5 differences are inputs PostgREST rejects (`null` in an `in`
  list, `eq` on jsonb or an array column) and its own codes for a missing table
  or column (PGRST205/PGRST204, where the builder reports 42P01/42703).
- Unit tests (20) and integration tests (8) for the builder; key-format tests.
- The release step against an empty plain Postgres 17: all 8 platform
  migrations, every app migration, the RLS sweep, the admin; idempotent on a
  second run.
- `npm run db:migrate` against the local Supabase database migrated by the CLI:
  applied only 0008, and `supabase migration list` shows it applied.
- The full app on plain Postgres, with `next dev` and with the production image
  in `deploy/docker-compose.yml`: readiness at schema 8, sign-in, every admin
  page, the careers app's create/update/upsert/delete routes, key-numbers
  settings, and a cron tick answered 200. A failing release step run with
  `docker compose run --rm migrate` leaves the serving app untouched.
- `npm run typecheck`, `npm run lint`, `npm test`.

## Follow-ups

- Publish the Railway template and add the Render and Railway buttons to the
  README once the repository they should deploy is settled.
- Give CI a Postgres service so the integration tests run on every PR.
- Consider dropping the unused Supabase services from the local stack, or moving
  local development to a plain Postgres container.
