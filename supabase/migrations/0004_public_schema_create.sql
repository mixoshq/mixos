-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at https://mozilla.org/MPL/2.0/.

-- ============================================================================
-- No role creates tables in `public` just by existing.
--
-- Before Postgres 15, PUBLIC (every role) holds CREATE on the `public` schema,
-- so each app's role, mixos_app_<slug>, could create tables there. An app's role
-- should own its own schema and nothing else (scripts/app-migrations.ts). This
-- takes the grant away where the login running it may: where it owns `public`,
-- or is a member of the role that does, as a superuser is. Elsewhere only the
-- owner can, and the release step says so on every run
-- (warnPublicCreate in scripts/app-migrations.ts).
--
-- The platform's own tables are unaffected: the role that owns `public` creates
-- them, and an owner needs no grant. On Postgres 15 and later, where PUBLIC
-- holds no CREATE there to begin with, this does nothing.
-- ============================================================================

do $$
begin
  if has_schema_privilege('public', 'public', 'CREATE')
     and pg_has_role(current_user, (select nspowner from pg_namespace where nspname = 'public'), 'USAGE')
  then
    revoke create on schema public from public;
  end if;
end
$$;

insert into public.platform_settings (key, value)
values ('platform_schema_version', '4')
on conflict (key) do update
  set value = excluded.value,
      updated_at = now();
