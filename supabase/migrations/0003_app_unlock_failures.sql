-- Brute-force state for app-password unlock attempts.
--
-- This lived in a per-process `Map`, which on a serverless deployment is close
-- to no control at all: every instance holds its own counter, so the effective
-- allowance is "5 failures per instance" across a fleet that scales with the
-- traffic being throttled. `src/lib/rate-limit.ts` makes exactly this argument
-- about the limiter it replaced — a control that reads as enforced and is not is
-- worse than an absent one — and the same reasoning applies here with more force,
-- because what is behind this gate is a password.
--
-- Keyed by `<ip>::<app_slug>` so one bad IP cannot lock everyone out of an app,
-- and one attacker cannot spread attempts across apps to stay under a threshold.
--
-- `failures` counts only WRONG passwords, not attempts: a correct password
-- clears the row. This is a lockout, not a token bucket, which is why it does
-- not reuse `rate_buckets` — that table charges every call and refills
-- continuously, and neither is the behaviour wanted here.
create table if not exists public.app_unlock_failures (
  -- "<ip>::<app_slug>". Double colon because an IPv6 address contains single
  -- ones and an app slug is [a-z0-9_-]+, so the boundary stays unambiguous.
  subject      text primary key,
  failures     int         not null default 0,
  -- Start of the current rolling window. Failures outside it start a new one.
  window_start timestamptz not null default now(),
  -- Non-null and in the future means locked. Null means counting.
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);

-- Supports the cron prune, which is a range scan over this column.
create index if not exists idx_app_unlock_failures_updated
  on public.app_unlock_failures (updated_at);

-- Same rule as every other table: RLS on, no policies, so PostgREST's
-- anon/authenticated surface stays closed and only the service role reads it.
-- 0001's catalog sweep has already run by the time this file applies, so a
-- migration that adds a table enables it here rather than relying on that sweep.
alter table public.app_unlock_failures enable row level security;

-- The schema version this file brings the database to. See 0007 and OS-UPDATES.md.
insert into public.platform_settings (key, value)
values ('platform_schema_version', '3')
on conflict (key) do update
  set value = excluded.value,
      updated_at = now();
