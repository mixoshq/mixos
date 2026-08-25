-- Replay protection for inbound connector webhooks.
--
-- A verified signature proves a payload came from the provider; it does not
-- prove it is being delivered for the first time. Anyone who observes a
-- delivery can resend it verbatim and the signature still checks out, so the
-- signature itself is recorded and a repeat is refused.
--
-- The key is a digest of the signature, never the signature itself: the row is
-- a dedupe marker, and there is no reason for a live credential-adjacent value
-- to sit in a table that outlives the request.
create table if not exists public.connector_webhook_events (
  event_key      text primary key,
  connector_name text        not null,
  received_at    timestamptz not null default now()
);

-- Supports the cron sweep. Rows are only useful inside the signature's
-- freshness window; beyond that the timestamp check already rejects a replay.
create index if not exists connector_webhook_events_received_at_idx
  on public.connector_webhook_events (received_at);
