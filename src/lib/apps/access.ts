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
  ? process.env.ALLOWED_EMAIL_DOMAINS.split(",").map((d) => d.trim().toLowerCase())
  : null;

export async function ensureUser(args: {
  email: string;
  name: string;
}): Promise<string> {
  const email = args.email.trim().toLowerCase();
  if (ALLOWED_DOMAINS) {
    const domain = email.split("@")[1]?.toLowerCase();
    if (!domain || !ALLOWED_DOMAINS.includes(domain)) {
      throw new Error("User email domain is not allowed");
    }
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
      { onConflict: "email" }
    )
    .select("id")
    .single();

  if (error) throw new Error(`Failed to ensure user: ${error.message}`);
  return data.id;
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
  appSlug: string
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
