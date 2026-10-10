/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use server";

import { createServiceClient, sql } from "@/lib/db/server";
import { appRegistry } from "@/generated/app-registry";
import { revalidatePath } from "next/cache";
import { requireReadOnlySession } from "@/lib/auth/session";
import { requireAdmin, setAppActive } from "@/lib/apps/access";
import {
  formatMissingList,
  getMissingTenantConfigConnectors,
} from "@/lib/apps/connector-gates";
import {
  clearAppPassword,
  getAppPasswordMetadata,
  setAppPassword,
} from "@/lib/apps/app-password-store";
import { recordAdminAction } from "@/lib/apps/admin-audit";
import { appSchemaName } from "@/lib/apps/app-identifiers";
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
 * One query for the whole registry, for the same reason as getAppGrantCounts:
 * the list renders every app at once. Apps with no tables are absent — callers
 * read a missing key as 0.
 *
 * Each app's tables are its schema's (src/lib/apps/app-identifiers.ts), so a
 * table belongs to exactly one app by where it is, not by what it is called.
 */
export async function getAppTableCounts(): Promise<Record<string, number>> {
  const session = await requireReadOnlySession();
  await requireAdmin(session);

  const bySchema = new Map(
    appRegistry.filter((a) => a.database).map((a) => [appSchemaName(a.slug), a.slug]),
  );
  if (bySchema.size === 0) return {};

  const rows = await sql<{ table_schema: string; table_name: string }[]>`
    select table_schema, table_name from public.get_app_schema(${[...bySchema.keys()]})
  `;

  // One row per column; the set collapses them to one entry per table.
  const counts: Record<string, number> = {};
  for (const key of new Set(rows.map((r) => `${r.table_schema}.${r.table_name}`))) {
    const slug = bySchema.get(key.slice(0, key.indexOf(".")));
    if (slug) counts[slug] = (counts[slug] ?? 0) + 1;
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
   * What this column references, named the way the app's own migrations name
   * it. Null when the column is not a foreign key, and null when it points
   * outside the app's schema, since that target is not one of the tables being
   * listed and a bare name would look like one.
   */
  references: { table: string; column: string } | null;
}

export interface AppSchemaTable {
  name: string;
  columns: AppSchemaColumn[];
}

/**
 * Turn an app on or off for the whole instance.
 *
 * Deactivating is complete, not cosmetic: the app leaves every user's App
 * Manager and menu bar, its pages and API routes stop being served at any auth
 * tier, its widgets stop rendering and its scheduled jobs stop running. What it
 * does NOT touch is anyone's install, grants or data — reactivating puts
 * everyone back where they were, which is what makes this a switch rather than
 * a deletion.
 *
 * Audited like the other privileged app operations: who turned an app off for
 * everyone is exactly the question asked afterwards.
 */
export async function setAppActiveAction(
  slug: string,
  isActive: boolean,
): Promise<void> {
  const session = await requireReadOnlySession();
  const admin = await requireAdmin(session);

  if (!appRegistry.some((a) => a.slug === slug)) {
    throw new Error("App not found in registry");
  }

  // Enforced here, not only on the button. The tile disables Activate when a
  // declared connector is unconfigured, but the catalogue's "Install &
  // Activate" never touches that tile — and an app activated without its
  // connector is one that fails on its first request, for everyone, at once.
  // Deactivating is never blocked: the way out of a mistake must not be gated
  // on the thing that made it.
  if (isActive) {
    const missing = await getMissingTenantConfigConnectors(slug);
    if (missing.length > 0) {
      throw new Error(
        `Configure ${formatMissingList(missing)} before activating this app.`,
      );
    }
  }

  await setAppActive(slug, isActive);

  await recordAdminAction(
    { id: admin.id, email: admin.email },
    {
      action: isActive ? "app.activate" : "app.deactivate",
      targetType: "app",
      targetId: slug,
    },
  );

  // The app's own pages and routes read the flag per request, so only the
  // surfaces that cache a LIST of apps need clearing: the admin registry, the
  // App Manager, and the dashboard's menu bar.
  revalidatePath("/admin/apps");
  revalidatePath("/apps");
  revalidatePath("/", "layout");
}

export async function getAppSchema(slug: string): Promise<AppSchemaTable[]> {
  const session = await requireReadOnlySession();
  await requireAdmin(session);

  const app = appRegistry.find((a) => a.slug === slug);
  if (!app?.database) return [];
  const schema = appSchemaName(slug);
  const rows = await sql<
    {
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: boolean;
      column_default: string | null;
      is_primary_key: boolean;
      foreign_schema: string | null;
      foreign_table: string | null;
      foreign_column: string | null;
    }[]
  >`select * from public.get_app_schema(${[schema]})`;

  const byTable = new Map<string, AppSchemaTable>();
  for (const r of rows) {
    let t = byTable.get(r.table_name);
    if (!t) {
      t = { name: r.table_name, columns: [] };
      byTable.set(r.table_name, t);
    }
    t.columns.push({
      name: r.column_name,
      type: r.data_type,
      nullable: r.is_nullable,
      default: r.column_default,
      primaryKey: r.is_primary_key,
      references:
        // Only references within this app's schema, which are the only kind
        // its migrations can make.
        r.foreign_schema === schema && r.foreign_table && r.foreign_column
          ? { table: r.foreign_table, column: r.foreign_column }
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
