-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at https://mozilla.org/MPL/2.0/.

-- ============================================================================
-- Each person's global search settings (src/lib/search/, /account/search).
--
-- No row is the defaults: the icon shown, the shortcut on, every source
-- searched, in the build's order. A row is written the first time the person
-- changes anything.
--
--   show_icon         The search icon in the menu bar.
--   shortcut_enabled  ⌘K / Ctrl+K. With this and show_icon both false, search
--                     is off for the person, and /api/search refuses.
--   source_order      Source keys, first searched first: an app's slug, or
--                     '@apps' for the Apps group (open an app by name). A
--                     source not listed goes after the listed ones, so an app
--                     installed later lands at the end.
--   disabled_sources  Source keys the person switched off. An app not listed
--                     is searched, so a new app is on until switched off.
--
-- A renamed app's slug is replaced in both arrays by the release step
-- (scripts/sync-renames.ts), and Delete data removes it
-- (src/lib/repository/delete-data.ts).
-- ============================================================================

create table public.user_search_preferences (
  user_id          uuid primary key references public.users(id) on delete cascade,
  show_icon        boolean not null default true,
  shortcut_enabled boolean not null default true,
  source_order     text[] not null default '{}',
  disabled_sources text[] not null default '{}',
  updated_at       timestamptz not null default now()
);

-- On, with no policies, as for every table in `public` (0001_platform_schema.sql).
alter table public.user_search_preferences enable row level security;

insert into public.platform_settings (key, value)
values ('platform_schema_version', '3')
on conflict (key) do update
  set value = excluded.value,
      updated_at = now();
