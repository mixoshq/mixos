/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WHICH `user_app_grants` ROWS ARE GRANTS.
 *
 * A row records a grant, a role, or both. A global app is held by everyone,
 * so a row on one may record nothing but a role, and a role is never access.
 * `role_only` says which a row is:
 *
 *   false  a grant: written by a grant path, with who granted it;
 *   true   a role and nothing else.
 *
 * The column is NOT NULL with no default (supabase/migrations/0001_platform_schema.sql),
 * so every path that writes a row says which it is, and one that leaves it out
 * fails on the insert rather than writing a row that reads as either.
 *
 * No imports: the release step uses this too.
 */

/** SQL over a `user_app_grants` row aliased `g`: it is a grant. */
export const IS_GRANT_SQL = `(g.role_only is false)`;
