-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at https://mozilla.org/MPL/2.0/.

-- ============================================================================
-- Connector calls are pruned: kept for MIXOS_CONNECTOR_TELEMETRY_DAYS, 90
-- unless set, and all of them for 0 (src/lib/apps/telemetry-retention.ts).
-- Until this migration they were kept forever.
--
-- What the cron tick's prune reads (pruneConnectorTelemetry in
-- src/lib/apps/telemetry.ts): connector rows by age. Partial, like the route
-- and egress ones (0001, 0007), so it costs the other inserts nothing.
-- ============================================================================

create index idx_telemetry_events_connector_created
  on public.telemetry_events (created_at)
  where source_type = 'connector';

insert into public.platform_settings (key, value)
values ('platform_schema_version', '10')
on conflict (key) do update
  set value = excluded.value,
      updated_at = now();
