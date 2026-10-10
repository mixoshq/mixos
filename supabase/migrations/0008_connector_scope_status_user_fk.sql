-- Point connector_scope_status.user_id at the platform's own users table.
--
-- 0002 declared the column as `references auth.users(id)`. That is Supabase
-- Auth's table, and MixOS does not use Supabase Auth: identity is NextAuth, and
-- every person is a row in public.users (0001). auth.users stays empty, so every
-- per-user snapshot — a `userScoped` connector's grant, written at the OAuth
-- callback with the signed-in user's id — violated the foreign key. The callback
-- catches and logs that failure on purpose (a reporting write must not fail an
-- authorization), so the only symptom was a scope tab that never filled in for
-- user-scoped connectors. Tenant-wide rows carry a null user_id and were never
-- affected.
--
-- It was also the platform schema's only reference into a Supabase-owned
-- schema, which stopped 0002 applying to a plain Postgres at all. 0002 now
-- names public.users itself, so a new database is right from the start; this
-- file repairs every database that ran the old 0002, and is a no-op re-creation
-- of the same constraint on one that did not.

-- Anything already in the table under a user_id that is not a MixOS user can
-- only have come from an auth.users row, and would block the new constraint.
-- A snapshot is rewritten in full at the next token exchange, so dropping one
-- loses nothing that reconnecting does not restore.
delete from public.connector_scope_status s
 where s.user_id is not null
   and not exists (select 1 from public.users u where u.id = s.user_id);

-- The name Postgres gave the inline `references` in 0002. Reused for the
-- replacement, so the constraint is called the same thing on every database.
alter table public.connector_scope_status
  drop constraint if exists connector_scope_status_user_id_fkey;

alter table public.connector_scope_status
  add constraint connector_scope_status_user_id_fkey
  foreign key (user_id) references public.users(id) on delete cascade;

-- The schema version this file brings the database to. See 0007 and OS-UPDATES.md.
insert into public.platform_settings (key, value)
values ('platform_schema_version', '8')
on conflict (key) do update
  set value = excluded.value,
      updated_at = now();
