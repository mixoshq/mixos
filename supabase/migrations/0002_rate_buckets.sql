-- ============================================================================
-- MixOS — shared rate-limit buckets.
--
-- The limiter in src/lib/rate-limit.ts was in-memory, which on a serverless
-- deployment means every function instance holds its own bucket. The documented
-- "60 burst / 10 per second" was therefore per-instance and, across a fleet that
-- scales with load, effectively unbounded — the control read as enforced and was
-- not. This table is the authority; the in-memory bucket is demoted to a
-- pre-filter in front of it.
--
-- The pre-filter is sound in exactly one direction. A per-instance bucket sees
-- only its share of the traffic, so it drains more slowly than the global one
-- and is therefore strictly MORE permissive: a memory DENIAL implies a global
-- denial and may short-circuit, while a memory ALLOW proves nothing and must
-- still consult this table. A cold instance starts full, so it can only ever be
-- too generous — it can never lock anyone out on its own.
--
-- Applied with the Supabase CLI:  npm run db:push
-- ============================================================================

-- ── Rate limiting ───────────────────────────────────────────────────────────

-- One row per (limiter, subject). `subject` carries the limiter's own name as a
-- `<name>::<identity>` prefix, so two limiters on the same axis with different
-- budgets (the app gateway at 60/10s and the OAuth token endpoint at 30/0.5s
-- both key by IP) cannot share a row and quietly drain each other.
--
-- `tokens` is double precision because refill is a continuous function of
-- elapsed time, and it is allowed to go to -1: preserving the deficit is what
-- stops a hammered bucket from resetting its accrual on every denial.
--
-- No surrogate id (the natural key is the identity, as in platform_settings)
-- and no secondary index: every request UPDATEs a row it just located by
-- primary key, and an extra index on a hot-updated table costs a HOT update
-- for nothing.
create table if not exists public.rate_buckets (
  scope       text not null
    check (scope in ('ip', 'user_app', 'route', 'api_key')),
  subject     text not null,
  tokens      double precision not null,
  last_refill timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (scope, subject)
);

-- Per the 0001 header: every table gets RLS enabled with zero policies, which
-- is what keeps PostgREST's anon/authenticated surface closed. The do-block in
-- 0001 iterates a hardcoded list and will never pick up a new table, so this
-- statement has to live here.
alter table public.rate_buckets enable row level security;
