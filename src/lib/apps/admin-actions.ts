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
  getMissingTenantConfigConnectors,
  formatMissingList,
} from "@/lib/apps/connector-gates";
import {
  clearAppPassword,
  getAppPasswordMetadata,
  setAppPassword,
} from "@/lib/apps/app-password-store";

export async function getRegisteredSlugs(): Promise<string[]> {
  const supa = createServiceClient();
  const { data } = await supa.from("apps").select("slug");
  return data?.map((r: { slug: string }) => r.slug) ?? [];
}

export interface AppSchemaColumn {
  name: string;
  type: string;
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
    t.columns.push({ name: r.column_name, type: r.data_type });
  }
  return Array.from(byTable.values());
}

export async function toggleAppRegistration(slug: string, currentlyRegistered: boolean) {
  const session = await requireReadOnlySession();
  await requireAdmin(session);

  const supa = createServiceClient();

  if (currentlyRegistered) {
    // Deregister — CASCADE on user_apps FK handles cleanup
    const { error } = await supa.from("apps").delete().eq("slug", slug);
    if (error) throw new Error(error.message);
  } else {
    const app = appRegistry.find((a) => a.slug === slug);
    if (!app) throw new Error("App not found in registry");

    // Gate: every declared connector must have a connector_configs row before
    // the app can be registered. Connectors are tenant-scoped, so that single
    // admin-entered credential set is what makes the app work for everyone.
    const missing = await getMissingTenantConfigConnectors(slug);
    if (missing.length > 0) {
      throw new Error(
        `Configure these connectors first: ${formatMissingList(missing)}`,
      );
    }

    const { error } = await supa.from("apps").upsert(
      { slug: app.slug, name: app.name, description: app.description ?? null },
      { onConflict: "slug" }
    );
    if (error) throw new Error(error.message);
  }

  revalidatePath("/admin/apps");
  revalidatePath("/apps");
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

  revalidatePath("/admin/apps");
}

export async function clearAppPasswordAction(slug: string): Promise<void> {
  const session = await requireReadOnlySession();
  await requireAdmin(session);

  await clearAppPassword(slug);

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
