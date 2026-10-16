-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at https://mozilla.org/MPL/2.0/.

-- Same name, different extension.
--
-- Everything the platform keeps for an extension is keyed by its name: an
-- app's activation, grants, settings, API keys and tables by its slug, and a
-- connector's credentials and every user's connection to it by its name. Since
-- 0010 an app's row stays when the app leaves the build, so a different
-- extension that later takes the same name would find all of it waiting.
--
-- The release step now records where each extension in the build came from,
-- its identity (src/lib/repository/identity.ts): for one installed from a
-- Registry, the catalogue, its kind and slug, and its GitHub repository, from
-- its .registry.json; for anything else, 'local'. It compares at every release
-- step, so a version or commit change from the same repository is an update and
-- changes nothing, and anything else is a different extension:
--
--   apps.identity             What the last release step recorded. Null until
--                             one has: a row that activation wrote first.
--   apps.identity_changed_at  Set when a release step found a different
--                             extension under the slug. The app is switched off
--                             and its API keys revoked, and activating it again
--                             needs its slug typed, which clears this.
--   apps.replaced_identity    The identity it replaced, while that is pending.
--
-- A connector's is in platform_settings, as `connector.identity.<name>`, and a
-- theme's as `theme.identity.<slug>` (scripts/sync-identities.ts).
--
-- Every app already here was put here before installs kept a record, so it is
-- recorded as local, and so is each connector that holds credentials. An
-- existing local extension that is reinstalled from the Registry is then
-- caught once, at the first release step that carries the new one.

alter table public.apps
  add column if not exists identity text,
  add column if not exists identity_changed_at timestamptz,
  add column if not exists replaced_identity text;

update public.apps set identity = 'local' where identity is null;

insert into public.platform_settings (key, value)
select 'connector.identity.' || connector_name, 'local'
from (
  select connector_name from public.connector_configs
  union
  select connector_name from public.user_connector_oauth
) as configured
on conflict (key) do nothing;

-- The schema version this file brings the database to. See 0007 and OS-UPDATES.md.
insert into public.platform_settings (key, value)
values ('platform_schema_version', '11')
on conflict (key) do update
  set value = excluded.value,
      updated_at = now();
