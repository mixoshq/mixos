-- Which builds use this database.
--
-- An extension removed from the repository keeps its data in each database
-- until an admin deletes it there (src/lib/repository/delete-data.ts). Deleting
-- has to know the extension is gone from every build this database serves, and
-- the serving build alone can't say: one database is often served by more than
-- one build. A host's rollback serves an older build without running a release
-- step, a preview can share production's database, and checkouts can share a
-- development database.
--
-- So each build records what it carries here, at its release step, when its
-- server starts and on the cron tick, at most every ten minutes
-- (src/lib/platform/builds-seen.ts):
--
--   build_key     Which build. `checkout:<id>` for a checkout, from its
--                 .mixos/checkout-id; otherwise `build:<commit>:<hash>`, the
--                 commit it was built from (or `unknown`) and a hash of the
--                 apps and connectors it carries.
--   apps          The app slugs it carries.
--   connectors    The connector names it carries.
--   last_seen_at  When it last recorded itself.
--
-- A build last seen more than 30 days ago is pruned. Delete data is refused
-- while any build seen in the last 24 hours, other than the caller's own,
-- carries the extension.
--
-- Small by design: one row per build, and few builds share a database.

create table if not exists public.platform_builds_seen (
  build_key    text primary key,
  apps         text[] not null default '{}',
  connectors   text[] not null default '{}',
  last_seen_at timestamptz not null default now()
);

-- Same rule as every other table: RLS on, no policies. 0001's catalog sweep has
-- already run by the time this file applies, so this migration enables it itself.
alter table public.platform_builds_seen enable row level security;

-- The schema version this file brings the database to. See 0007 and OS-UPDATES.md.
insert into public.platform_settings (key, value)
values ('platform_schema_version', '12')
on conflict (key) do update
  set value = excluded.value,
      updated_at = now();
