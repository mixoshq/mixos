-- ============================================================================
-- MixOS — route-call telemetry.
--
-- The gateway records one row per app API request, the way it already records
-- one per MCP tool call: an app does not *choose* to be called, so an operator
-- should not have to opt in to seeing that it was.
--
-- Two changes, and the first is the load-bearing one. `source_type` carries a
-- CHECK constraint listing the values 0001 knew about, and every telemetry
-- writer swallows its errors by design — so without widening the constraint the
-- new recorder would fail silently on every request, forever, with no log line
-- and no row. Ship this before the recorder.
--
-- Applied with the Supabase CLI:  npm run db:push
-- ============================================================================

-- ── Widen the source discriminator ──────────────────────────────────────────

alter table public.telemetry_events
  drop constraint if exists telemetry_events_source_type_check;

alter table public.telemetry_events
  add constraint telemetry_events_source_type_check
  check (source_type in ('app', 'connector', 'service', 'mcp', 'route'));

-- ── Retention ───────────────────────────────────────────────────────────────

-- Route rows are orders of magnitude more numerous than every other source
-- combined — one per request rather than one per declared event — and nothing
-- has ever swept this table. The cron tick prunes them (pruneRouteTelemetry in
-- src/lib/apps/telemetry.ts); this index is what keeps that delete from being a
-- sequential scan over the whole history, including the rows it must NOT touch.
--
-- Deliberately partial: it indexes only route rows, so it costs nothing on the
-- 'app' / 'connector' / 'service' / 'mcp' inserts and stays small.
create index if not exists idx_telemetry_events_route_created
  on public.telemetry_events (created_at)
  where source_type = 'route';

-- telemetry_events already has RLS enabled (0001_initial.sql), and altering a
-- table does not change that. No new table here, so nothing further is needed.
