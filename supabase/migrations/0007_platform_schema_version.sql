-- Two controls that the platform had no way to express before: which schema the
-- running image expects, and a way for two privileged operations to not run at
-- the same time.
--
-- ── WHY A SCHEMA VERSION ────────────────────────────────────────────────────
--
-- The platform's own schema is applied out of band — `npm run db:push` against a
-- linked project, `npm run db:local` against the Docker stack — while the code
-- that depends on it ships inside an image. Nothing connected the two. A deploy
-- that shipped an image expecting column X against a database that had not yet
-- been migrated would start, pass its liveness probe, accept traffic, and fail
-- on whichever request touched X first. The failure surfaces as scattered 500s
-- in unrelated features rather than as "the database is behind".
--
-- This is the oldest fix there is. WordPress has carried a `db_version` option
-- since 2003 and compares it against the constant baked into the code on every
-- admin request (wp-admin/admin.php), refusing to run until the two agree.
-- Same idea, one row:
--
--   * `platform_settings.platform_schema_version` is what the DATABASE has.
--     Its value is the number of the highest migration applied from this
--     directory.
--   * The image carries what it EXPECTS, derived at build time from the highest
--     numbered file in supabase/migrations/ (see scripts/generate-project-registry.ts).
--   * The readiness probe compares them and returns 503 while the database is
--     behind, so an orchestrator holds the new revision out of service instead
--     of routing to it.
--
-- ══ THE RULE THIS CREATES ═══════════════════════════════════════════════════
--
--   EVERY NEW MIGRATION IN THIS DIRECTORY MUST BUMP THE ROW, LAST, TO ITS OWN
--   NUMBER. A migration that changes the schema without bumping it is invisible
--   to the gate, which is worse than having no gate — it reports agreement that
--   was never checked.
--
-- The check is deliberately `<`, not `<>`. A database AHEAD of the image is the
-- normal, safe ordering: migrate first, then deploy. Only the reverse is an
-- error, and only the reverse is refused.
--
-- Using the existing key/value table rather than a new one is the point: it is
-- already the place a single platform-wide fact lives, and it is already
-- covered by the RLS sweep in 0001.

insert into public.platform_settings (key, value)
values ('platform_schema_version', '7')
on conflict (key) do update
  set value = excluded.value,
      updated_at = now();

-- ── Advisory locks ──────────────────────────────────────────────────────────
--
-- Registering an extension from the repository writes a directory into apps/,
-- connectors/ or themes/ and then re-runs scripts/generate-project-registry.ts,
-- which rewrites the shared src/generated/*.ts modules. Two admins registering
-- at the same time produce two concurrent generator processes writing the same
-- three files — and the rollback path re-runs the generator again, on top of
-- whatever the other run has just written. The window is small and the outcome
-- is a corrupted registry that neither admin did anything to deserve.
--
-- ── WHY A TABLE AND NOT pg_advisory_lock ────────────────────────────────────
--
-- Postgres has advisory locks built in, and they are the wrong tool here for two
-- independent reasons:
--
--   1. Session-scoped locks (`pg_advisory_lock`) do not survive a transaction
--      pooler. Supabase's pooler runs in transaction mode, where consecutive
--      statements from one client may land on different backends — so the lock
--      is taken on one connection and the release runs on another. This is the
--      deployment the platform actually targets (see src/lib/db/pg-options.ts).
--   2. Transaction-scoped locks (`pg_advisory_xact_lock`) do survive pooling,
--      but only last as long as the transaction. A register holds the lock
--      across a network download and a child process; holding a database
--      transaction open for that is its own problem.
--
-- So: a row, with an expiry. This is again what WordPress settled on
-- (WP_Upgrader::create_lock, an INSERT IGNORE on the options table with a
-- release timeout), and for the same reason — the lock has to outlive a
-- connection and has to self-heal when the holder dies mid-operation without
-- releasing.
--
-- `holder` is a per-acquisition token, not an identity. It exists so that a
-- process whose lock has already expired and been taken by someone else cannot
-- release the new holder's lock on its way out.
create table if not exists public._platform_locks (
  name        text primary key,
  holder      text not null,
  acquired_at timestamptz not null default now()
);

-- The RLS sweep in 0001 runs only when 0001 runs. `npm run migrate:apps` carries
-- a backstop that catches tables added later, but a table that is only protected
-- by a script someone has to remember to run is not protected. Same rule as
-- everywhere else in this schema: RLS on, zero policies. The application
-- connects as service_role and is unaffected.
alter table public._platform_locks enable row level security;
