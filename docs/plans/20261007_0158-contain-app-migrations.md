# Containing app migrations

## Context

Every `apps/<slug>/migrations/*.sql` was applied by the release step as the role
that owns every table, with no `database: true` check. The only containment was
a regex that prepended `_app_<slug>_` to a bare table name after a few keywords
(`create table`, `insert into`, `update … set`). Anything it did not match ran as
written: `update public.users set is_admin = true`, a policy or a view over
`public.users`, `grant`, `create extension`, `create function`, `create trigger`.
An app installed from the catalogue ships its own SQL, so any published app
could take the whole database.

Two more problems lived in the same rewrite. The prefix was `_app_` plus the slug
with `-` turned into `_`, so `my-app` and `my_app` shared every table, as did
`crm` + `reports_deals` and `crm-reports` + `deals`. And the rule meant for
`create index … on t (` also matched `on conflict (`, so a seed insert with
`on conflict` failed.

A role boundary alone would not have been enough. `context.db` runs as the
platform's role, so an object an app leaves behind runs with that role's
authority later, even if the DDL that created it was contained. Verified on
Postgres 17 and on the Supabase image: a trigger on the app's own table updated
`public.users` when the platform inserted a row through `context.db`, and a
column default calling `query_to_xml('select email, password_hash from
public.users', …)` copied platform rows into the app's table on insert.

The goal: an app's migrations can create, alter and fill only that app's own
tables, and can create nothing (trigger, default, function, view, policy) that
later reads or writes anything else, on every supported host, whether the app
came from the repository or the catalogue.

## Decisions

- **A schema and a role per app, applied as that role, and every statement
  checked first.** All three, because each covers what the others leave open:
  the schema makes `create table notes` land in `app_<slug>.notes` with nothing
  rewritten; the role makes Postgres refuse a migration that reaches past the
  schema while it runs; the check bounds what the migration leaves behind for
  the platform's role to run later.
- **Names: `app_<slug>` and `mixos_app_<slug>`, with one encoding.** `-` becomes
  `_`, `_` becomes `__`, and a slug must be lowercase letters and digits in words
  joined by single hyphens or underscores, so every run of underscores in a name
  is one or two long and reads back to one slug. The build enforces the slug
  form for every app, refuses a slug whose role name Postgres would truncate,
  and fails if two apps' names coincide (`src/lib/apps/app-identifiers.ts`).
- **The role is NOLOGIN and holds nothing but its schema.** The release step
  creates it, then grants it to itself (`WITH INHERIT TRUE, SET TRUE` on 16+) so
  `context.db`, on the same connection role, reaches the app's tables, and so it
  can hand the role ownership. An existing role is used only if it has no
  attribute beyond NOLOGIN, is a member of no role, and is used in no other
  database on the server: roles are server-wide, and two MixOS databases on one
  server would otherwise reach each other's app data through a shared role. An
  existing schema owned by anyone else is refused. The catalog is the record of
  what exists, so there is no marker row: a restored dump has the schema and not
  the role, and the next release step creates the role again.
- **Each file runs through a `SECURITY DEFINER` function owned by the app's
  role**, with `search_path = app_<slug>, pg_temp` and
  `standard_conforming_strings = on`, created, called and dropped inside the
  file's own transaction, under the migration lock. Switching the connection's
  role is escapable (a default can reset the role); inside a security-definer
  function Postgres refuses `SET ROLE` and `SET SESSION AUTHORIZATION`. Making the
  function afresh for each file means nothing a file does to it carries over.
  Pinning `standard_conforming_strings` keeps the server ending strings where the
  checking parser did.
- **The check is Postgres's own parser and an allowlist.** `libpg-query`
  (constructive-io/libpg-query-node, MIT): libpg_query compiled to WebAssembly,
  PostgreSQL 18 grammar, released continuously, and the parsing core under
  `pgsql-parser`, without the deparser this does not need. No native build or
  install script. Every node of every statement must be a kind the policy knows,
  with fields it knows, or it is refused, so syntax a later grammar adds is
  refused until allowed on purpose (`scripts/app-sql-policy.ts`).
- **What the allowlist allows.** Tables, indexes (btree, hash, gist, gin, brin,
  spgist), views, sequences and enum types in the app's schema; `ALTER`,
  `RENAME`, `COMMENT ON` and `DROP` of those; `INSERT` (with `ON CONFLICT`),
  `UPDATE`, `DELETE`, `TRUNCATE` and `WITH` around them; every ordinary
  constraint, with foreign keys only between the app's own tables. Refused:
  triggers, rules, functions, procedures, `DO`, `CALL`, policies, grants, role,
  ownership and session statements, extensions, schemas, domains, materialized
  views, partitioned, inherited, typed and temporary tables, tablespaces,
  `CONCURRENTLY`, transaction control, `COPY`, a bare `SELECT`, `reg*` types, `$n`
  parameters, and any name outside the app's schema, including `pg_` names, which
  an unqualified reference would otherwise find in pg_catalog.
- **One list of callable functions, for every expression.** Defaults, checks,
  generated columns, index expressions and predicates, views and the statements
  that fill tables may call only `now`, `gen_random_uuid`, `lower`, `upper`,
  `length`, `char_length`, `btrim`/`ltrim`/`rtrim`, `abs`, `round`, `date_trunc`,
  `date_part`/`extract`, `timezone`, `similar_to_escape` (`SIMILAR TO`),
  `jsonb_build_object`, `jsonb_build_array`, `count`, `sum`, `avg`, `min` and
  `max`, unqualified or in `pg_catalog`, plus the clock keywords
  (`CURRENT_TIMESTAMP` and kin). Each depends only on its arguments (or the clock
  and a random number) and reads no table, setting or file, runs no SQL text,
  looks up no object by name. One-shot statements are held to the same list,
  because a setting is readable by any role and a value copied into the app's
  table is the app's to serve. No subquery in a stored expression; operators
  only from `pg_catalog`.
- **Triggers and generated columns: strict, plus one platform trigger.** No app
  trigger and no function-calling default beyond the list (the owner chose this
  over a declared escape). An app lists `updatedAt: [{ table, column? }]` in
  `app.json`; the release step installs `public.mixos_touch_updated_at()` as a
  `BEFORE UPDATE` trigger on each, and removes it from a column no longer
  listed. The function sets the one column to `now()` through
  `jsonb_populate_record` and reads nothing else; `EXECUTE` is revoked from
  everyone, since Postgres checks it only when a trigger is created.
- **`CREATE EXTENSION` is not allowed in app migrations.** `gen_random_uuid()` is
  built in from Postgres 13; an extension an app needs is the platform's to
  enable in its own migrations.
- **Runtime stays on the platform's role.** `context.db` keeps the one shared
  pool, pinned to the app's schema, and reaches it as a member of the app's
  role. Connecting as the app's role would need per-app login roles and pools
  (`SET SESSION AUTHORIZATION` is superuser-only), so the check is the portable
  answer.
- **`database: true` is required to ship `migrations/`**, to list `updatedAt`,
  and to declare a `sync` (the platform keeps its state table,
  `app_<slug>._sync_state`, in the app's schema, owned by the platform's role
  so the app's migrations cannot change it). Only apps in the registry run SQL:
  a folder the generator skipped runs none.
- **The build checks too.** The registry generator runs the same check on every
  migration file and the `updatedAt` columns against what the files create, and
  fails with the file and line; the release step checks pending files again,
  all of them before it applies any.
- **No migration of existing installs.** This is MixOS's first release and no
  apps are installed anywhere, so there is no `_app_*` table to move.
- **RLS stays on.** The release step's sweep covers each app schema as well as
  `public`. The platform reaches app tables as a member of the owner, which RLS
  treats as the owner.

## Structure

- `src/lib/apps/app-identifiers.ts` (+ test) — slug form, the encoding, schema
  and role names, the overlap check.
- `scripts/app-sql-policy.ts` (+ test) — the parser, the allowlist, problems with
  file and line, and what a set of files creates (for the `updatedAt` check).
- `scripts/app-migrations.ts` — `addTablePrefix` removed; the registry decides
  which apps run; role and schema bootstrap; the per-file security-definer apply;
  `_sync_state` in the app schema; `updatedAt` triggers; RLS sweep over app
  schemas. `scripts/app-migrations.integration.test.ts` runs it against a real
  Postgres as a non-superuser owner.
- `scripts/app-migration-files.ts` (+ test) — listing by registry app;
  `undeclaredMigrations`.
- `scripts/generate-project-registry.ts` — slug form, database declarations, the
  SQL check, `updatedAt`, the overlap check; the build stamp lists only accepted
  apps' migrations. `scripts/manifest-schemas.ts`, `src/lib/apps/types.ts` —
  `updatedAt`.
- `scripts/sync-app-registry.ts` — takes the app list, for tests.
- `src/lib/db/query.ts` (+ test) — every table schema-qualified; `DbClient`
  takes a schema and `.schema()`. `src/lib/apps/scoped-db.ts` — `context.db` and
  the MCP read-only client pinned to the app's schema.
- `supabase/migrations/0009_app_schemas.sql` — `get_app_schema(text[])` keyed on
  schema, `mixos_touch_updated_at()`, schema version 9.
  `src/lib/apps/admin-actions.ts` uses the new function.
- `package.json` — `libpg-query`; `build:ops` copies its `.wasm` beside the
  bundle. `scripts/release.test.ts` bundles with a fixture registry and the
  `.wasm`.
- `eslint.config.mjs` — the scoped-client message.
- Docs: `docs/apps/database.md`, `docs/apps/architecture.md`,
  `docs/security-architecture.md` (§3.2, §3.5, §4, §8, §23),
  `docs/secure-edge-gateway-architecture.md`, `docs/hosting/README.md`,
  `docs/local-docker.md`, `docs/apps/data-freshness.md`, `apps/AGENTS.md`, README,
  `OS-UPDATES.md`, `WHATS-NEW.md`, the `/mixos app` and `/mixos convert` actions.

## Verification

- Unit tests: the encoding (round trip over every short slug, the merged pairs,
  the overlap check against the old encoding); the policy (the careers and
  key-numbers migrations allowed; the reproduced escalations, `update
  public.users`, a view over it, policies, code, grants, roles, settings,
  extensions and every cross-schema form refused; line numbers after multibyte
  text); the schema-qualified builder.
- Integration (`MIXOS_TEST_DATABASE_URL`), as a non-superuser `CREATEROLE` owner,
  on Postgres 13, Postgres 17 and the Supabase image: role and schema created and
  owned as designed, nothing in `public`; RLS on; `ON CONFLICT` seed applies;
  `context.db` reads, writes and upserts through membership; `updatedAt` moves on
  update; a second run is a no-op; the escalations refused before anything runs
  with `public.users` untouched; with the check skipped, the role alone still
  refuses `update public.users`, `set role`, `set session authorization` and
  `set_config('role', …)`; a runtime error names its file and line; an app with
  migrations and no database, and a folder outside the registry, run nothing;
  `my-app` and `my_app` keep separate tables; a role with LOGIN, a membership,
  or a use in another database is refused.
- The bundled release step (`scripts/release.test.ts`) on the same three
  servers, including two at once and a refused migration that names its line.
- The registry generator against fixture apps: an escalating migration, an
  `updatedAt` column that is missing or not a timestamp, migrations or a sync
  without a database, and an invalid slug each fail the build with the reason.
- End to end, on the same three servers, as a non-superuser `CREATEROLE` owner
  of a fresh database, with two fixture apps: `npm run release` built both apps'
  roles and schemas, applied their migrations, seeded once through
  `ON CONFLICT`, installed the `updatedAt` trigger and enabled RLS; the builder
  pinned to the app's schema inserted, updated (moving `updated_at`), upserted
  and read a view. A migration holding the plan's escalations (a trigger and
  function updating `public.users`, a `query_to_xml` default over password
  hashes, `update public.users`, a view over it) failed the build, and, added
  after a build that had accepted the app, failed the release step with each
  line named and nothing applied, `public.users` unchanged. `npm run build:ops`
  then `node ops/release.cjs` did the same from the bundle.
- `npx tsx scripts/generate-project-registry.ts`, `npm run typecheck`,
  `npm run lint`, `npm test`, `npm run build`.

## Follow-ups

- The site's own pages that describe app isolation (the permissions concept,
  the isolation page, what MixOS is) still describe the prefix; the pages synced
  from `docs/` follow on the next sync.
- Give CI a Postgres service so the integration tests run on every PR.
- Widen the function list only on a request from a real app, one function at a
  time, each a pure built-in.
- One MixOS database per Postgres server stays a documented limitation (the
  owner's call). If two on one server become a need, give app roles a
  per-install namespace rather than relaxing the shared-role check.
