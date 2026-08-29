/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use server";

import { createServiceClient } from "@/lib/db/server";
import { appRegistry } from "@/generated/app-registry";
import { revalidatePath } from "next/cache";
import { requireReadOnlySession } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/apps/access";
import {
  clearAppPassword,
  getAppPasswordMetadata,
  setAppPassword,
} from "@/lib/apps/app-password-store";
import { recordAdminAction } from "@/lib/apps/admin-audit";
import { revokeUserSessions } from "@/lib/auth/revocation";

/**
 * How many users hold a grant for each app, keyed by slug.
 *
 * One query for the whole registry rather than one per app: the admin apps
 * page renders every app at once, so the per-app version is N round trips to
 * answer a question a single scan already answers. Apps with no grants are
 * absent from the map — callers read a missing key as 0.
 *
 * Says nothing about a `global` app, which every user holds implicitly and
 * which therefore has no rows here at all. Reporting that as "0 users" would
 * be exactly backwards, so the caller checks `global` first.
 */
export async function getAppGrantCounts(): Promise<Record<string, number>> {
  const session = await requireReadOnlySession();
  await requireAdmin(session);

  const supa = createServiceClient();
  const { data, error } = await supa.from("user_app_grants").select("app_slug");
  if (error) throw new Error(error.message);

  const counts: Record<string, number> = {};
  for (const row of (data ?? []) as { app_slug: string }[]) {
    counts[row.app_slug] = (counts[row.app_slug] ?? 0) + 1;
  }
  return counts;
}

/**
 * How many tables each app's scoped database actually holds, keyed by slug.
 *
 * One RPC for the whole registry, for the same reason as getAppGrantCounts:
 * the list renders every app at once. Apps with no tables are absent — callers
 * read a missing key as 0.
 *
 * Assignment is LONGEST PREFIX FIRST, not first match. Slugs `career` and
 * `career-extra` produce prefixes `_app_career_` and `_app_career_extra_`, and
 * every table of the second one also starts with the first — so a naive scan
 * would file the whole of `career-extra` under `career`.
 */
export async function getAppTableCounts(): Promise<Record<string, number>> {
  const session = await requireReadOnlySession();
  await requireAdmin(session);

  const supa = createServiceClient();
  const { data, error } = await supa.rpc("get_app_schema", { prefix: "_app_" });
  if (error) throw new Error(error.message);

  const prefixes = appRegistry
    .filter((a) => a.database)
    .map((a) => ({
      slug: a.slug,
      prefix: `_app_${a.slug.replace(/-/g, "_")}_`,
    }))
    .sort((a, b) => b.prefix.length - a.prefix.length);

  // The RPC filters with SQL LIKE, where `_` is a single-character wildcard —
  // so `_app_%` is a looser net than it looks. Re-checking with startsWith here
  // is an exact match, and the set collapses the one-row-per-column result to
  // one entry per table.
  const rows = (data ?? []) as { table_name: string }[];
  const counts: Record<string, number> = {};
  for (const table of new Set(rows.map((r) => r.table_name))) {
    const hit = prefixes.find((p) => table.startsWith(p.prefix));
    if (hit) counts[hit.slug] = (counts[hit.slug] ?? 0) + 1;
  }
  return counts;
}

export interface AppSchemaColumn {
  name: string;
  type: string;
  /** False means `not null` — the column must be given a value. */
  nullable: boolean;
  /** The literal `column_default` expression, or null if there is none. */
  default: string | null;
  primaryKey: boolean;
  /**
   * What this column references, with the app's table prefix already stripped
   * so it names the table the way the app's own migrations do. Null when the
   * column is not a foreign key, and null when it points outside the app —
   * `auth.users`, say — since that target is not one of the tables being
   * listed and a bare "users" would look like one.
   */
  references: { table: string; column: string } | null;
}

export interface AppSchemaTable {
  name: string;
  columns: AppSchemaColumn[];
}

export async function getAppSchema(slug: string): Promise<AppSchemaTable[]> {
  const session = await requireReadOnlySession();
  await requireAdmin(session);

  const supa = createServiceClient();
  const prefix = `_app_${slug.replace(/-/g, "_")}_`;
  const { data, error } = await supa.rpc("get_app_schema", { prefix });
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as {
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: boolean;
    column_default: string | null;
    is_primary_key: boolean;
    foreign_table: string | null;
    foreign_column: string | null;
  }[];

  const byTable = new Map<string, AppSchemaTable>();
  for (const r of rows) {
    // Strip prefix so the UI shows the bare table name the app uses.
    const bare = r.table_name.startsWith(prefix)
      ? r.table_name.slice(prefix.length)
      : r.table_name;
    let t = byTable.get(bare);
    if (!t) {
      t = { name: bare, columns: [] };
      byTable.set(bare, t);
    }
    t.columns.push({
      name: r.column_name,
      type: r.data_type,
      nullable: r.is_nullable,
      default: r.column_default,
      primaryKey: r.is_primary_key,
      references:
        r.foreign_table && r.foreign_column
          ? // Only references INTO this app. A column pointing at a platform
            // table is left null rather than rendered as a bare, prefix-less
            // name the reader would hunt for in the list above and never find.
            r.foreign_table.startsWith(prefix)
            ? {
                table: r.foreign_table.slice(prefix.length),
                column: r.foreign_column,
              }
            : null
          : null,
    });
  }
  return Array.from(byTable.values());
}

export interface AppPasswordStatus {
  /** True when an `app_passwords` row exists for this slug. */
  set: boolean;
  /** When the password was last updated. ISO-8601 string or null. */
  updatedAt: string | null;
}

/**
 * Returns whether the app currently has a password set, and when it was
 * last updated. The hash is never returned — admins can only set or clear
 * it, never read it back.
 */
export async function getAppPasswordStatus(
  slug: string,
): Promise<AppPasswordStatus> {
  const session = await requireReadOnlySession();
  await requireAdmin(session);

  const meta = await getAppPasswordMetadata(slug);
  return {
    set: !!meta,
    updatedAt: meta?.updated_at ?? null,
  };
}

/**
 * Set or rotate the app-wide unlock password. Refuses if the manifest has
 * no `"password"`-marked pages or API routes — there's no reason to set
 * one in that case and silently storing a hash would be confusing.
 *
 * Note: rotating the password does NOT proactively invalidate existing
 * unlock cookies (they're stateless signed tokens). Existing cookies
 * remain valid until their 24h expiry. If you need to revoke now, clear
 * the password (which forces fail-closed on next request) and then re-set.
 */
export async function setAppPasswordAction(
  slug: string,
  plaintext: string,
): Promise<void> {
  const session = await requireReadOnlySession();
  const dbUser = await requireAdmin(session);

  const manifest = appRegistry.find((a) => a.slug === slug);
  if (!manifest) throw new Error("App not found in registry");
  if (!appHasPasswordVisibility(manifest)) {
    throw new Error(
      "This app has no password-protected pages or API routes in its manifest.",
    );
  }

  await setAppPassword({
    appSlug: slug,
    plaintext,
    setByUserId: dbUser.id,
  });

  // THAT a password was set, never the password.
  await recordAdminAction(
    { id: dbUser.id, email: dbUser.email },
    { action: "app.password.set", targetType: "app", targetId: slug },
  );

  revalidatePath("/admin/apps");
}

export async function clearAppPasswordAction(slug: string): Promise<void> {
  const session = await requireReadOnlySession();
  const admin = await requireAdmin(session);

  await clearAppPassword(slug);
  await recordAdminAction(
    { id: admin.id, email: admin.email },
    { action: "app.password.clear", targetType: "app", targetId: slug },
  );

  revalidatePath("/admin/apps");
}

function appHasPasswordVisibility(
  manifest: import("@/lib/apps/types").AppManifest,
): boolean {
  const declaresPassword = (sets: Record<string, string[]> | undefined) =>
    Object.values(sets ?? {}).some((auths) => auths.includes("password"));
  return (
    declaresPassword(manifest.pageVisibility) ||
    declaresPassword(manifest.apiVisibility)
  );
}

/**
 * Force-sign-out one user, everywhere, immediately.
 *
 * The offboarding lever. With `strategy: "jwt"` there is no session row to
 * delete, so clearing a cookie only ends the session on the device that asked;
 * this bumps `users.session_version`, which every session resolution compares
 * against (see src/lib/auth/config.ts). Every token minted before this moment
 * stops resolving on its next request.
 *
 * Scoped to one user on purpose. Rotating `AUTH_SECRET` is the platform-wide
 * equivalent and signs out everybody, which is the right answer for a suspected
 * secret leak and the wrong one for a departing employee.
 */
export async function revokeUserSessionsAction(userId: string): Promise<void> {
  const session = await requireReadOnlySession();
  const admin = await requireAdmin(session);

  const version = await revokeUserSessions(userId);

  await recordAdminAction(
    { id: admin.id, email: admin.email },
    {
      action: "user.sessions.revoke",
      targetType: "user",
      targetId: userId,
      details: { sessionVersion: version },
    },
  );

  revalidatePath("/admin/users");
}
