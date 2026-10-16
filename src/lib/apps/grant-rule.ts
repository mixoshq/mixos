/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WHICH `user_app_grants` ROWS ARE GRANTS.
 *
 * A row records a grant, a role, or both. A global app is held by everyone,
 * so a row on one may record nothing but a role, and a role is never access.
 * `role_only` says which a row is (migration 0013):
 *
 *   false  a grant: written by a grant path, or found to be one;
 *   true   a role and nothing else;
 *   null   not decided yet: written by a build that predates the column,
 *          before this change or after a host rolled back to one.
 *
 * An undecided row is a grant when it shows that someone granted it. Every
 * grant path records that: an admin's grant in `granted_by`, and the CLI's,
 * the smoke grant's and the pull-request check's, in the `user.grant.add`
 * audit row it writes after the row, with no admin and `via` "cli" or "ci".
 * Setting a role records neither. Only the CLI's own audit rows count: an
 * admin's grant always sets `granted_by`, so an admin's audit row alone is no
 * grant, whatever writes one later. And the audit row must be from the row's
 * `granted_at` or later: an older one is an earlier grant, since revoked.
 *
 * Every release step decides the undecided rows of the apps its build carries
 * (scripts/sync-app-registry.ts). Until one does, every check decides them
 * the same way, with the SQL below, so a row written while a host served an
 * older build is never access just because no release step has run since.
 *
 * No imports: the release step uses this too.
 */

/**
 * SQL over a `user_app_grants` row aliased `g`: someone is recorded granting
 * it. The audit rows it reads are the ones `idx_admin_audit_log_cli_grant_add`
 * (migration 0013) holds.
 */
export const GRANT_RECORDED_SQL = `(g.granted_by is not null or exists (
  select 1 from public.admin_audit_log l
   where l.action = 'user.grant.add'
     and l.actor_id is null
     and l.actor_email like 'cli:%'
     and l.details->>'via' in ('cli', 'ci')
     and l.target_type = 'user'
     and l.target_id = g.user_id::text
     and l.details->>'appSlug' = g.app_slug
     and l.created_at >= g.granted_at))`;

/** SQL over a row aliased `g`: it is a grant, decided or not. */
export const IS_GRANT_SQL = `(g.role_only is false or (g.role_only is null and ${GRANT_RECORDED_SQL}))`;
