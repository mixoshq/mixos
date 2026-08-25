import { revalidatePath } from "next/cache";
import { Info } from "lucide-react";
import { createServiceClient } from "@/lib/db/server";
import { requireReadOnlySession } from "@/lib/auth/session";
import { requireAdmin, isGlobalApp, setUserAppRole } from "@/lib/apps/access";
import { appRegistry } from "@/generated/app-registry";
import { getRegisteredSlugs } from "@/lib/apps/admin-actions";
import { removeAppWidgetsForUser } from "@/lib/dashboard/cleanup";
import UserAccordionList, {
  type UserRow,
} from "@/components/admin/user-accordion-list";

export default async function UsersAdminPage() {
  const pageSession = await requireReadOnlySession();
  await requireAdmin(pageSession);

  const supabase = createServiceClient();

  const [
    { data: users },
    { data: grants },
    { data: installs },
    registeredSlugsList,
  ] = await Promise.all([
    supabase.from("users").select("*").order("display_name"),
    supabase.from("user_app_grants").select("user_id, app_slug, role"),
    supabase.from("user_apps").select("user_id, app_slug"),
    getRegisteredSlugs(),
  ]);

  const registeredSlugs = new Set(registeredSlugsList);
  const registeredApps = appRegistry.filter((a) => registeredSlugs.has(a.slug));
  const globalRegisteredSlugs = registeredApps
    .filter((a) => a.global)
    .map((a) => a.slug);

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
    registeredApps.map((a) => [a.slug, a.defaultRole]),
  );

  const installsByUser = new Map<string, Set<string>>();
  for (const row of installs ?? []) {
    const set = installsByUser.get(row.user_id) ?? new Set<string>();
    set.add(row.app_slug);
    installsByUser.set(row.user_id, set);
  }

  const rows: UserRow[] = (users ?? []).map(
    (u: { id: string; display_name: string; email: string; is_admin: boolean }) => {
    const explicitGrants = grantsByUser.get(u.id) ?? [];
    const grantedSet = new Set(explicitGrants);
    for (const slug of globalRegisteredSlugs) grantedSet.add(slug);
    const grantedSlugs = Array.from(grantedSet);
    const grantedActiveCount = grantedSlugs.filter((s) =>
      registeredSlugs.has(s),
    ).length;
    const installedSet = installsByUser.get(u.id) ?? new Set<string>();
    const installedActiveCount = grantedSlugs.filter(
      (s) => registeredSlugs.has(s) && installedSet.has(s),
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
  });

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
    await requireAdmin(session);

    // Guard against arbitrary values: the role must be one the app declares.
    const manifest = appRegistry.find((a) => a.slug === slug);
    const validRole =
      role !== null && manifest?.roles.some((r) => r.key === role);
    if (role !== null && !validRole) {
      throw new Error(`"${role}" is not a valid role for ${slug}.`);
    }

    await setUserAppRole(userId, slug, role);

    revalidatePath("/admin/users");
  }

  return (
    <div>
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          Administration
        </p>
        <h1 className="mt-1 text-2xl font-bold text-foreground">Users</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Grant users access to apps. Granted apps appear in the user&apos;s
          App Manager for them to install.
        </p>
      </div>

      <div className="mb-6 flex gap-3 rounded-lg border border-border bg-muted/40 p-4 text-sm">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div>
          <p className="font-medium text-foreground">Granting admin access</p>
          <p className="mt-1 text-muted-foreground">
            Admin is the{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
              is_admin
            </code>{" "}
            flag on the user record, not something this page sets. How you change
            it depends on whether SSO admin mapping is configured on{" "}
            <strong>Authentication</strong>:
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
            <li>
              <strong>Mapping configured</strong> — the flag is synced from the
              identity provider on every SSO sign-in. Grant or revoke the claim
              there; it applies the next time the user signs in. Editing the
              database directly will be overwritten on their next login.
            </li>
            <li>
              <strong>Mapping not configured</strong> — the flag is managed in
              the database. Set it there, or seed the first admin with{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                npm run seed-admin
              </code>
              .
            </li>
          </ul>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card shadow-sm">
        <UserAccordionList
          users={rows}
          registeredApps={registeredApps}
          toggleAction={toggleUserGrant}
          setRoleAction={setUserGrantRole}
        />
      </div>
    </div>
  );
}
