/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createServiceClient, sql } from "@/lib/db/server";
import { requireReadOnlySession } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/apps/access";
import { appRegistry } from "@/generated/app-registry";
import { IS_GRANT_SQL } from "@/lib/apps/grant-rule";
import {
  getMissingTenantConfigConnectors,
  missingConnectorSteps,
} from "@/lib/apps/connector-gates";
import {
  grantAppAccess,
  revokeAppAccess,
  setAppRoleAction,
} from "@/lib/apps/grant-actions";
import UserTable, {
  type GrantToggleOutcome,
  type UserRow,
} from "@/components/admin/user-table";

export default async function UsersAdminPage() {
  const pageSession = await requireReadOnlySession();
  const pageAdmin = await requireAdmin(pageSession);

  const supabase = createServiceClient();

  const [{ data: users }, grants, { data: installs }, missingByApp] =
    await Promise.all([
      supabase.from("users").select("*").order("display_name"),
      // Each row with whether it is a grant, as every access check decides it
      // (src/lib/apps/grant-rule.ts).
      sql<{ user_id: string; app_slug: string; role: string | null; held: boolean }[]>`
        select g.user_id, g.app_slug, g.role, ${sql.unsafe(IS_GRANT_SQL)} as held
          from public.user_app_grants g
      `,
      supabase.from("user_apps").select("user_id, app_slug"),
      /*
        THE CONNECTOR GATE. Granting is where an app's unready connectors land:
        an app whose tenant connector isn't ready doesn't work for the person
        you give it to, whoever they are.
      */
      // For display: the grant itself checks again, and refuses.
      Promise.all(
        appRegistry.map(
          async (a) =>
            [
              a.slug,
              await getMissingTenantConfigConnectors(a.slug, { forDisplay: true }),
            ] as const,
        ),
      ),
    ]);

  const blockedBySlug = new Map(
    missingByApp
      .filter(([, missing]) => missing.length > 0)
      .map(([slug, missing]) => [slug, missingConnectorSteps(missing)]),
  );

  // Every app in the registry. Being in it IS being valid — it passed
  // build-time validation — so there is nothing further to filter by.
  const grantableApps = appRegistry;
  const globalSlugs = grantableApps.filter((a) => a.global).map((a) => a.slug);

  const globalSet = new Set(globalSlugs);

  const grantsByUser = new Map<string, string[]>();
  const roleByUserSlug = new Map<string, Record<string, string | null>>();
  const roleOnlyByUser = new Map<string, Record<string, string | null>>();
  for (const row of grants) {
    // A row that records only a role gives no access. On a global app that is
    // all it ever needs to; on any other, it is a role kept from when the app
    // was global, shown beside the grant it isn't.
    if (!row.held && !globalSet.has(row.app_slug)) {
      const kept = roleOnlyByUser.get(row.user_id) ?? {};
      kept[row.app_slug] = row.role ?? null;
      roleOnlyByUser.set(row.user_id, kept);
      continue;
    }
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
      // A grant for a slug not in this build is not counted: nobody can open
      // that app here. The release step keeps the row in case the app comes
      // back (scripts/sync-app-registry.ts).
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
      const assignedRoleBySlug: Record<string, string | null> = {};
      for (const slug of grantedSlugs) {
        assignedRoleBySlug[slug] = explicitRoles[slug] ?? null;
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
        assignedRoleBySlug,
        roleOnlyBySlug: roleOnlyByUser.get(u.id) ?? {},
      };
    },
  );

  /*
    Thin FormData adapters over the shared grant actions in
    src/lib/apps/grant-actions.ts, which the app dialog's Access tab calls too.
    The connector gate, role validation and the audit record live there, once.
    Each adapter is a server action of its own, reachable by anyone who can
    name it, so it checks for an admin itself before it reads the form, as the
    shared action does again before it reads anything.

    A refusal is thrown, as it was when this page held the only copy: the form
    has nowhere else to put it, and its controls are disabled in the cases the
    shared action refuses. What a grant or revoke changed comes back, so the
    dialog can say when the person already had the app, or didn't.
  */
  async function toggleUserGrant(formData: FormData): Promise<GrantToggleOutcome> {
    "use server";
    await requireAdmin(await requireReadOnlySession());
    const userId = String(formData.get("userId") ?? "");
    const slug = String(formData.get("slug") ?? "");
    // "granted" is the state BEFORE the click: true means revoke.
    const granted = formData.get("granted") === "true";
    // A role kept from when the app was global, to grant it with. Checked
    // against the manifest by the shared action.
    const role = String(formData.get("role") ?? "") || null;
    if (!userId || !slug) throw new Error("That request isn't valid.");

    const result = granted
      ? await revokeAppAccess(slug, userId)
      : await grantAppAccess(slug, userId, role);
    if (!result.ok) throw new Error(result.message);
    return { changed: result.changed };
  }

  async function setUserGrantRole(formData: FormData) {
    "use server";
    await requireAdmin(await requireReadOnlySession());
    const userId = String(formData.get("userId") ?? "");
    const slug = String(formData.get("slug") ?? "");
    const role = String(formData.get("role") ?? "") || null;
    if (!userId || !slug) return;

    const result = await setAppRoleAction(slug, userId, role);
    if (!result.ok) throw new Error(result.message);
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
