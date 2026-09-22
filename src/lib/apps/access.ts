/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createServiceClient } from "@/lib/db/server";
import { appRegistry } from "@/generated/app-registry";

function getGlobalAppSlugs(): string[] {
  return appRegistry.filter((a) => a.global).map((a) => a.slug);
}

export function isGlobalApp(slug: string): boolean {
  return appRegistry.some((a) => a.slug === slug && a.global);
}

function getAppDefaultRole(slug: string): string | null {
  return appRegistry.find((a) => a.slug === slug)?.defaultRole ?? null;
}

/**
 * The user's effective role key for an app. Reads the `role` stored on their
 * grant, falling back to the manifest's `defaultRole` when the grant row's
 * role is null *or there is no grant row at all* (the global-app case). Returns
 * `null` when the app declares no default and the user has no explicit role.
 */
export async function getUserAppRole(
  userId: string,
  appSlug: string,
): Promise<string | null> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("user_app_grants")
    .select("role")
    .eq("user_id", userId)
    .eq("app_slug", appSlug)
    .maybeSingle();

  return data?.role ?? getAppDefaultRole(appSlug);
}

/**
 * Set (or change) a user's role for an app. Upserts the grant row so it works
 * for global apps too — the row only carries the role; `isGlobalApp` still
 * short-circuits the access check, so creating it doesn't change who can reach
 * the app. Pass `null` to clear the explicit role (falls back to defaultRole).
 */
export async function setUserAppRole(
  userId: string,
  appSlug: string,
  role: string | null,
): Promise<void> {
  const supabase = createServiceClient();
  const { error } = await supabase.from("user_app_grants").upsert({
    user_id: userId,
    app_slug: appSlug,
    role,
  });
  if (error) throw new Error(`Failed to set user app role: ${error.message}`);
}

/**
 * Allowed email domains for user provisioning. When set, only users whose
 * email matches one of these domains will be created in the database.
 * Comma-separated, e.g. "mysite.com,example.com".
 */
const ALLOWED_DOMAINS = process.env.ALLOWED_EMAIL_DOMAINS
  ? process.env.ALLOWED_EMAIL_DOMAINS.split(",").map((d) =>
      d.trim().toLowerCase(),
    )
  : null;

/**
 * Whether this deployment will provision an account for this address.
 *
 * Exported because the policy has to hold on BOTH ways in — sign-in
 * provisioning and an admin creating an account by hand. A gate enforced on one
 * path is a gate with a door next to it.
 */
export function isAllowedEmailDomain(email: string): boolean {
  if (!ALLOWED_DOMAINS) return true;
  const domain = email.trim().toLowerCase().split("@")[1]?.toLowerCase();
  return !!domain && ALLOWED_DOMAINS.includes(domain);
}

/** The domains this deployment accepts, for an error message. Empty if any. */
export function allowedEmailDomains(): string[] {
  return ALLOWED_DOMAINS ? [...ALLOWED_DOMAINS] : [];
}

export async function ensureUser(args: {
  email: string;
  name: string;
}): Promise<string> {
  const email = args.email.trim().toLowerCase();
  if (!isAllowedEmailDomain(email)) {
    throw new Error("User email domain is not allowed");
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("users")
    .upsert(
      {
        email,
        display_name: args.name,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "email" },
    )
    .select("id, onboarding_completed_at")
    .single();

  if (error) throw new Error(`Failed to ensure user: ${error.message}`);

  // A first sign-in starts with every `global` app installed, so the welcome
  // tour has a widget to add and a new dashboard is not a blank page. "First
  // sign-in" is read off the tour: until it is finished or skipped, the
  // install is re-asserted on each visit (idempotent, one upsert), which is
  // what makes it hold for users seeded outside this function — the first
  // admin — and for a session that races itself. Afterwards it is theirs to
  // uninstall like any other app.
  if (data.onboarding_completed_at === null) {
    await installGlobalApps(supabase, data.id);
  }
  return data.id;
}

async function installGlobalApps(
  supabase: ReturnType<typeof createServiceClient>,
  userId: string,
): Promise<void> {
  const slugs = getGlobalAppSlugs();
  if (slugs.length === 0) return;
  const { error } = await supabase.from("user_apps").upsert(
    slugs.map((app_slug, position) => ({
      user_id: userId,
      app_slug,
      position,
    })),
    { onConflict: "user_id,app_slug", ignoreDuplicates: true },
  );
  if (error) throw new Error(`Failed to install global apps: ${error.message}`);
}

export async function getUserApps(userId: string): Promise<string[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("user_apps")
    .select("app_slug")
    .eq("user_id", userId);

  if (error) throw new Error(`Failed to get user apps: ${error.message}`);
  return data.map((row: { app_slug: string }) => row.app_slug);
}

export async function getUserGrantedSlugs(userId: string): Promise<string[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("user_app_grants")
    .select("app_slug")
    .eq("user_id", userId);

  if (error) throw new Error(`Failed to get user grants: ${error.message}`);
  const explicit = new Set<string>(
    data.map((row: { app_slug: string }) => row.app_slug),
  );
  for (const slug of getGlobalAppSlugs()) explicit.add(slug);
  return Array.from(explicit);
}

export async function hasAppGrant(
  userId: string,
  appSlug: string,
): Promise<boolean> {
  if (isGlobalApp(appSlug)) return true;

  const supabase = createServiceClient();
  const { data } = await supabase
    .from("user_app_grants")
    .select("app_slug")
    .eq("user_id", userId)
    .eq("app_slug", appSlug)
    .maybeSingle();

  return !!data;
}

export async function hasAppAccess(
  userId: string,
  appSlug: string,
): Promise<boolean> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("user_apps")
    .select("app_slug")
    .eq("user_id", userId)
    .eq("app_slug", appSlug)
    .maybeSingle();

  return !!data;
}

export async function getUserById(userId: string) {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("users")
    .select("*")
    .eq("id", userId)
    .maybeSingle();

  return data;
}

export async function getUserByEmail(email: string) {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("users")
    .select("*")
    .eq("email", email.trim().toLowerCase())
    .maybeSingle();

  return data;
}

/**
 * Require that the current session belongs to an admin user.
 * Throws if the session is missing or the user is not an admin.
 */
export async function requireAdmin(session: { user: { id: string } }) {
  const dbUser = await getUserById(session.user.id);
  if (!dbUser?.is_admin) {
    throw new Error("Admin access required");
  }
  return dbUser;
}
