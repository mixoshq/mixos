-- Who did what, as an administrator.
--
-- Nothing recorded this. `telemetry_events` covers app routes, connector calls,
-- services and MCP tool calls — every path a NORMAL user takes — while the
-- privileged paths wrote no trace at all. "Who configured this connector", "who
-- granted this person access to that app", "who set the password on the public
-- page" were all unanswerable on a platform whose admins hold third-party
-- credentials.
--
-- WHY NOT telemetry_events. Two reasons, and the second is decisive:
--   1. Its prune is scoped to source_type = 'route', so audit rows would in fact
--      survive — but retention that depends on a WHERE clause somewhere else is
--      not a retention policy.
--   2. Its `user_id` is `on delete set null`. An audit trail that forgets who
--      acted the moment that person is deleted is not an audit trail. Here the
--      actor's email is denormalised into a plain text column that survives the
--      user row, and the FK is kept only to join live users.
--
-- NEVER PUT A SECRET IN `details`. The whole point of several of these actions
-- is that they carry credentials. Record WHICH keys were set, never their
-- values -- see recordAdminAction() in src/lib/apps/admin-audit.ts.
create table if not exists public.admin_audit_log (
  id          uuid primary key default gen_random_uuid(),
  -- Null once the actor's user row is deleted; actor_email still names them.
  actor_id    uuid references public.users(id) on delete set null,
  -- Denormalised on purpose. See the note above.
  actor_email text        not null,
  -- Dotted verb, e.g. 'connector.configure', 'user.grant.set', 'app.register'.
  action      text        not null,
  -- What it was done to. Text rather than a FK: targets span connectors (name),
  -- apps (slug), users (uuid) and themes (id), and an audit row must not fail to
  -- write because its target was deleted a moment earlier.
  target_type text,
  target_id   text,
  -- Non-secret context: which credential KEYS were set, old and new role, etc.
  details     jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

-- The two ways this gets read: a reverse-chronological feed, and "everything
-- this person did".
create index if not exists idx_admin_audit_log_created
  on public.admin_audit_log (created_at desc);
create index if not exists idx_admin_audit_log_actor
  on public.admin_audit_log (actor_id, created_at desc);

-- Same rule as every other table: RLS on, no policies. 0001's catalog sweep has
-- already run by the time this file applies, so this migration enables it itself.
alter table public.admin_audit_log enable row level security;

-- The schema version this file brings the database to. See 0007 and OS-UPDATES.md.
insert into public.platform_settings (key, value)
values ('platform_schema_version', '4')
on conflict (key) do update
  set value = excluded.value,
      updated_at = now();
