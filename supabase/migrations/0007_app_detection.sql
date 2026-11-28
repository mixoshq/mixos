-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at https://mozilla.org/MPL/2.0/.

-- ============================================================================
-- Per-app detection (src/lib/apps/detection.ts).
--
-- What an app does beyond what it usually does, raised for an admin to look
-- at: a first call to a method that changes data, a first contact with a host
-- its egress reaches only by a wildcard, any call the platform refused, and a
-- spike in volume. A record, not a gate: nothing here switches an app off.
--
--   telemetry_events  gains `egress` rows (one per context.http hop, the host
--                     in source_slug, the app in caller_app_slug) and the
--                     `refused` outcome (a call the facade, a route's budget,
--                     a disabled connector or the egress check refused).
--   app_activity_seen what each app has been seen doing, so a first is a
--                     first: a connector method or a host, capped per app.
--   app_anomalies     what the detector raised, one row per app, kind and
--                     subject, until an admin marks it as expected.
--
-- Egress rows are pruned at 90 days, and anomalies an admin marked as expected
-- at 180; connector rows stay as they are, kept. Both tables are deleted with
-- the app's row, moved by a rename, and deleted by the release step when a
-- different extension takes the slug.
-- ============================================================================

alter table public.telemetry_events drop constraint telemetry_events_source_type_check;
alter table public.telemetry_events
  add constraint telemetry_events_source_type_check
  check (source_type in ('app', 'connector', 'service', 'mcp', 'route', 'egress'));

alter table public.telemetry_events drop constraint telemetry_events_outcome_check;
alter table public.telemetry_events
  add constraint telemetry_events_outcome_check
  check (outcome in ('ok', 'error', 'refused'));

-- What the detector reads: one app's connector and egress rows, in a window.
create index idx_telemetry_events_app_activity
  on public.telemetry_events (caller_app_slug, created_at)
  where source_type in ('connector', 'egress');

-- What it prunes: egress rows past 90 days.
create index idx_telemetry_events_egress_created
  on public.telemetry_events (created_at)
  where source_type = 'egress';

create table public.app_activity_seen (
  app_slug      text not null references public.apps(slug) on delete cascade,
  kind          text not null check (kind in ('connector-method', 'egress-host')),
  -- "<connector>.<method>" or a host.
  subject       text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  primary key (app_slug, kind, subject)
);

alter table public.app_activity_seen enable row level security;

create table public.app_anomalies (
  id              uuid primary key default gen_random_uuid(),
  app_slug        text not null references public.apps(slug) on delete cascade,
  kind            text not null
    check (kind in ('new-write', 'new-host', 'refused', 'spike', 'too-many-subjects')),
  subject         text not null,
  detail          jsonb not null default '{}'::jsonb,
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  count           integer not null default 1,
  acknowledged_by uuid references public.users(id) on delete set null,
  acknowledged_at timestamptz,
  unique (app_slug, kind, subject)
);

create index idx_app_anomalies_open
  on public.app_anomalies (app_slug)
  where acknowledged_at is null;

alter table public.app_anomalies enable row level security;

insert into public.platform_settings (key, value)
values ('platform_schema_version', '7')
on conflict (key) do update
  set value = excluded.value,
      updated_at = now();
