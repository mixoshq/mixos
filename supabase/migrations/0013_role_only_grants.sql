-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at https://mozilla.org/MPL/2.0/.

-- A role on a global app is only a role.
--
-- A global app is held by everyone, so it needs no grants, but its users can
-- still be given a role, which is stored on a `user_app_grants` row. That row
-- looked exactly like a grant, and `hasAppGrant` counted it as one. While the
-- app was global that made no difference. Once its manifest stopped saying
-- `global`, everyone who had been given a role kept the app, with no grant
-- anybody had made.
--
--   user_app_grants.role_only  Whether the row records only a role: false for
--                              a grant, true for a role and nothing else, and
--                              null until that is decided. Every row before
--                              this file is null, and so is every row a build
--                              without this column writes, after a host rolls
--                              back to one. An undecided row is a grant when
--                              someone is recorded granting it: an admin in
--                              `granted_by`, the CLI in its own
--                              `user.grant.add` audit row, at `granted_at` or
--                              later. Setting a role records neither. Every
--                              release step decides the undecided rows of the
--                              apps its build carries, and every access check
--                              decides them the same way until one has
--                              (src/lib/apps/grant-rule.ts). A grant stays a
--                              grant whether or not the app is global.
--
--   apps.global                Whether the app was global at the last release
--                              step that carried it. Null until one has. It is
--                              how the next release step tells that an app
--                              stopped being global.
--
--   apps.needs_grants_since    When a release step found that people who had
--   apps.needs_grants_reason   the app lost it, and why: 'global-ended', the app
--                              stopped being global and someone who had it, by
--                              an install or a role, has no grant; or
--                              'roles-decided', rows from before were decided
--                              to be roles on an app that isn't global. Admin
--                              > Apps says the app needs grants, and why, until
--                              an admin grants it to someone or it is global
--                              again.
--
-- The index holds the audit rows the rule reads: the CLI's grants.

alter table public.user_app_grants
  add column if not exists role_only boolean;

alter table public.apps
  add column if not exists global boolean,
  add column if not exists needs_grants_since timestamptz,
  add column if not exists needs_grants_reason text
    check (needs_grants_reason in ('global-ended', 'roles-decided'));

create index if not exists idx_admin_audit_log_cli_grant_add
  on public.admin_audit_log (target_id, (details->>'appSlug'), created_at)
  where action = 'user.grant.add' and actor_id is null;

-- The schema version this file brings the database to. See 0007 and OS-UPDATES.md.
insert into public.platform_settings (key, value)
values ('platform_schema_version', '13')
on conflict (key) do update
  set value = excluded.value,
      updated_at = now();
