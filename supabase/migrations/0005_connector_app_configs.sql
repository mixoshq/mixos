-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at https://mozilla.org/MPL/2.0/.

-- ============================================================================
-- An app's own credentials for a connector (src/lib/connectors/app-config.ts).
--
-- A tenant connector has one credential set, in connector_configs, shared by
-- every app that declares it. An admin can give one app its own instead: a
-- narrower API key, or an OAuth grant of its own. A row here wins over the
-- shared row for that app, everywhere the app's code reaches the connector
-- (src/lib/apps/context.ts). It never falls back: a row that can't be read
-- leaves the app with the connector unconfigured, never with the broader
-- shared credential.
--
-- Encrypted with CONNECTOR_ENCRYPTION_KEY, as connector_configs is. Holds a
-- whole credential set, the client id and secret of an OAuth connector
-- included, so it is complete on its own. Webhooks, the admin switch and Allow
-- changes stay per connector. User-scoped connectors have none: each person's
-- grant is already their own.
--
-- Deleted with the app's row. Delete data deletes a connector's rows and an
-- app's (src/lib/repository/delete-data.ts), a rename moves them
-- (scripts/sync-renames.ts), and the release step deletes an app's when a
-- different extension arrives under its slug (scripts/sync-app-registry.ts):
-- a credential given to one extension never passes to another.
-- ============================================================================

create table public.connector_app_configs (
  connector_name        text not null,
  app_slug              text not null references public.apps(slug) on delete cascade,
  encrypted_credentials text not null,
  configured_by         uuid references public.users(id) on delete set null,
  configured_at         timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  last_verified_at      timestamptz,
  last_verified_detail  text,
  primary key (connector_name, app_slug)
);

create index idx_connector_app_configs_app
  on public.connector_app_configs (app_slug);

-- On, with no policies, as for every table in `public` (0001_platform_schema.sql).
alter table public.connector_app_configs enable row level security;

-- What the provider granted an app's own OAuth grant, beside the shared
-- grant's (user_id and app_slug null) and each person's (user_id set). A row
-- is one of the three, never two.
alter table public.connector_scope_status
  add column app_slug text references public.apps(slug) on delete cascade;

alter table public.connector_scope_status
  add constraint connector_scope_status_one_holder
  check (user_id is null or app_slug is null);

-- The shared grant's index, re-cut so an app's rows aren't counted as the
-- shared grant's, and one for the apps' rows.
drop index public.idx_connector_scope_status_tenant;

create unique index idx_connector_scope_status_tenant
  on public.connector_scope_status (connector_name, scope)
  where user_id is null and app_slug is null;

create unique index idx_connector_scope_status_app
  on public.connector_scope_status (connector_name, app_slug, scope)
  where app_slug is not null;

insert into public.platform_settings (key, value)
values ('platform_schema_version', '5')
on conflict (key) do update
  set value = excluded.value,
      updated_at = now();
