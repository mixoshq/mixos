-- ============================================================================
-- MixOS — consolidated platform schema.
--
-- Squashed baseline replacing the previous 13 files in db/migrations/. This is
-- the whole platform schema in one transaction-friendly file; every ALTER from
-- the old 002-013 has been folded into its CREATE TABLE.
--
-- Applied with the Supabase CLI:  npm run db:push
--
-- ── Authorization model ────────────────────────────────────────────────────
-- The application connects with the SERVICE ROLE key and enforces every
-- authorization decision in application code (src/lib/apps/access.ts,
-- src/lib/connectors/config.ts, src/lib/mcp/). There are no per-user database
-- roles and no policies that grant anything.
--
-- RLS is nevertheless ENABLED on every table below, with ZERO policies. On
-- Supabase this is load-bearing, not decorative: PostgREST publishes the
-- `public` schema to the `anon` and `authenticated` roles, so a table with RLS
-- switched off is world-readable to anyone holding the (publishable) anon key.
-- Enabled + no policies = deny-all for those roles. The service role bypasses
-- RLS entirely, so the application is unaffected.
--
-- The practical rule: any table added here MUST also get
-- `enable row level security`. Adding a policy is what would open it up.
-- ============================================================================

-- ── Identity ────────────────────────────────────────────────────────────────

-- Users synced from OIDC SSO or created via email/password credentials.
create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  sso_id text unique,
  email text unique not null,
  display_name text not null,
  is_admin boolean not null default false,
  password_hash text,
  onboarding_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Singleton auth configuration: OIDC SSO + admin claim mapping.
-- oidc_client_secret_encrypted is AES-256-GCM via CONNECTOR_ENCRYPTION_KEY.
create table if not exists public.auth_config (
  id int primary key default 1 check (id = 1),
  sso_enabled boolean not null default false,
  oidc_issuer_url text,
  oidc_client_id text,
  oidc_client_secret_encrypted text,
  admin_claim_name text,
  admin_claim_values text[] not null default '{}',
  updated_by uuid references public.users(id),
  updated_at timestamptz not null default now()
);

insert into public.auth_config (id) values (1) on conflict (id) do nothing;

-- ── Apps ────────────────────────────────────────────────────────────────────

-- Registered apps (synced from app manifests).
create table if not exists public.apps (
  slug text primary key,
  name text not null,
  description text,
  icon text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Admin grants a user permission to install an app. `role` is meaningful only
-- within the declaring app; null resolves to the manifest's defaultRole at read
-- time, so apps with no roles never set it.
create table if not exists public.user_app_grants (
  user_id    uuid not null references public.users(id) on delete cascade,
  app_slug   text not null references public.apps(slug) on delete cascade,
  role       text,
  granted_at timestamptz not null default now(),
  granted_by uuid references public.users(id),
  primary key (user_id, app_slug)
);

create index if not exists idx_user_app_grants_user
  on public.user_app_grants(user_id);

-- The user has installed the app for themselves. Distinct from grants — the
-- revocation flow deletes the install row before the grant row (see
-- toggleUserGrant server action).
--
-- `position` drives menu-bar order. `pinned` decides whether an installed app
-- renders inline in the top bar (default true, preserving "install -> shows in
-- bar") or stays reachable only from the Apps dropdown.
create table if not exists public.user_apps (
  user_id      uuid not null references public.users(id) on delete cascade,
  app_slug     text not null references public.apps(slug) on delete cascade,
  position     integer not null default 0,
  pinned       boolean not null default true,
  installed_at timestamptz not null default now(),
  primary key (user_id, app_slug)
);

create index if not exists idx_user_apps_user          on public.user_apps(user_id);
create index if not exists idx_user_apps_user_position on public.user_apps(user_id, position);
create index if not exists idx_user_apps_user_pinned   on public.user_apps(user_id, pinned);

-- One shared password per app, set by an installer (admin). Unlocks every page
-- and API route in that app whose manifest declares `visibility: "password"`.
-- Absence of a row means "no password set", and any password-marked page MUST
-- fail closed in that case (the public page route returns 503 rather than
-- rendering). Storage is a bcrypt hash only.
create table if not exists public.app_passwords (
  app_slug       text primary key references public.apps(slug) on delete cascade,
  password_hash  text not null,
  set_by_user_id uuid references public.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ── Dashboard ───────────────────────────────────────────────────────────────

-- Per-user dashboard layout (react-grid-layout positions).
create table if not exists public.dashboard_layouts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  layout     jsonb not null default '[]',
  updated_at timestamptz not null default now(),
  unique (user_id)
);

-- Widget instances with per-instance config.
create table if not exists public.dashboard_widgets (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  app_slug   text not null references public.apps(slug) on delete cascade,
  widget_id  text not null,
  config     jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists idx_dashboard_widgets_user
  on public.dashboard_widgets(user_id);

-- ── Connectors ──────────────────────────────────────────────────────────────

-- Connector configurations (org-wide, one row per connector).
-- encrypted_credentials is AES-256-GCM via CONNECTOR_ENCRYPTION_KEY.
--
-- Connectors authenticate with statically configured credentials (API keys,
-- tokens, service accounts). The former per-user OAuth flow — and its
-- `user_connector_oauth` table — has been removed.
create table if not exists public.connector_configs (
  connector_name       text primary key,
  encrypted_credentials text not null,
  configured_by        uuid references public.users(id),
  configured_at        timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- ── Notifications ───────────────────────────────────────────────────────────

-- Web Push subscriptions. One row per browser push endpoint, owned by a user.
-- Subscriptions are platform-wide: a user enables notifications once and any
-- app they can access may push via context.notifications.send().
--
-- p256dh/auth are the subscription's public key material — only usable together
-- with the server-held VAPID private key, so not a standalone secret. endpoint
-- is globally unique: a re-subscribe upserts and reassigns the owning user.
create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_push_subscriptions_user
  on public.push_subscriptions(user_id);

-- ── Scheduler ───────────────────────────────────────────────────────────────

-- One row per declared (app, job), reconciled from the app registry on each
-- tick. `running_since` is the cross-invocation lock: a job is claimed with an
-- atomic UPDATE ... WHERE next_run_at <= now() AND running_since IS NULL, so
-- two overlapping cron invocations can never double-run it.
--
-- Cadence is exactly one of `interval_minutes` or `cron` (+ optional IANA
-- `timezone`, default UTC). CRON can't be evaluated in Postgres, so the next
-- fire time is computed in JS and materialized into `next_run_at`, keeping the
-- due-check a single comparison inside the claim. NULL next_run_at = due now.
create table if not exists public.app_scheduled_jobs (
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
  -- `<>` on two IS NOT NULL booleans is a boolean XOR: exactly one cadence.
  constraint app_scheduled_jobs_cadence_ck
    check ((interval_minutes is not null) <> (cron is not null))
);

-- Append-only run history for the admin page / observability. `trigger` records
-- who kicked a run off: the recurring scheduler or an admin "Run now".
create table if not exists public.app_job_runs (
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

create index if not exists idx_app_job_runs_lookup
  on public.app_job_runs (app_slug, job_name, started_at desc);

-- Platform-wide key/value settings. First key is `scheduler_enabled`: a durable
-- global on/off switch checked by runDueJobs(), so pausing survives restarts
-- and applies to every cron invocation. Explicit "Run now" ignores this flag.
create table if not exists public.platform_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

insert into public.platform_settings (key, value)
values ('scheduler_enabled', 'true')
on conflict (key) do nothing;

-- ── Analytics & telemetry ───────────────────────────────────────────────────

-- One row per full app-page open, recorded by a client-side beacon that fires
-- when an app page actually mounts (so prefetches / server re-renders don't
-- inflate counts). Backs the admin Analytics page.
--
-- Intentionally no FK to public.apps(slug): opens stay attributed even if an
-- app is later deregistered.
create table if not exists public.app_open_events (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  app_slug   text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_app_open_events_created_at on public.app_open_events(created_at);
create index if not exists idx_app_open_events_app_slug   on public.app_open_events(app_slug);
create index if not exists idx_app_open_events_user_id    on public.app_open_events(user_id);

-- Generic telemetry — one row per developer-declared "key usage" of an app,
-- connector, cross-app service, or MCP tool call.
--
--   source_type/source_slug : what emitted the event
--   caller_app_slug         : for connector/service/mcp events, the app that
--                             drove the call. Null for plain app events.
--   event_name              : declared event name, or method/tool name
--   properties              : optional low-cardinality dimensions bag
--
-- user_id is nullable and ON DELETE SET NULL — system/job and public-surface
-- events have no user, and deleting a user must not delete event history.
create table if not exists public.telemetry_events (
  id              uuid primary key default gen_random_uuid(),
  source_type     text not null
    check (source_type in ('app', 'connector', 'service', 'mcp')),
  source_slug     text not null,
  caller_app_slug text,
  event_name      text not null,
  user_id         uuid references public.users(id) on delete set null,
  properties      jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists idx_telemetry_events_source
  on public.telemetry_events(source_type, source_slug, created_at);
create index if not exists idx_telemetry_events_caller_app
  on public.telemetry_events(caller_app_slug);
create index if not exists idx_telemetry_events_user_id
  on public.telemetry_events(user_id);
create index if not exists idx_telemetry_events_created_at
  on public.telemetry_events(created_at);

-- ── MCP server: OAuth 2.1 authorization-server storage ──────────────────────
--
-- These make MixOS an authorization *server*, so an MCP client (claude.ai, Claude
-- Desktop, Claude Code) can be authorized once, by a logged-in MixOS user, to
-- read data from the apps that user explicitly ticks.
--
-- Security properties the schema encodes:
--   - Codes and tokens are stored as HMAC-SHA256 digests, never in the clear.
--     A DB leak alone yields nothing replayable (the HMAC key derives from
--     CONNECTOR_ENCRYPTION_KEY, which is an env secret, not a table).
--   - `granted_apps` is the user's per-app consent, carried from the consent
--     screen onto the code and then onto every token minted from it. It is a
--     CEILING, not a grant: the MCP server still re-checks hasAppGrant() live
--     on every tools/list and tools/call.
--   - Clients are public (no client_secret column) — PKCE S256 is the proof of
--     possession, per OAuth 2.1 for native/browser clients.

-- Open dynamic client registration (RFC 7591). Anyone may register; that is
-- deliberate and is what makes the zero-config "Add custom connector" flow
-- work. Registration grants nothing — no data moves until a MixOS user completes
-- the consent screen. The route rate-limits it.
create table if not exists public.oauth_clients (
  client_id     text primary key,
  client_name   text not null,
  -- Exact-match allowlist. A redirect_uri not in this array is rejected with an
  -- error rendered ON MixOS — never by redirecting (open-redirect hygiene).
  redirect_uris text[] not null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);

create index if not exists idx_oauth_clients_last_used
  on public.oauth_clients(last_used_at);

-- Single-use, 60s TTL, bound to a PKCE challenge and an exact redirect_uri.
-- `consumed_at` is set on first exchange; a replay finds a consumed row and is
-- rejected with invalid_grant (rather than deleting, so replays stay detectable).
create table if not exists public.oauth_authorization_codes (
  code_hash      text primary key,
  client_id      text not null references public.oauth_clients(client_id) on delete cascade,
  user_id        uuid not null references public.users(id) on delete cascade,
  redirect_uri   text not null,
  -- PKCE S256 challenge. The verifier is never stored.
  code_challenge text not null,
  granted_apps   text[] not null default '{}',
  expires_at     timestamptz not null,
  consumed_at    timestamptz,
  created_at     timestamptz not null default now()
);

create index if not exists idx_oauth_codes_expires_at
  on public.oauth_authorization_codes(expires_at);

-- Opaque (not JWT) so revocation is a single DB write that takes effect on the
-- very next request. `granted_apps` is copied forward from the code and carried
-- across refresh-token rotation, so consent survives a refresh but is never
-- silently widened.
create table if not exists public.oauth_tokens (
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

create index if not exists idx_oauth_tokens_user_client
  on public.oauth_tokens(user_id, client_id);
create index if not exists idx_oauth_tokens_expires_at
  on public.oauth_tokens(expires_at);

-- ── Per-app migration ledger ────────────────────────────────────────────────
-- Tracks migrations applied from apps/<slug>/migrations/ by
-- `npm run migrate:apps` (scripts/migrate.ts). The platform's own schema is
-- managed by the Supabase CLI and is NOT recorded here.
create table if not exists public._migrations (
  id             serial primary key,
  app_slug       text not null,
  migration_file text not null,
  applied_at     timestamptz not null default now(),
  unique (app_slug, migration_file)
);

-- ── Row-Level Security ──────────────────────────────────────────────────────
-- Enable on every table, define no policies. See the header: this is what keeps
-- PostgREST's anon/authenticated surface closed. The service role, which is how
-- the application connects, bypasses RLS and is unaffected.
do $$
declare t text;
begin
  foreach t in array array[
    'users', 'auth_config', 'apps', 'user_app_grants', 'user_apps',
    'app_passwords', 'dashboard_layouts', 'dashboard_widgets',
    'connector_configs', 'push_subscriptions', 'app_scheduled_jobs',
    'app_job_runs', 'platform_settings', 'app_open_events',
    'telemetry_events', 'oauth_clients', 'oauth_authorization_codes',
    'oauth_tokens', '_migrations'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end
$$;

-- ── RPC: app schema introspection ───────────────────────────────────────────
-- Backs the admin "app database" viewer (src/lib/apps/admin-actions.ts), which
-- lists the tables and columns an app owns. Called via supabase.rpc().
--
-- SECURITY: PostgREST publishes functions in the `public` schema to `anon` and
-- `authenticated` by default, and this one enumerates schema metadata. EXECUTE
-- is therefore revoked from those roles and granted only to `service_role` —
-- the role the application actually connects as. Enabling RLS on tables does
-- NOT protect a function; the grant is the only thing that does.
create or replace function public.get_app_schema(prefix text)
returns table (
  table_name       text,
  column_name      text,
  data_type        text,
  ordinal_position int
)
language sql
stable
security invoker
-- Pin search_path so the body can't be redirected by a caller-set path.
set search_path = pg_catalog, public
as $$
  select
    c.table_name::text,
    c.column_name::text,
    c.data_type::text,
    c.ordinal_position::int
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name like prefix || '%'
  order by c.table_name, c.ordinal_position
$$;

revoke all on function public.get_app_schema(text) from public, anon, authenticated;
grant execute on function public.get_app_schema(text) to service_role;
