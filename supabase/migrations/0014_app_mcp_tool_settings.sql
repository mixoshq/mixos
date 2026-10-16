-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at https://mozilla.org/MPL/2.0/.

-- Per-tool MCP switches, set by an admin on the app's MCP tab.
--
-- Until now a tool was reachable as soon as a user consented to its app on the
-- MCP consent screen and still held a grant. An admin who wanted an app but not
-- one of its tools, or not its tools at all, had no lever short of switching
-- the app off. This is the lever.
--
-- ══ ABSENCE MEANS DISABLED ══════════════════════════════════════════════════
--
-- There is no row per tool until an admin flips one, and a missing row reads as
-- `enabled = false`. So every tool starts disabled: on a fresh install, on an
-- upgrade (including tools people were already calling), and on a tool that is
-- renamed in its manifest, which arrives as a new name. Failing closed on all
-- three is the point. The upgrade case is the breaking one, and WHATS-NEW.md
-- tells admins to enable the tools they want.
--
-- Keyed by (app_slug, tool_name) and hanging off `apps` by foreign key, like
-- the grants: an app that leaves the build keeps its switches with its row
-- (0010), and Delete data, which deletes the row, takes them with it
-- (src/lib/repository/delete-data.ts). A release step that finds a different
-- extension under the slug deletes them (0011, scripts/sync-app-registry.ts):
-- they were turned on for the tools of the one before it. A row for a tool the
-- manifest no longer declares is inert: nothing looks it up.
create table if not exists public.app_mcp_tool_settings (
  app_slug    text not null references public.apps(slug) on delete cascade,
  tool_name   text not null,
  enabled     boolean not null default false,
  updated_by  uuid references public.users(id) on delete set null,
  updated_at  timestamptz not null default now(),
  primary key (app_slug, tool_name)
);

-- Same rule as every other table: RLS on, no policies. 0001's catalog sweep has
-- already run by the time this file applies, so this migration enables it itself.
alter table public.app_mcp_tool_settings enable row level security;

-- The schema version this file brings the database to. See 0007 and OS-UPDATES.md.
insert into public.platform_settings (key, value)
values ('platform_schema_version', '14')
on conflict (key) do update
  set value = excluded.value,
      updated_at = now();
