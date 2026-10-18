-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at https://mozilla.org/MPL/2.0/.

-- ============================================================================
-- MixOS — the platform schema.
--
-- Applied with `npm run db:migrate` against any Postgres 13 or later, or with
-- the Supabase CLI (`npm run db:push`, `npm run db:local`). Both record it in
-- the same ledger, `supabase_migrations.schema_migrations`, so either can take
-- over from the other. A later migration is `NNNN_name.sql` with the next free
-- number, and ends by setting `platform_schema_version` to that number.
--
-- ── Authorization model ────────────────────────────────────────────────────
-- The application connects as the role that owns these tables (DATABASE_URL)
-- and makes every authorization decision in application code
-- (src/lib/apps/access.ts, src/lib/connectors/config.ts, src/lib/mcp/). There
-- are no per-user database roles and no policies that grant anything.
--
-- RLS is ENABLED on every table, with ZERO policies. On Supabase this is
-- load-bearing: every Supabase project runs PostgREST, which publishes the
-- `public` schema to the `anon` and `authenticated` roles, so a table with RLS
-- off is readable by anyone holding the publishable anon key, whether or not
-- MixOS uses that API. Enabled with no policies is deny-all for those roles.
-- RLS does not apply to a table's owner, so the application is unaffected, and
-- migrations run as the role the application connects as. The sweep at the end
-- of this file enables it on every table in `public`; adding a policy is what
-- would open one up.
-- ============================================================================

-- ── Identity ────────────────────────────────────────────────────────────────

-- People, who sign in with email and password. `session_version` is carried in
-- the session token and compared on every session resolution: bumping it
-- (bump_session_version below) ends every session that person has.
create table public.users (
  id                      uuid primary key default gen_random_uuid(),
  email                   text unique not null,
  display_name            text not null,
  is_admin                boolean not null default false,
  password_hash           text,
  onboarding_completed_at timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  session_version         integer not null default 0
);

-- ── Apps ────────────────────────────────────────────────────────────────────

-- One row per app the release step has seen (scripts/sync-app-registry.ts),
-- kept when the app leaves the build.
--
--   missing_since        When a release step first ran without the app; null
--                        while the build carries it.
--   code_hash            A hash of apps/<slug>/ (scripts/app-code-hash.ts).
--   returned_changed_at  Set when the app came back with different files; it
--                        stays off until an admin activates it.
--   identity             Where the app came from (src/lib/repository/identity.ts);
--                        null until a release step records it.
--   identity_changed_at  Set when a release step found a different extension
--                        under the slug; activating it, with the slug typed,
--                        clears it.
--   replaced_identity    The identity it replaced, while that is pending.
--   global               Whether the app was global at the last release step
--                        that carried it; null until one has.
--   needs_grants_since   When a release step found that people lost the app
--   needs_grants_reason  because it stopped being global, and why. Cleared
--                        when an admin grants it to someone or it is global
--                        again.
create table public.apps (
  slug                text primary key,
  name                text not null,
  description         text,
  icon                text,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  missing_since       timestamptz,
  code_hash           text,
  returned_changed_at timestamptz,
  identity            text,
  identity_changed_at timestamptz,
  replaced_identity   text,
  global              boolean,
  needs_grants_since  timestamptz,
  needs_grants_reason text check (needs_grants_reason = 'global-ended')
);

-- A grant, a role, or both. `role` is meaningful only within the app; null
-- resolves to the manifest's defaultRole at read time. `role_only` is true for
-- a row that records only a role on a global app, which is never access
-- (src/lib/apps/grant-rule.ts). No default: every path that writes a row says
-- which it is.
create table public.user_app_grants (
  user_id    uuid not null references public.users(id) on delete cascade,
  app_slug   text not null references public.apps(slug) on delete cascade,
  role       text,
  granted_at timestamptz not null default now(),
  granted_by uuid references public.users(id),
  role_only  boolean not null,
  primary key (user_id, app_slug)
);

create index idx_user_app_grants_user
  on public.user_app_grants(user_id);

-- An app the user has installed for themselves: a layout preference, not
-- access. `position` orders the menu bar; `pinned` decides whether the app sits
-- in the bar or only in the Apps dropdown.
create table public.user_apps (
  user_id      uuid not null references public.users(id) on delete cascade,
  app_slug     text not null references public.apps(slug) on delete cascade,
  position     integer not null default 0,
  pinned       boolean not null default true,
  installed_at timestamptz not null default now(),
  primary key (user_id, app_slug)
);

create index idx_user_apps_user          on public.user_apps(user_id);
create index idx_user_apps_user_position on public.user_apps(user_id, position);
create index idx_user_apps_user_pinned   on public.user_apps(user_id, pinned);

-- One shared password per app, as a bcrypt hash. It unlocks the app's pages and
-- routes that accept `password`; with no row, they fail closed.
create table public.app_passwords (
  app_slug       text primary key references public.apps(slug) on delete cascade,
  password_hash  text not null,
  set_by_user_id uuid references public.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- An app's settings, filled in by an admin. Keyed by slug alone, with no foreign
-- key, like telemetry and the app migration ledger.
create table public.app_settings (
  app_slug   text not null,
  key        text not null,
  value      text not null,
  encrypted  boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (app_slug, key)
);

create table public.app_api_keys (
  id          uuid primary key default gen_random_uuid(),
  app_slug    text not null,
  -- Shown in the admin list, so a key can be told apart without revealing it.
  label       text not null,
  -- HMAC-SHA256 of the key (src/lib/apps/api-keys.ts). The key is never stored.
  digest      text not null unique,
  -- The key's first characters, for display only.
  hint        text not null,
  -- The routes the key may call, `["GET /items"]`, or `["*"]` for every route
  -- that accepts a key. An empty array authorizes nothing.
  scopes      jsonb not null default '[]'::jsonb,
  created_by  uuid references public.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz,
  revoked_at  timestamptz,
  last_used_at timestamptz
);

create index idx_app_api_keys_app on public.app_api_keys (app_slug);

-- The MCP tools an admin has switched on. A tool with no row is off, so a new
-- install, a new tool and a renamed tool all start off.
create table public.app_mcp_tool_settings (
  app_slug    text not null references public.apps(slug) on delete cascade,
  tool_name   text not null,
  enabled     boolean not null default false,
  updated_by  uuid references public.users(id) on delete set null,
  updated_at  timestamptz not null default now(),
  primary key (app_slug, tool_name)
);

-- The app migrations applied from apps/<slug>/migrations/ (scripts/app-migrations.ts).
create table public._migrations (
  id             serial primary key,
  app_slug       text not null,
  migration_file text not null,
  applied_at     timestamptz not null default now(),
  unique (app_slug, migration_file)
);

-- ── Dashboard ───────────────────────────────────────────────────────────────

-- Each user's dashboard layout (react-grid-layout positions).
create table public.dashboard_layouts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  layout     jsonb not null default '[]',
  updated_at timestamptz not null default now(),
  unique (user_id)
);

-- Widget instances, each with its own config.
create table public.dashboard_widgets (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  app_slug   text not null references public.apps(slug) on delete cascade,
  widget_id  text not null,
  config     jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index idx_dashboard_widgets_user
  on public.dashboard_widgets(user_id);

-- ── Connectors ──────────────────────────────────────────────────────────────

-- A connector's credentials, one row per connector, encrypted with
-- CONNECTOR_ENCRYPTION_KEY. For three-legged OAuth the tenant grant lives here
-- too. `last_verified_*` record the last Test Connection that succeeded, kept
-- out of the credential blob, which is handed to the connector as it is.
create table public.connector_configs (
  connector_name       text primary key,
  encrypted_credentials text not null,
  configured_by        uuid references public.users(id),
  configured_at        timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  last_verified_at     timestamptz,
  last_verified_detail text
);

-- Each person's own OAuth grant for a `userScoped` connector, encrypted with
-- USER_OAUTH_ENCRYPTION_KEY. The client id and secret stay in connector_configs.
-- Deleted with the user: these are live access to a third-party account.
create table public.user_connector_oauth (
  user_id               uuid not null references public.users(id) on delete cascade,
  connector_name        text not null,
  encrypted_credentials text not null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  primary key (user_id, connector_name)
);

create index idx_user_connector_oauth_user
  on public.user_connector_oauth(user_id);

-- What the provider granted, per scope, recorded at the token exchange.
-- `user_id` is null for the tenant grant and names the person for a
-- `userScoped` connector's grant.
create table public.connector_scope_status (
  connector_name text not null,
  user_id        uuid references public.users(id) on delete cascade,
  scope          text not null,
  -- granted: requested, and in the grant. refused: requested, and not in it.
  -- unknown: documented by the provider, and not requested.
  status         text not null check (status in ('granted', 'refused', 'unknown')),
  recorded_at    timestamptz not null default now()
);

-- Postgres does not treat nulls as equal, so one unique constraint over
-- (connector_name, user_id, scope) would let a tenant row in twice. Two partial
-- indexes keep one row per connector, grant-holder and scope.
create unique index idx_connector_scope_status_tenant
  on public.connector_scope_status (connector_name, scope)
  where user_id is null;

create unique index idx_connector_scope_status_user
  on public.connector_scope_status (connector_name, user_id, scope)
  where user_id is not null;

create index idx_connector_scope_status_lookup
  on public.connector_scope_status (connector_name, user_id);

-- Inbound webhook deliveries already seen, so a replayed delivery is refused.
-- The key is a digest of the signature, never the signature itself.
create table public.connector_webhook_events (
  event_key      text primary key,
  connector_name text        not null,
  received_at    timestamptz not null default now()
);

create index connector_webhook_events_received_at_idx
  on public.connector_webhook_events (received_at);

-- ── Notifications ───────────────────────────────────────────────────────────

-- Web Push subscriptions, one per browser endpoint. `p256dh` and `auth` are the
-- subscription's public key material, usable only with the server's VAPID
-- private key. A re-subscribe upserts on `endpoint`.
create table public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_push_subscriptions_user
  on public.push_subscriptions(user_id);

-- ── Scheduler ───────────────────────────────────────────────────────────────

-- One row per declared (app, job), reconciled from the app registry on each
-- tick. A job is claimed with one atomic UPDATE on `next_run_at` and
-- `running_since`, so overlapping ticks never run it twice. The cadence is
-- exactly one of `interval_minutes` or `cron` (with an optional IANA
-- `timezone`); the next fire time is computed in JS into `next_run_at`, and a
-- null `next_run_at` is due now.
create table public.app_scheduled_jobs (
  id               uuid primary key default gen_random_uuid(),
  app_slug         text not null,
  job_name         text not null,
  interval_minutes int,
  cron             text,
  timezone         text,
  next_run_at      timestamptz,
  enabled          boolean not null default true,
  last_run_at      timestamptz,
  last_status      text,          -- 'ok' | 'error' | 'timeout'
  last_error       text,
  last_duration_ms int,
  running_since    timestamptz,   -- non-null while a run holds the claim
  updated_at       timestamptz not null default now(),
  unique (app_slug, job_name),
  -- `<>` on two booleans is XOR: exactly one cadence.
  constraint app_scheduled_jobs_cadence_ck
    check ((interval_minutes is not null) <> (cron is not null))
);

-- Run history. `trigger` says who started the run: the schedule or an admin's
-- Run now.
create table public.app_job_runs (
  id          uuid primary key default gen_random_uuid(),
  app_slug    text not null,
  job_name    text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text,               -- 'ok' | 'error' | 'timeout'
  error       text,
  duration_ms int,
  trigger     text not null default 'scheduled'
    check (trigger in ('scheduled', 'manual'))
);

create index idx_app_job_runs_lookup
  on public.app_job_runs (app_slug, job_name, started_at desc);

-- ── Platform ────────────────────────────────────────────────────────────────

-- Platform-wide key/value settings: `scheduler_enabled`, the applied `theme`,
-- `platform_schema_version` and the release step's records. Exactly these
-- three columns.
create table public.platform_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

-- Locks that outlive a connection, with a holder token so a holder whose lock
-- lapsed can't release the next one's (src/lib/platform/lock.ts). Session
-- advisory locks don't survive a transaction pooler, and a transaction can't
-- stay open across the download and child process an install runs.
create table public._platform_locks (
  name        text primary key,
  holder      text not null,
  acquired_at timestamptz not null default now()
);

-- Which builds use this database, and what each carries
-- (src/lib/platform/builds-seen.ts). Delete data refuses while another build
-- seen in the last day carries the extension.
create table public.platform_builds_seen (
  build_key    text primary key,
  apps         text[] not null default '{}',
  connectors   text[] not null default '{}',
  last_seen_at timestamptz not null default now()
);

-- Token buckets, one per (limiter, subject). `subject` starts with the
-- limiter's name, `<name>::<identity>`, so two limiters on one axis never share
-- a row. `tokens` may go to -1, which keeps a hammered bucket's deficit.
create table public.rate_buckets (
  scope       text not null
    check (scope in ('ip', 'user_app', 'route', 'api_key')),
  subject     text not null,
  tokens      double precision not null,
  last_refill timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (scope, subject)
);

-- Wrong app passwords, per `<ip>::<app_slug>`, for the unlock lockout. Only
-- failures count; a correct password clears the row.
create table public.app_unlock_failures (
  subject      text primary key,
  failures     int         not null default 0,
  -- Start of the current window. A failure after it starts a new one.
  window_start timestamptz not null default now(),
  -- Non-null and in the future while locked.
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);

create index idx_app_unlock_failures_updated
  on public.app_unlock_failures (updated_at);

-- What administrators, the CLI and the release step did. `actor_email` is kept
-- as text so a row still names its actor after the user is deleted. Never put
-- a secret in `details`: record which keys were set, not their values
-- (src/lib/apps/admin-audit.ts).
create table public.admin_audit_log (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references public.users(id) on delete set null,
  actor_email text        not null,
  -- Dotted verb: 'connector.configure', 'user.grant.add', 'app.activate'.
  action      text        not null,
  -- Text, not a foreign key: targets are connectors, apps, users and themes,
  -- and a row must not fail to write because its target was just deleted.
  target_type text,
  target_id   text,
  details     jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index idx_admin_audit_log_created
  on public.admin_audit_log (created_at desc);
create index idx_admin_audit_log_actor
  on public.admin_audit_log (actor_id, created_at desc);

-- ── Analytics and telemetry ─────────────────────────────────────────────────

-- One row per app page actually opened. No foreign key to apps, so opens stay
-- attributed after an app's data is deleted.
create table public.app_open_events (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  app_slug   text not null,
  created_at timestamptz not null default now()
);

create index idx_app_open_events_created_at on public.app_open_events(created_at);
create index idx_app_open_events_app_slug   on public.app_open_events(app_slug);
create index idx_app_open_events_user_id    on public.app_open_events(user_id);

-- One row per declared usage event of an app, connector call, service call,
-- MCP tool call or app route.
--
--   source_type/source_slug  what emitted it
--   caller_app_slug          for a connector, service or MCP event, the app
--                            that drove the call
--   outcome/error_category   how the call went, where the source reports it;
--                            the category is the connector error taxonomy
--
-- `user_id` is set null when the user is deleted, so the history stays.
create table public.telemetry_events (
  id              uuid primary key default gen_random_uuid(),
  source_type     text not null
    check (source_type in ('app', 'connector', 'service', 'mcp', 'route')),
  source_slug     text not null,
  caller_app_slug text,
  event_name      text not null,
  user_id         uuid references public.users(id) on delete set null,
  outcome         text check (outcome in ('ok', 'error')),
  error_category  text,
  properties      jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index idx_telemetry_events_source
  on public.telemetry_events(source_type, source_slug, created_at);
create index idx_telemetry_events_caller_app
  on public.telemetry_events(caller_app_slug);
create index idx_telemetry_events_user_id
  on public.telemetry_events(user_id);
create index idx_telemetry_events_created_at
  on public.telemetry_events(created_at);

-- Route rows are by far the most numerous, and the cron tick prunes them
-- (pruneRouteTelemetry in src/lib/apps/telemetry.ts). Partial, so it costs the
-- other inserts nothing.
create index idx_telemetry_events_route_created
  on public.telemetry_events (created_at)
  where source_type = 'route';

-- ── MCP server: OAuth 2.1 authorization-server storage ──────────────────────
--
-- MixOS is the authorization server an MCP client is authorized against, by a
-- signed-in user, for the apps that user ticks. Codes and tokens are stored as
-- HMAC-SHA256 digests under MCP_TOKEN_KEY, never in the clear. `granted_apps`
-- is the user's consent: a ceiling, with hasAppGrant() checked live on every
-- call. Clients are public, with PKCE S256 as the proof of possession.

-- Open dynamic client registration (RFC 7591). Registering grants nothing.
create table public.oauth_clients (
  client_id     text primary key,
  client_name   text not null,
  -- Exact-match allowlist. Any other redirect_uri is an error shown on MixOS,
  -- never a redirect.
  redirect_uris text[] not null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);

create index idx_oauth_clients_last_used
  on public.oauth_clients(last_used_at);

-- Single use, a 60-second lifetime, bound to a PKCE challenge and an exact
-- redirect_uri. `consumed_at` is set on the first exchange, so a replay is
-- refused, and seen.
create table public.oauth_authorization_codes (
  code_hash      text primary key,
  client_id      text not null references public.oauth_clients(client_id) on delete cascade,
  user_id        uuid not null references public.users(id) on delete cascade,
  redirect_uri   text not null,
  -- The S256 challenge. The verifier is never stored.
  code_challenge text not null,
  granted_apps   text[] not null default '{}',
  expires_at     timestamptz not null,
  consumed_at    timestamptz,
  created_at     timestamptz not null default now()
);

create index idx_oauth_codes_expires_at
  on public.oauth_authorization_codes(expires_at);

-- Opaque, so revoking is one write that takes effect on the next request.
-- `granted_apps` is carried across refresh-token rotation, never widened.
create table public.oauth_tokens (
  id           uuid primary key default gen_random_uuid(),
  token_hash   text not null unique,
  token_type   text not null check (token_type in ('access', 'refresh')),
  client_id    text not null references public.oauth_clients(client_id) on delete cascade,
  user_id      uuid not null references public.users(id) on delete cascade,
  granted_apps text[] not null default '{}',
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);

create index idx_oauth_tokens_user_client
  on public.oauth_tokens(user_id, client_id);
create index idx_oauth_tokens_expires_at
  on public.oauth_tokens(expires_at);

-- ── Row-level security ──────────────────────────────────────────────────────
-- On for every ordinary table in `public`, found from the catalog rather than
-- named, so a table can't miss it by not being listed. Tables an extension owns
-- are left alone. The release step runs the same sweep over `public` and every
-- app schema after app migrations (scripts/app-migrations.ts).
do $$
declare t record;
begin
  for t in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and not c.relrowsecurity
      and not exists (
        select 1
        from pg_depend d
        where d.objid = c.oid
          and d.deptype = 'e'
      )
  loop
    execute format('alter table public.%I enable row level security', t.relname);
  end loop;
end
$$;

-- ── Functions ───────────────────────────────────────────────────────────────
--
-- `anon`, `authenticated` and `service_role` are Supabase's API roles, and
-- PostgREST publishes functions in `public` to the first two. Each function's
-- EXECUTE is revoked from PUBLIC and from those roles where they exist, and
-- granted to `service_role` where it exists. On a plain Postgres there is no
-- API to publish through, and the owner, the role MixOS connects as, keeps
-- EXECUTE either way.

-- The admin app-database viewer (src/lib/apps/admin-actions.ts): the columns of
-- the tables in the given app schemas, with nullability, defaults and keys.
-- Keys come from pg_catalog because `unnest(conkey, confkey) with ordinality`
-- pairs a composite foreign key's columns by position, which information_schema
-- can't. `security invoker`, and search_path pinned so a caller can't redirect
-- the body.
create function public.get_app_schema(app_schemas text[])
returns table (
  table_schema     text,
  table_name       text,
  column_name      text,
  data_type        text,
  ordinal_position int,
  is_nullable      boolean,
  column_default   text,
  is_primary_key   boolean,
  foreign_schema   text,
  foreign_table    text,
  foreign_column   text
)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with
  pk as (
    select ns.nspname::text as sch, rel.relname::text as tbl, att.attname::text as col
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    join lateral unnest(con.conkey) as k(attnum) on true
    join pg_attribute att
      on att.attrelid = con.conrelid and att.attnum = k.attnum
    where con.contype = 'p'
      and ns.nspname = any(app_schemas)
  ),
  fk as (
    select
      ns.nspname::text   as sch,
      rel.relname::text  as tbl,
      att.attname::text  as col,
      fns.nspname::text  as fsch,
      fref.relname::text as ftbl,
      fatt.attname::text as fcol
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    join lateral unnest(con.conkey, con.confkey)
      with ordinality as k(attnum, fattnum, ord) on true
    join pg_attribute att
      on att.attrelid = con.conrelid and att.attnum = k.attnum
    join pg_class fref on fref.oid = con.confrelid
    join pg_namespace fns on fns.oid = fref.relnamespace
    join pg_attribute fatt
      on fatt.attrelid = con.confrelid and fatt.attnum = k.fattnum
    where con.contype = 'f'
      and ns.nspname = any(app_schemas)
  )
  select
    c.table_schema::text,
    c.table_name::text,
    c.column_name::text,
    c.data_type::text,
    c.ordinal_position::int,
    (c.is_nullable = 'YES'),
    c.column_default::text,
    (pk.col is not null),
    fk.fsch,
    fk.ftbl,
    fk.fcol
  from information_schema.columns c
  left join pk
    on pk.sch = c.table_schema and pk.tbl = c.table_name and pk.col = c.column_name
  left join fk
    on fk.sch = c.table_schema and fk.tbl = c.table_name and fk.col = c.column_name
  where c.table_schema = any(app_schemas)
  order by c.table_schema, c.table_name, c.ordinal_position
$$;

-- Ends every session a person has: the atomic increment of session_version
-- that src/lib/auth/revocation.ts calls. `set x = x + 1` runs against the
-- locked row, so two revocations at once both count.
create function public.bump_session_version(p_user_id uuid)
returns integer
language sql
security invoker
as $$
  update public.users
  set session_version = session_version + 1,
      updated_at = now()
  where id = p_user_id
  returning session_version;
$$;

-- The BEFORE UPDATE trigger the release step installs on an app table for each
-- column the app lists under `updatedAt`, named in the trigger's argument. App
-- migrations may not create triggers (scripts/app-sql-policy.ts), so the
-- platform provides this one. It sets that column to now() through
-- jsonb_populate_record, which converts to the column's type, and reads nothing
-- else.
create function public.mixos_touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  new := jsonb_populate_record(new, jsonb_build_object(tg_argv[0], now()));
  return new;
end
$$;

revoke all on function public.get_app_schema(text[]) from public;
revoke all on function public.bump_session_version(uuid) from public;
-- Nobody calls the trigger function directly: Postgres checks EXECUTE when a
-- trigger is created, which only its owner does, not when it fires.
revoke all on function public.mixos_touch_updated_at() from public;
do $$
declare
  api_role text;
begin
  foreach api_role in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = api_role) then
      execute format('revoke all on function public.get_app_schema(text[]) from %I', api_role);
      execute format('revoke all on function public.bump_session_version(uuid) from %I', api_role);
      execute format('revoke all on function public.mixos_touch_updated_at() from %I', api_role);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.get_app_schema(text[]) to service_role;
    grant execute on function public.bump_session_version(uuid) to service_role;
  end if;
end
$$;

-- ── Settings ────────────────────────────────────────────────────────────────

-- The scheduler starts on. An admin's Stop tick sets it to 'false'.
insert into public.platform_settings (key, value)
values ('scheduler_enabled', 'true')
on conflict (key) do nothing;

-- The schema version this file brings the database to. The build expects the
-- highest-numbered file in this directory, and readiness and the proxy compare
-- the two (src/lib/platform/schema-version.ts). A fact about the schema, so it
-- is set, not defaulted.
insert into public.platform_settings (key, value)
values ('platform_schema_version', '1')
on conflict (key) do update
  set value = excluded.value,
      updated_at = now();
