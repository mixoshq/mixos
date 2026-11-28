-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at https://mozilla.org/MPL/2.0/.

-- ============================================================================
-- Approving capabilities, not just apps (src/lib/apps/capability-approvals.ts).
--
--   app_capability_approvals   What an admin approved an app to ask for, as
--                              the set src/lib/apps/capabilities.ts reads from
--                              its manifest: written when they activate it,
--                              and when they approve what it newly asks for.
--   apps.capabilities_pending_since
--                              Set by the release step when the app asks for
--                              something not on that list. A Registry app is
--                              also switched off until an admin approves it; a
--                              local app is flagged and stays on.
--   app_capability_denials     The capabilities an admin turned off while the
--                              app runs: a host, an optional connector, a
--                              consumed service, notifications. Each one the
--                              app already handles the absence of.
--   connector_app_access.expired_at
--                              When the cron tick took an app's unused write
--                              access away (90 days with no successful write),
--                              as 7a's "Can't change data". One click puts it
--                              back.
--
-- Local apps get their current set as approved the first time the release
-- step sees them, so nothing switches off on upgrade; Registry apps get none
-- (there were none installed: no grandfathering). Deleted with the app's row,
-- moved by a rename, deleted when a different extension takes the slug.
-- ============================================================================

create table public.app_capability_approvals (
  app_slug    text not null references public.apps(slug) on delete cascade,
  kind        text not null,
  capability  text not null default '',
  approved_by uuid references public.users(id) on delete set null,
  approved_at timestamptz not null default now(),
  primary key (app_slug, kind, capability)
);

alter table public.app_capability_approvals enable row level security;

create table public.app_capability_denials (
  app_slug   text not null references public.apps(slug) on delete cascade,
  kind       text not null check (kind in ('egress', 'optional-connector', 'consumes', 'notifications')),
  capability text not null default '',
  denied_by  uuid references public.users(id) on delete set null,
  denied_at  timestamptz not null default now(),
  primary key (app_slug, kind, capability)
);

alter table public.app_capability_denials enable row level security;

alter table public.apps add column capabilities_pending_since timestamptz;

alter table public.connector_app_access add column expired_at timestamptz;

insert into public.platform_settings (key, value)
values ('platform_schema_version', '9')
on conflict (key) do update
  set value = excluded.value,
      updated_at = now();
