/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/db/server";
import { requireReadOnlySession } from "@/lib/auth/session";
import { requireAdmin, isGlobalApp, setUserAppRole } from "@/lib/apps/access";
import { appRegistry } from "@/generated/app-registry";
import {
  getMissingTenantConfigConnectors,
  formatMissingList,
} from "@/lib/apps/connector-gates";
import { removeAppWidgetsForUser } from "@/lib/dashboard/cleanup";
import UserTable, { type UserRow } from "@/components/admin/user-table";
import { recordAdminAction } from "@/lib/apps/admin-audit";

export default async function UsersAdminPage() {
  const pageSession = await requireReadOnlySession();
  const pageAdmin = await requireAdmin(pageSession);

  const supabase = createServiceClient();

  const [{ data: users }, { data: grants }, { data: installs }, missingByApp] =
    await Promise.all([
      supabase.from("users").select("*").order("display_name"),
      supabase.from("user_app_grants").select("user_id, app_slug, role"),
      supabase.from("user_apps").select("user_id, app_slug"),
      /*
        THE CONNECTOR GATE LIVES HERE NOW.

        It used to sit on registration: an app whose declared connectors had no
        credentials could not be switched on, so nobody could be given it. With
        registration gone, granting is where that consequence has to land —
        every connector is tenant-scoped, so an app missing one does not work
        for the person you just gave it to, whoever they are.
      */
      Promise.all(
        appRegistry.map(
          async (a) =>
            [a.slug, await getMissingTenantConfigConnectors(a.slug)] as const,
        ),
      ),
    ]);

  const blockedBySlug = new Map(
    missingByApp
      .filter(([, missing]) => missing.length > 0)
      .map(([slug, missing]) => [slug, formatMissingList(missing)]),
  );

  // Every app in the registry. Being in it IS being valid — it passed
  // build-time validation — so there is nothing further to filter by.
  const grantableApps = appRegistry;
  const globalSlugs = grantableApps.filter((a) => a.global).map((a) => a.slug);

  const grantsByUser = new Map<string, string[]>();
  const roleByUserSlug = new Map<string, Record<string, string | null>>();
  for (const row of grants ?? []) {
    const list = grantsByUser.get(row.user_id) ?? [];
    list.push(row.app_slug);
    grantsByUser.set(row.user_id, list);

    const roleMap = roleByUserSlug.get(row.user_id) ?? {};
    roleMap[row.app_slug] = row.role ?? null;
    roleByUserSlug.set(row.user_id, roleMap);
  }

  // Effective role per granted slug, defaulting to each app's manifest default
  // when no explicit role is stored (covers existing grants and global apps).
  const defaultRoleBySlug = new Map<string, string | null>(
    grantableApps.map((a) => [a.slug, a.defaultRole]),
  );

  const installsByUser = new Map<string, Set<string>>();
  for (const row of installs ?? []) {
    const set = installsByUser.get(row.user_id) ?? new Set<string>();
    set.add(row.app_slug);
    installsByUser.set(row.user_id, set);
  }

  const rows: UserRow[] = (users ?? []).map(
    (u: {
      id: string;
      display_name: string;
      email: string;
      is_admin: boolean;
    }) => {
      const explicitGrants = grantsByUser.get(u.id) ?? [];
      const grantedSet = new Set(explicitGrants);
      for (const slug of globalSlugs) grantedSet.add(slug);
      const grantedSlugs = Array.from(grantedSet);
      // A grant for a slug no longer in the registry is not counted: the app is
      // gone from the repo and the row is on its way out on the next sync.
      const inRegistry = new Set(grantableApps.map((a) => a.slug));
      const grantedActiveCount = grantedSlugs.filter((s) =>
        inRegistry.has(s),
      ).length;
      const installedSet = installsByUser.get(u.id) ?? new Set<string>();
      const installedActiveCount = grantedSlugs.filter(
        (s) => inRegistry.has(s) && installedSet.has(s),
      ).length;
      const explicitRoles = roleByUserSlug.get(u.id) ?? {};
      const roleBySlug: Record<string, string | null> = {};
      for (const slug of grantedSlugs) {
        roleBySlug[slug] =
          explicitRoles[slug] ?? defaultRoleBySlug.get(slug) ?? null;
      }
      return {
        id: u.id,
        display_name: u.display_name,
        email: u.email,
        is_admin: u.is_admin,
        grantedSlugs,
        grantedActiveCount,
        installedActiveCount,
        roleBySlug,
      };
    },
  );

  async function toggleUserGrant(formData: FormData) {
    "use server";
    const userId = formData.get("userId") as string;
    const slug = formData.get("slug") as string;
    const granted = formData.get("granted") === "true";

    if (!userId || !slug) return;

    const supa = createServiceClient();
    const session = await requireReadOnlySession();
    const adminUser = await requireAdmin(session);

    if (isGlobalApp(slug)) {
      throw new Error("Global apps cannot be granted or revoked per-user.");
    }

    // Re-checked server-side, not just disabled in the UI: the disabled control
    // is a courtesy and a form post is not obliged to respect it. Revoking is
    // always allowed — an app that stopped working is one you want to be able
    // to take away.
    if (!granted) {
      const missing = await getMissingTenantConfigConnectors(slug);
      if (missing.length > 0) {
        throw new Error(
          `Configure these connectors first: ${formatMissingList(missing)}`,
        );
      }
    }

    if (granted) {
      // Revoking the grant must also uninstall the app. The FK cascade from
      // grants -> installs was removed in migration 008 so installs can exist
      // without grants (for global apps). Delete the install row explicitly.
      const { error: installErr } = await supa
        .from("user_apps")
        .delete()
        .match({ user_id: userId, app_slug: slug });
      if (installErr) {
        console.error("toggleUserGrant install-delete error:", installErr);
        throw new Error(installErr.message);
      }

      const { error } = await supa
        .from("user_app_grants")
        .delete()
        .match({ user_id: userId, app_slug: slug });
      if (error) {
        console.error("toggleUserGrant delete error:", error);
        throw new Error(error.message);
      }

      await removeAppWidgetsForUser(userId, slug);
    } else {
      const manifest = appRegistry.find((a) => a.slug === slug);
      const { error } = await supa.from("user_app_grants").upsert({
        user_id: userId,
        app_slug: slug,
        granted_by: adminUser?.id ?? null,
        role: manifest?.defaultRole ?? null,
      });
      if (error) {
        console.error("toggleUserGrant upsert error:", error);
        throw new Error(error.message);
      }
    }

    // The question this table exists to answer: who gave this person access to
    // this app, and when.
    await recordAdminAction(
      { id: adminUser.id, email: adminUser.email },
      {
        action: granted ? "user.grant.revoke" : "user.grant.add",
        targetType: "user",
        targetId: userId,
        details: { appSlug: slug },
      },
    );

    revalidatePath("/admin/users");
    revalidatePath("/apps");
    revalidatePath("/");
  }

  async function setUserGrantRole(formData: FormData) {
    "use server";
    const userId = formData.get("userId") as string;
    const slug = formData.get("slug") as string;
    const role = (formData.get("role") as string) || null;

    if (!userId || !slug) return;

    const session = await requireReadOnlySession();
    const roleAdmin = await requireAdmin(session);

    // Guard against arbitrary values: the role must be one the app declares.
    const manifest = appRegistry.find((a) => a.slug === slug);
    const validRole =
      role !== null && manifest?.roles.some((r) => r.key === role);
    if (role !== null && !validRole) {
      throw new Error(`"${role}" is not a valid role for ${slug}.`);
    }

    await setUserAppRole(userId, slug, role);
    await recordAdminAction(
      { id: roleAdmin.id, email: roleAdmin.email },
      {
        action: "user.role.set",
        targetType: "user",
        targetId: userId,
        details: { appSlug: slug, role },
      },
    );

    revalidatePath("/admin/users");
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">Users</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Add people, set what they can sign in with, and grant them access to
          apps. Granted apps appear in the user&apos;s App Manager for them to
          install.
        </p>
      </div>

      {/*
        The "admin is a database flag, set it yourself" notice that used to sit
        here is gone: the Profile tab sets it now, with the guards that a hand
        edit never had — you cannot demote yourself, and you cannot remove the
        last administrator. `npm run seed-admin` is still how the FIRST one is
        made, which is a bootstrap concern and belongs in the setup guide rather
        than on a page you can only reach by already being an admin.
      */}
      <UserTable
        users={rows}
        registeredApps={grantableApps}
        blockedBySlug={Object.fromEntries(blockedBySlug)}
        currentAdminId={pageAdmin.id}
        toggleAction={toggleUserGrant}
        setRoleAction={setUserGrantRole}
      />
    </div>
  );
}
