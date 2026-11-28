-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at https://mozilla.org/MPL/2.0/.

-- ============================================================================
-- An admin's narrowing of one app's reach on one connector
-- (src/lib/connectors/app-access.ts).
--
-- What an app may call on a connector is set by its manifest (its declared
-- methods, and writes only when its entry asks for "write") and by the
-- connector's admin (Allow changes). This is a third key, below both, held by
-- an admin of this install, per app:
--
--   writes   'deny' takes the app's writes away even when its entry asks for
--            them and changes are allowed. 'inherit' leaves them as the
--            other two keys decide.
--   methods  When set, the only methods the app may call, within what it
--            could reach anyway. Null leaves every one it could reach.
--
-- It only ever narrows. Enforced where the app is handed the connector, its
-- facade (src/lib/apps/connector-reach.ts); a row that can't be read leaves
-- the app reads only, as Allow changes does. No row is today's behaviour.
--
-- Deleted with the app's row and by Delete data for the connector, moved by a
-- rename, and deleted by the release step when a different extension takes
-- the app's slug: the limits were set for the extension before it.
-- ============================================================================

create table public.connector_app_access (
  connector_name text not null,
  app_slug       text not null references public.apps(slug) on delete cascade,
  writes         text not null default 'inherit' check (writes in ('inherit', 'deny')),
  methods        text[],
  set_by         uuid references public.users(id) on delete set null,
  set_at         timestamptz not null default now(),
  primary key (connector_name, app_slug)
);

create index idx_connector_app_access_app
  on public.connector_app_access (app_slug);

alter table public.connector_app_access enable row level security;

insert into public.platform_settings (key, value)
values ('platform_schema_version', '8')
on conflict (key) do update
  set value = excluded.value,
      updated_at = now();
