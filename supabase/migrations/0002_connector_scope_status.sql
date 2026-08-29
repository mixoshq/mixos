-- Per-scope grant status, snapshotted at the OAuth callback.
--
-- The catalogue of what an API offers moved into connector.json, where it
-- travels with the code and shows up in a diff. What stays in the database is
-- the one thing the manifest cannot know: what the provider actually granted.
--
-- Written at the token exchange, which is the only moment the answer changes.
-- Reading it is how the registry answers "a scope was added to the manifest and
-- this install is still running on the older, narrower grant" — the case that
-- otherwise surfaces only as calls quietly starting to fail.

create table if not exists public.connector_scope_status (
  connector_name text not null,
  -- Null means the tenant-wide grant an admin connected. A `userScoped`
  -- connector holds a grant per person, so one row set per user; keying on
  -- connector_name alone would report one user's refusal as everybody's.
  user_id        uuid references auth.users(id) on delete cascade,
  scope          text not null,
  -- granted: requested, and in the grant.
  -- refused: requested, and NOT in the grant.
  -- unknown: documented by the provider, never requested by this connector.
  status         text not null check (status in ('granted', 'refused', 'unknown')),
  recorded_at    timestamptz not null default now()
);

-- Same rule as every other table here: RLS on, no policies, so PostgREST's
-- anon/authenticated surface stays closed and only the service role reads it.
-- 0001 sweeps the catalog for this, but that sweep already ran by the time this
-- file applies — a migration that adds a table owns enabling it.
alter table public.connector_scope_status enable row level security;

-- Postgres does not treat nulls as equal, so a single unique constraint over
-- (connector_name, user_id, scope) would let a tenant row be inserted twice.
-- A matched pair of partial indexes is what actually enforces one row per
-- (connector, grant-holder, scope).
create unique index if not exists idx_connector_scope_status_tenant
  on public.connector_scope_status (connector_name, scope)
  where user_id is null;

create unique index if not exists idx_connector_scope_status_user
  on public.connector_scope_status (connector_name, user_id, scope)
  where user_id is not null;

-- The tab reads every row for one connector and grant-holder at once.
create index if not exists idx_connector_scope_status_lookup
  on public.connector_scope_status (connector_name, user_id);

-- The scraped-catalogue cache this replaces. The parse now happens at authoring
-- time and lands in the manifest, so nothing reads this table any more.
drop table if exists public.connector_scope_docs;
