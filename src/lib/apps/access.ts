/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { cache } from "react";
import { createServiceClient, sql } from "@/lib/db/server";
import { appRegistry } from "@/generated/app-registry";
import { IS_GRANT_SQL } from "@/lib/apps/grant-rule";
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
    .select("id")
    .single();

  if (error) throw new Error(`Failed to ensure user: ${error.message}`);
  return data.id;
}

/**
 * A newcomer starts with every `global` app installed, so the welcome tour has
 * something to put on the dashboard and a new one is not a blank page.
 *
 * Called at sign-in (the auth config's `signIn` event), and only while the
 * tour isn't finished. At sign-in rather than on page views: an app they
 * uninstall in App Manager has to stay uninstalled, which it wouldn't if
 * every page put it back. Sign-in still
 * covers every way an account comes to exist — the first admin is seeded
 * outside the app — and two at once are one idempotent upsert.
 */
export async function installGlobalAppsForNewcomer(userId: string): Promise<void> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("users")
    .select("onboarding_completed_at")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new Error(`Failed to read onboarding: ${error.message}`);
  if (!data || data.onboarding_completed_at !== null) return;
  await installGlobalApps(supabase, userId);
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

/**
 * Why people who had an app lost it, as the release step found
 * (scripts/sync-app-registry.ts): it stopped being global, and someone who had
 * it, by an install or a role, has no grant. The only reason there is; the
 * column holding it accepts nothing else.
 */
export type NeedsGrantsReason = "global-ended";

/** An app's Needs grants mark: since when, and why. */
export interface NeedsGrants {
  /** ISO-8601. */
  since: string;
  reason: NeedsGrantsReason;
}

export interface AppBuildStatus {
  /** Apps in this build that came back with different code: slug to when. */
  returnedChanged: Record<string, string>;
  /**
   * Apps in this build that people lost, and that nobody has been granted
   * since: slug to when and why.
   */
  needsGrants: Record<string, NeedsGrants>;
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
      "slug, name, icon, missing_since, returned_changed_at, identity, identity_changed_at, replaced_identity, needs_grants_since, needs_grants_reason",
    )
    .order("name");

  const status: AppBuildStatus = {
    returnedChanged: {},
    needsGrants: {},
    replaced: {},
    notInBuild: [],
  };
  for (const row of (data ?? []) as {
    slug: string;
    name: string;
    icon: string | null;
    missing_since: string | null;
    returned_changed_at: string | null;
    identity: string | null;
    identity_changed_at: string | null;
    replaced_identity: string | null;
    needs_grants_since: string | null;
    needs_grants_reason: NeedsGrantsReason | null;
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
    if (row.needs_grants_since && row.needs_grants_reason && !isGlobalApp(row.slug)) {
      status.needsGrants[row.slug] = { since: row.needs_grants_since, reason: row.needs_grants_reason };
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

/**
 * The apps the user has installed and still holds, in no particular order.
 *
 * An install outlives the access behind it when an app stops being global:
 * nobody revoked anything, so the install row stays. Filtering by what the
 * user holds keeps such an app off their dashboard and menus until someone
 * grants it, without forgetting where its widgets were.
 */
export async function getUserApps(userId: string): Promise<string[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("user_apps")
    .select("app_slug")
    .eq("user_id", userId);

  if (error) throw new Error(`Failed to get user apps: ${error.message}`);
  return filterHeldApps(
    userId,
    data.map((row: { app_slug: string }) => row.app_slug),
  );
}

/** The slugs of the apps granted to the user, a role alone not counting. */
async function grantedSlugs(userId: string, among?: readonly string[]): Promise<Set<string>> {
  const rows = await sql<{ app_slug: string }[]>`
    select g.app_slug from public.user_app_grants g
     where g.user_id = ${userId}
       ${among ? sql`and g.app_slug = any(${[...among]}::text[])` : sql``}
       and ${sql.unsafe(IS_GRANT_SQL)}
  `;
  return new Set(rows.map((r) => r.app_slug));
}

export async function getUserGrantedSlugs(userId: string): Promise<string[]> {
  let explicit: Set<string>;
  try {
    explicit = await grantedSlugs(userId);
  } catch (err) {
    throw new Error(`Failed to get user grants: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const slug of getGlobalAppSlugs()) explicit.add(slug);
  return filterActiveApps(Array.from(explicit));
}

/**
 * Whether the user holds the app: it is active, and global or granted to them.
 *
 * A grant is a `user_app_grants` row that ./grant-rule.ts says is one. A row
 * that records only a role is not, so an app that stops being global is held
 * only by the people an admin granted it to. Fails closed: a grant that can't
 * be read is no grant.
 */
export async function hasAppGrant(
  userId: string,
  appSlug: string,
): Promise<boolean> {
  // Before the grant, and before the global-app shortcut: a deactivated app is
  // not one anybody holds, however they came by it.
  if (!(await isAppActive(appSlug))) return false;
  if (isGlobalApp(appSlug)) return true;

  try {
    return (await grantedSlugs(userId, [appSlug])).has(appSlug);
  } catch (err) {
    console.error(`[access] could not read ${appSlug}'s grant, so it counts as none:`, err);
    return false;
  }
}

/**
 * The subset of `slugs` the user holds, as `hasAppGrant` decides it, in the
 * order given: one read of the user's grants for the lot.
 *
 * It backs the dashboard, the menu bar and the App Manager, so a grant read
 * that fails doesn't take them down: it is logged, and only the global apps,
 * which need no grant, are counted as held.
 */
export async function filterHeldApps(
  userId: string,
  slugs: readonly string[],
): Promise<string[]> {
  const active = await filterActiveApps([...slugs]);
  const needsGrant = active.filter((slug) => !isGlobalApp(slug));
  if (needsGrant.length === 0) return active;

  let granted: Set<string>;
  try {
    granted = await grantedSlugs(userId, needsGrant);
  } catch (err) {
    console.error("[access] could not read the user's grants; counting only the global apps:", err);
    granted = new Set();
  }
  return active.filter((slug) => isGlobalApp(slug) || granted.has(slug));
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
