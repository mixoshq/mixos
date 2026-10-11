/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { cache } from "react";
import { createServiceClient } from "@/lib/db/server";
import { appRegistry } from "@/generated/app-registry";
import { identityDetails, type IdentityDetails } from "@/lib/repository/identity";

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
  const slugs = await filterActiveApps(getGlobalAppSlugs());
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

/**
 * Is this app active on this instance?
 *
 * `apps.is_active` is an admin's switch, set on the Apps page, so it survives a
 * redeploy. The registry sync only ever turns it off, for an app that came
 * back into the build with different code, or that is a different extension
 * than the one recorded under its slug. Deactivating is meant to be
 * complete rather than cosmetic: an inactive app is filtered out of every list
 * AND refused by every gate — `hasAppGrant` (pages, MCP, OAuth) and
 * `resolveAuthTier` (every API route and public page) both call this, and the
 * app gate (`./app-gate.ts`) asks it before any of the app's modules is
 * imported. Hiding an app that still answers requests would be a claim the
 * platform does not keep.
 *
 * A missing row reads as INACTIVE. The row is written by the registry sync, so
 * its absence means an app the platform does not know about; defaulting that
 * to "serve it" would make a failed sync an availability decision.
 *
 * So does an app this build doesn't carry, whatever its row says. The release
 * step keeps the row of an app that left the build, switch included, so the
 * app can come back as it was (scripts/sync-app-registry.ts). Until it does,
 * its widgets, installs and grants stay in the database, and off every user's
 * dashboard and menus.
 *
 * Deduped per request: a single page render asks this for every widget on the
 * dashboard, and they are all the same question. `cache` is React's
 * request-scoped memo, so it never outlives the request that made it and an
 * admin's activation takes effect on the next one.
 */
export const isAppActive = cache(async (slug: string): Promise<boolean> => {
  if (!appRegistry.some((a) => a.slug === slug)) return false;
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("apps")
    .select("is_active")
    .eq("slug", slug)
    .maybeSingle();
  return data?.is_active === true;
});

/** The subset of `slugs` that are active, in the order given. */
export async function filterActiveApps(slugs: string[]): Promise<string[]> {
  const active = await Promise.all(slugs.map((slug) => isAppActive(slug)));
  return slugs.filter((_, i) => active[i]);
}

/**
 * Set by an admin on the Apps page. Inactive apps are refused everywhere.
 *
 * An upsert rather than an update, because the row is normally written by the
 * registry sync and an app registered from the catalogue can be activated
 * before that sync has run — "Activate in this checkout", straight after
 * Register, would otherwise update zero rows and report success for nothing.
 * The manifest supplies the columns the sync would have; a slug with no
 * manifest is refused by the caller.
 *
 * An app the release step found to be a different extension than the one
 * recorded under its slug (`identity_changed_at`, scripts/sync-app-registry.ts)
 * is activated only with its slug typed, `typedSlug`: it would be given the
 * grants, settings and data of the extension before it. Activating it clears
 * the flag, and returns the identity it replaced, for the audit row; any other
 * call returns null.
 */
export async function setAppActive(
  slug: string,
  isActive: boolean,
  typedSlug?: string,
): Promise<{ replaced: IdentityDetails } | null> {
  const manifest = appRegistry.find((a) => a.slug === slug);
  const supabase = createServiceClient();

  let confirmed: { replaced: IdentityDetails } | null = null;
  if (isActive) {
    const { data, error } = await supabase
      .from("apps")
      .select("identity_changed_at, replaced_identity")
      .eq("slug", slug)
      .maybeSingle();
    if (error) throw new Error(`Failed to read ${slug}: ${error.message}`);
    const row = data as { identity_changed_at: string | null; replaced_identity: string | null } | null;
    if (row?.identity_changed_at) {
      if (typedSlug?.trim() !== slug) {
        throw new Error(
          `${slug} replaces a different extension with the same slug. Type its slug to activate it.`,
        );
      }
      confirmed = { replaced: identityDetails(row.replaced_identity) };
    }
  }

  const { error } = await supabase.from("apps").upsert(
    {
      slug,
      name: manifest?.name ?? slug,
      description: manifest?.description ?? null,
      icon: manifest?.icon ?? null,
      is_active: isActive,
      // Activating is the admin's answer to an app that came back into the
      // build with different code, or as a different extension, so it clears
      // both flags. Deactivating leaves the question open.
      ...(isActive
        ? { returned_changed_at: null, identity_changed_at: null, replaced_identity: null }
        : {}),
    },
    { onConflict: "slug" },
  );
  if (error) throw new Error(`Failed to update ${slug}: ${error.message}`);
  return confirmed;
}

/** Every app's active flag, for the admin list. */
export async function getAppActiveMap(): Promise<Record<string, boolean>> {
  const supabase = createServiceClient();
  const { data } = await supabase.from("apps").select("slug, is_active");
  const out: Record<string, boolean> = {};
  for (const row of (data ?? []) as { slug: string; is_active: boolean }[]) {
    out[row.slug] = row.is_active;
  }
  return out;
}

/** An app this database keeps that the running build doesn't carry. */
export interface AppNotInBuild {
  slug: string;
  name: string;
  icon: string | null;
  /** When a release step first ran without it. Null when none has since. */
  missingSince: string | null;
}

/** An app in this build that a release step found under a slug a different extension had. */
export interface AppReplacement {
  /** When the release step switched it off. */
  at: string;
  /** The identity it replaced, and its own (src/lib/repository/identity.ts). */
  previous: string | null;
  identity: string | null;
}

export interface AppBuildStatus {
  /** Apps in this build that came back with different code: slug to when. */
  returnedChanged: Record<string, string>;
  /** Apps in this build that replace a different extension under their slug. */
  replaced: Record<string, AppReplacement>;
  /** Apps whose rows, and data, are kept although this build lacks them. */
  notInBuild: AppNotInBuild[];
}

/**
 * What the Apps page says about apps that left the build or came back, read
 * from the rows the release step keeps (scripts/sync-app-registry.ts).
 *
 * "Not in this build" means the build serving this request, which is what an
 * admin is looking at. It usually agrees with `missing_since`, which the last
 * release step wrote, but not always: a host can roll back to an older build
 * without running one.
 *
 * Empty when the read fails. These are notices beside the list, and the list
 * should still render without them.
 */
export async function getAppBuildStatus(): Promise<AppBuildStatus> {
  const inBuild = new Set(appRegistry.map((a) => a.slug));
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("apps")
    .select(
      "slug, name, icon, missing_since, returned_changed_at, identity, identity_changed_at, replaced_identity",
    )
    .order("name");

  const status: AppBuildStatus = { returnedChanged: {}, replaced: {}, notInBuild: [] };
  for (const row of (data ?? []) as {
    slug: string;
    name: string;
    icon: string | null;
    missing_since: string | null;
    returned_changed_at: string | null;
    identity: string | null;
    identity_changed_at: string | null;
    replaced_identity: string | null;
  }[]) {
    if (!inBuild.has(row.slug)) {
      status.notInBuild.push({
        slug: row.slug,
        name: row.name,
        icon: row.icon,
        missingSince: row.missing_since,
      });
      continue;
    }
    if (row.returned_changed_at) {
      status.returnedChanged[row.slug] = row.returned_changed_at;
    }
    if (row.identity_changed_at) {
      status.replaced[row.slug] = {
        at: row.identity_changed_at,
        previous: row.replaced_identity,
        identity: row.identity,
      };
    }
  }
  return status;
}

export async function getUserApps(userId: string): Promise<string[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("user_apps")
    .select("app_slug")
    .eq("user_id", userId);

  if (error) throw new Error(`Failed to get user apps: ${error.message}`);
  return filterActiveApps(
    data.map((row: { app_slug: string }) => row.app_slug),
  );
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
  return filterActiveApps(Array.from(explicit));
}

export async function hasAppGrant(
  userId: string,
  appSlug: string,
): Promise<boolean> {
  // Before the grant, and before the global-app shortcut: a deactivated app is
  // not one anybody holds, however they came by it.
  if (!(await isAppActive(appSlug))) return false;
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
  if (!(await isAppActive(appSlug))) return false;
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
