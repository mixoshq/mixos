-- The latest messages from the shared Gmail mailbox, with the action items
-- detected in each one.
--
-- This table IS the read path. Every route serves from here and never calls
-- Gmail: hydrating one page of messages costs one `messages.get` per message,
-- which is not something a page load can pay for (docs/apps/data-freshness.md).
-- The `sync/messages.ts` handler is the only writer.
--
-- Table name is bare on purpose — the platform prefixes it `_app_inbox_actions_`.
create table if not exists messages (
  id               text primary key,        -- Gmail message id
  thread_id        text not null,
  -- Ordering key. Nullable because Gmail omits `internalDate` on some messages;
  -- a null sorts last rather than pretending to be epoch 0.
  internal_date    timestamptz,
  from_name        text,
  from_email       text,
  subject          text,
  snippet          text,
  is_unread        boolean not null default false,
  has_attachments  boolean not null default false,

  -- Detection results. `action_count` is `integer`, never `numeric`: the driver
  -- hands numeric/decimal back as a STRING, which would fail the route's
  -- `z.number()` output on the way out (docs/apps/database.md).
  action_count     integer not null default 0,
  -- The matched sentences: [{ "kind": "request"|"assignment"|"question", "text": "...",
  -- "hasDeadline": bool }]. This is the evidence shown in the UI — a heuristic
  -- that hides what it matched is not one a reader can disagree with.
  actions          jsonb   not null default '[]'::jsonb,
  has_deadline     boolean not null default false,
  -- Which revision of lib/detect.ts produced the row above, so a rules change is
  -- visible in the data instead of silently mixed in with older detections.
  detector_version integer not null default 1,

  synced_at        timestamptz not null default now()
);

-- The list page orders by recency and the summary counts by action_count.
create index if not exists idx_messages_internal_date on messages (internal_date desc nulls last);
create index if not exists idx_messages_action_count on messages (action_count);
