/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { appRegistry } from "@/generated/app-registry";
import { createServiceClient, sql } from "@/lib/db/server";
import { requireReadOnlySession } from "@/lib/auth/session";
import { requireAdmin, type NeedsGrants } from "@/lib/apps/access";
import {
  getMissingTenantConfigConnectors,
  missingConnectorSteps,
} from "@/lib/apps/connector-gates";
import { removeAppWidgetsForUser } from "@/lib/dashboard/cleanup";
import { recordAdminAction } from "@/lib/apps/admin-audit";
import { IS_GRANT_SQL } from "@/lib/apps/grant-rule";
import type { AppManifest } from "@/lib/apps/types";

/**
 * Who holds an app, and the three things that change it: grant, revoke, role.
 *
 * ONE IMPLEMENTATION, TWO SCREENS. The app's Access tab and /admin/users both
 * call these, because with two screens, a copy of the connector gate on each
 * would be a gate with a door next to it.
 *
 * A ROLE IS NEVER ACCESS. A row that records only a role, on a global app,
 * grants nothing, and ./grant-rule.ts says which rows those are, here as in
 * every access check. Setting a role on a global app writes such a row; a
 * grant turns one into a grant, and records who made it. A grant made before
 * an app went global stays a grant: while the app is global it changes
 * nothing, and if the app stops being global its holder keeps it.
 *
 * Every export is a directly invocable POST endpoint, so each one checks
 * `requireAdmin()` itself, before it reads anything else, and each change is
 * recorded in the admin audit trail. Nothing upstream does either. What they
 * are given is checked next, and a refusal comes back as a value: a thrown
 * error reaches the browser as an opaque digest in production.
 */

/**
 * What a change did. `changed: false` means there was nothing to do: the
 * person already had the app, or didn't have it to revoke. Nothing is written
 * or audited then, and the pages are refreshed anyway, since the one that
 * asked was showing something out of date.
 */
export type AccessResult = { ok: true; changed: boolean } | { ok: false; message: string };

const refused = (message: string): AccessResult => ({ ok: false, message });
const INVALID = refused("That request isn't valid.");
const NOT_IN_BUILD = refused("That app isn't in this build.");

async function admin() {
  return requireAdmin(await requireReadOnlySession());
}

const Slug = z.string().min(1).max(100);
/** A user id: any 8-4-4-4-12 hex id, which is what Postgres's uuid accepts. */
const UserId = z.guid();
/** A role key, or null for the app's `defaultRole`. Checked against the manifest. */
const Role = z.string().min(1).max(100).nullable();

const Target = z.object({ slug: Slug, userId: UserId });

function manifestFor(slug: string): AppManifest | null {
  return appRegistry.find((a) => a.slug === slug) ?? null;
}

/**
 * An app this database keeps whether or not this build carries it: its name,
 * and its manifest when the build has it. Revoking works on an app that left
 * the build, so a leaked key or an unwanted grant can be taken away before it
 * comes back.
 */
async function knownApp(slug: string): Promise<{ name: string; manifest: AppManifest | null } | null> {
  const manifest = manifestFor(slug);
  if (manifest) return { name: manifest.name, manifest };
  const { data } = await createServiceClient()
    .from("apps")
    .select("name")
    .eq("slug", slug)
    .maybeSingle();
  return data ? { name: data.name as string, manifest: null } : null;
}

/** SQL over the row aliased `g`: it is a grant. A fresh fragment per query. */
const isGrant = () => sql.unsafe(IS_GRANT_SQL);

/** Null when the role is one the app declares, or null; otherwise the refusal. */
function roleProblem(app: AppManifest, role: string | null): AccessResult | null {
  if (role === null || app.roles.some((r) => r.key === role)) return null;
  return refused(`"${role}" is not a role ${app.name} declares.`);
}

async function userName(userId: string): Promise<string | null> {
  const { data } = await createServiceClient()
    .from("users")
    .select("display_name, email")
    .eq("id", userId)
    .maybeSingle();
  if (!data) return null;
  return (data.display_name as string) || (data.email as string);
}

function revalidateAccess() {
  revalidatePath("/admin/apps");
  revalidatePath("/admin/users");
  revalidatePath("/apps");
  revalidatePath("/");
}

// ── Reading ─────────────────────────────────────────────────────────────────

export interface AppAccessRow {
  userId: string;
  name: string;
  email: string;
  /** Effective role key: the assigned one, or `defaultRole`. Null when neither. */
  role: string | null;
  /** Where `role` came from. */
  roleSource: "assigned" | "default" | "none";
  /**
   * The assigned key is one the manifest no longer declares: renamed or
   * removed. No route can name an undeclared role, so it satisfies none, and
   * the person doesn't fall back to `defaultRole` until an admin picks one.
   */
  roleStale: boolean;
  /** ISO-8601. Null on a global app, where nothing was granted. */
  grantedAt: string | null;
  /** Who granted it, by name; null when unknown or the admin is gone. */
  grantedBy: string | null;
}

/** Someone with a role in an app that isn't global, and no access to it. */
export interface AppRoleOnlyRow {
  userId: string;
  name: string;
  email: string;
  /** The role they were given while the app was global. */
  role: string | null;
  roleStale: boolean;
}

export interface AppAccessList {
  /** Every user holds a global app implicitly; rows are then every user. */
  global: boolean;
  /** False for an app this build doesn't carry: its grants can only be revoked. */
  inBuild: boolean;
  /**
   * When and why a release step found that people who had the app lost it,
   * while nobody has been granted it since; null otherwise.
   */
  needsGrants: NeedsGrants | null;
  /** The people with access. */
  rows: AppAccessRow[];
  /**
   * People with a role and no access: the app was global when they were given
   * the role. Empty on a global app, where a role is all anyone needs.
   */
  roleOnly: AppRoleOnlyRow[];
}

/** Everyone who holds the app, with their effective role. Admin-only; not audited, as no read is. */
export async function listAppAccess(slug: string): Promise<AppAccessList> {
  await admin();
  const parsed = Slug.safeParse(slug);
  const known = parsed.success ? await knownApp(parsed.data) : null;
  if (!parsed.success || !known) throw new Error("App not found.");
  const app = known.manifest;
  const supa = createServiceClient();

  const [grantRows, { data: appRow, error: aErr }] = await Promise.all([
    sql<{ user_id: string; role: string | null; granted_at: Date | null; granted_by: string | null; held: boolean }[]>`
      select g.user_id, g.role, g.granted_at, g.granted_by, ${isGrant()} as held
        from public.user_app_grants g
       where g.app_slug = ${parsed.data}
    `.catch(() => null),
    supa.from("apps").select("needs_grants_since, needs_grants_reason").eq("slug", parsed.data).maybeSingle(),
  ]);
  if (!grantRows || aErr) throw new Error("Could not read who has access.");

  const global = app?.global === true;
  const byUser = new Map(grantRows.map((g) => [g.user_id, g]));
  // On a global app everyone has it; on any other, only the grants are access.
  const holding = (g: (typeof grantRows)[number]) => global || g.held;

  // A global app is held by everyone, so the list is every user; otherwise it
  // is the rows, plus whoever granted them, for the "by" column.
  const wanted = new Set<string>(grantRows.map((g) => g.user_id));
  for (const g of grantRows) if (g.granted_by) wanted.add(g.granted_by);

  const usersQuery = supa.from("users").select("id, email, display_name");
  const { data: users, error: uErr } = global
    ? await usersQuery
    : wanted.size > 0
      ? await usersQuery.in("id", [...wanted])
      : { data: [], error: null };
  if (uErr) throw new Error("Could not read who has access.");

  const people = (users ?? []) as { id: string; email: string; display_name: string | null }[];
  const nameOf = new Map(people.map((u) => [u.id, u.display_name || u.email]));
  const declared = new Set((app?.roles ?? []).map((r) => r.key));
  // Without the manifest there are no declared roles to measure against.
  const stale = (role: string | null) => app !== null && role !== null && !declared.has(role);

  const holders = global
    ? people
    : people.filter((u) => {
        const g = byUser.get(u.id);
        return g !== undefined && holding(g);
      });

  const rows: AppAccessRow[] = holders.map((u) => {
    const grant = byUser.get(u.id);
    const assigned = grant?.role ?? null;
    const role = assigned ?? app?.defaultRole ?? null;
    return {
      userId: u.id,
      name: u.display_name || u.email,
      email: u.email,
      role,
      roleSource: assigned ? "assigned" : role ? "default" : "none",
      roleStale: stale(assigned),
      grantedAt: global || !grant?.granted_at ? null : grant.granted_at.toISOString(),
      grantedBy: global || !grant?.granted_by ? null : (nameOf.get(grant.granted_by) ?? null),
    };
  });

  // Out of the build, roles can't be set or cleared, and grant nothing either way.
  const roleOnly: AppRoleOnlyRow[] = global || !app
    ? []
    : grantRows
        .filter((g) => !g.held)
        .map((g) => {
          const u = people.find((p) => p.id === g.user_id);
          return {
            userId: g.user_id,
            name: u ? u.display_name || u.email : g.user_id,
            email: u?.email ?? "",
            role: g.role,
            roleStale: stale(g.role),
          };
        });

  rows.sort((a, b) => a.name.localeCompare(b.name));
  roleOnly.sort((a, b) => a.name.localeCompare(b.name));
  return {
    global,
    inBuild: app !== null,
    needsGrants:
      global || !app || !appRow?.needs_grants_since || !appRow.needs_grants_reason
        ? null
        : { since: appRow.needs_grants_since as string, reason: appRow.needs_grants_reason as NeedsGrants["reason"] },
    rows,
    roleOnly,
  };
}

export interface GrantCandidate {
  userId: string;
  name: string;
  email: string;
}

/**
 * A fragment as a LIKE pattern that matches it literally, anywhere. `!` is the
 * escape character rather than a backslash, so the pattern means the same
 * whatever `standard_conforming_strings` is set to.
 */
function containsPattern(fragment: string): string {
  return `%${fragment.replace(/[!%_]/g, (c) => `!${c}`)}%`;
}

/**
 * Up to ten people an admin could grant this app to, matching a name or email
 * fragment. Excludes the people who hold it, so the type-ahead never offers a
 * no-op; someone with only a role in it is offered, since they don't.
 * Admin-only; not audited.
 *
 * In SQL rather than the query builder, which has no `or()`. The fragment is a
 * bind parameter with LIKE's own wildcards escaped, so `%` and `_` match
 * themselves, and holders are left out before the limit, so ten matches are
 * ten people who can be granted it.
 */
export async function searchUsersForGrant(
  slug: string,
  query: string,
): Promise<GrantCandidate[]> {
  await admin();
  const parsedSlug = Slug.safeParse(slug);
  const app = parsedSlug.success ? manifestFor(parsedSlug.data) : null;
  if (!app) throw new Error("App not found in registry.");
  // Nobody's name or address is longer than this, so a longer query, or
  // anything that isn't text, matches nobody.
  const parsedQuery = z.string().max(200).safeParse(query);
  if (app.global || !parsedQuery.success) return [];
  const q = parsedQuery.data.trim();
  if (!q) return [];

  const pattern = containsPattern(q);
  const rows = await sql<{ id: string; email: string; display_name: string | null }[]>`
    select u.id, u.email, u.display_name
      from public.users u
     where (u.email ilike ${pattern} escape '!' or u.display_name ilike ${pattern} escape '!')
       and not exists (
         select 1 from public.user_app_grants g
          where g.user_id = u.id and g.app_slug = ${app.slug} and ${isGrant()}
       )
     order by lower(coalesce(nullif(u.display_name, ''), u.email)), u.email
     limit 10
  `;
  return rows.map((u) => ({
    userId: u.id,
    name: u.display_name || u.email,
    email: u.email,
  }));
}

// ── Changing ────────────────────────────────────────────────────────────────

/**
 * Grant an app to one user, with a role, or null to follow the app's
 * `defaultRole`.
 *
 * Refused for a global app, which every user already holds and which cannot be
 * granted per person, and while a connector the app requires isn't ready: an
 * app whose connector refuses every call is not something to hand anyone.
 *
 * Someone with only a role in the app (it was global when they got it) is
 * granted it, with the role given here, and the row records who granted it.
 * Someone who already holds it is left exactly as they are, role included,
 * and `changed: false` says so: a second click, or a page from before another
 * admin granted it, must not reset a role an admin assigned.
 */
export async function grantAppAccess(
  slug: string,
  userId: string,
  role: string | null = null,
): Promise<AccessResult> {
  const actor = await admin();
  const input = Target.extend({ role: Role }).safeParse({ slug, userId, role });
  if (!input.success) return INVALID;
  const app = manifestFor(input.data.slug);
  if (!app) return NOT_IN_BUILD;
  if (app.global) {
    return refused(`Everyone already has ${app.name}. A global app isn't granted one person at a time.`);
  }
  const badRole = roleProblem(app, input.data.role);
  if (badRole) return badRole;

  const missing = await getMissingTenantConfigConnectors(app.slug);
  if (missing.length > 0) {
    return refused(`${missingConnectorSteps(missing)} before granting ${app.name}.`);
  }

  if ((await userName(input.data.userId)) === null) return refused("That person isn't a user here.");

  // A new row, or a row with only a role made a grant; never a grant already
  // there.
  const written = await sql<{ user_id: string }[]>`
    insert into public.user_app_grants as g (user_id, app_slug, role, granted_by, role_only)
    values (${input.data.userId}, ${app.slug}, ${input.data.role}, ${actor.id}, false)
    on conflict (user_id, app_slug) do update
      set role_only  = false,
          role       = excluded.role,
          granted_by = excluded.granted_by,
          granted_at = now()
      where not ${isGrant()}
    returning g.user_id
  `;
  if (written.length === 0) {
    revalidateAccess();
    return { ok: true, changed: false };
  }
  // Someone has it now: the app no longer needs the reminder that people
  // lost it.
  await sql`
    update public.apps set needs_grants_since = null, needs_grants_reason = null
    where slug = ${app.slug} and needs_grants_since is not null
  `;

  // The question this table exists to answer: who gave this person access to
  // this app, and when.
  await recordAdminAction(
    { id: actor.id, email: actor.email },
    {
      action: "user.grant.add",
      targetType: "user",
      targetId: input.data.userId,
      details: { appSlug: app.slug, role: input.data.role },
    },
  );
  revalidateAccess();
  return { ok: true, changed: true };
}

/**
 * Take an app away from one user. Always allowed for a granted app: an app
 * that stopped working is one you want to be able to take away. That includes
 * an app this build doesn't carry: its grants come back with it otherwise.
 * Someone who doesn't hold it is left as they are, with `changed: false`.
 *
 * The install row and the user's widgets go with the grant. No foreign key ties
 * installs to grants, so that a global app can be installed without a grant, so
 * both are deleted explicitly, the install row first. MCP tokens
 * are left alone on purpose: every tool call re-checks the grant, so this
 * app's tools disappear from a token on its next call without disturbing the
 * user's other apps.
 */
export async function revokeAppAccess(slug: string, userId: string): Promise<AccessResult> {
  const actor = await admin();
  const input = Target.safeParse({ slug, userId });
  if (!input.success) return INVALID;
  const known = await knownApp(input.data.slug);
  if (!known) return refused("That app isn't known here.");
  if (known.manifest?.global) {
    return refused(`Everyone has ${known.name}. A global app isn't revoked one person at a time.`);
  }

  const { userId: user, slug: target } = input.data;
  const held = await sql`
    select 1 from public.user_app_grants g
     where g.user_id = ${user} and g.app_slug = ${target} and ${isGrant()}
  `;
  if (held.length === 0) {
    revalidateAccess();
    return { ok: true, changed: false };
  }

  const { error: installErr } = await createServiceClient()
    .from("user_apps")
    .delete()
    .match({ user_id: user, app_slug: target });
  if (installErr) throw new Error("Could not remove the app from their dashboard.");
  const revoked = await sql`
    delete from public.user_app_grants g
     where g.user_id = ${user} and g.app_slug = ${target} and ${isGrant()}
    returning g.user_id
  `;
  await removeAppWidgetsForUser(user, target);
  // Revoked by someone else since the read: nothing more to record.
  if (revoked.length === 0) {
    revalidateAccess();
    return { ok: true, changed: false };
  }

  await recordAdminAction(
    { id: actor.id, email: actor.email },
    {
      action: "user.grant.revoke",
      targetType: "user",
      targetId: input.data.userId,
      details: { appSlug: input.data.slug, ...(known.manifest ? {} : { notInBuild: true }) },
    },
  );
  revalidateAccess();
  return { ok: true, changed: true };
}

/**
 * Set one user's role in an app, or pass null to fall back to `defaultRole`.
 *
 * A ROLE IS NEVER ACCESS. On a global app, a role for someone with no grant
 * is written on a row that records only the role: `global` decides who gets
 * in, and if the app stops being global the role grants nothing. Someone with
 * a grant from before the app went global keeps it, with the role set on it.
 *
 * On any other app it changes the role of an existing grant, and refuses when
 * there is none, since writing a grant here would hand access over as a side
 * effect of a role change, with no connector check and no "grant" in the
 * audit trail. A role left from when the app was global can be cleared, with
 * null, but not changed: grant the app first.
 *
 * Each change is one statement that says whether it changed anything, so a
 * grant revoked between the page's read and this call is no change, and isn't
 * recorded as one.
 */
export async function setAppRoleAction(
  slug: string,
  userId: string,
  role: string | null,
): Promise<AccessResult> {
  const actor = await admin();
  const input = Target.extend({ role: Role }).safeParse({ slug, userId, role });
  if (!input.success) return INVALID;
  const app = manifestFor(input.data.slug);
  if (!app) return NOT_IN_BUILD;
  const badRole = roleProblem(app, input.data.role);
  if (badRole) return badRole;

  const user = input.data.userId;
  const next = input.data.role;
  let changed: boolean;
  if (app.global) {
    if ((await userName(user)) === null) return refused("That person isn't a user here.");
    if (next !== null) {
      // A row with only the role, or the role set on the grant there is.
      const written = await sql`
        insert into public.user_app_grants as g (user_id, app_slug, role, role_only)
        values (${user}, ${app.slug}, ${next}, true)
        on conflict (user_id, app_slug) do update
          set role = excluded.role, role_only = not ${isGrant()}
          where g.role is distinct from excluded.role
        returning g.user_id
      `;
      changed = written.length > 0;
    } else {
      // The default needs nothing stored: a row with only a role goes, and a
      // grant keeps being one, with no role of its own.
      const cleared = await sql`
        delete from public.user_app_grants g
         where g.user_id = ${user} and g.app_slug = ${app.slug} and not ${isGrant()}
        returning g.user_id
      `;
      const defaulted =
        cleared.length > 0
          ? cleared
          : await sql`
              update public.user_app_grants g set role = null
               where g.user_id = ${user} and g.app_slug = ${app.slug}
                 and g.role is not null and ${isGrant()}
              returning g.user_id
            `;
      changed = defaulted.length > 0;
    }
  } else {
    const updated = await sql`
      update public.user_app_grants g set role = ${next}
       where g.user_id = ${user} and g.app_slug = ${app.slug}
         and g.role is distinct from ${next} and ${isGrant()}
      returning g.user_id
    `;
    // Clearing the role kept from when the app was global deletes its row.
    const cleared =
      updated.length === 0 && next === null
        ? await sql`
            delete from public.user_app_grants g
             where g.user_id = ${user} and g.app_slug = ${app.slug} and not ${isGrant()}
            returning g.user_id
          `
        : [];
    changed = updated.length > 0 || cleared.length > 0;
    if (!changed) {
      // Nothing changed: say why, or that the role already was this one.
      const [row] = await sql<{ held: boolean }[]>`
        select ${isGrant()} as held from public.user_app_grants g
         where g.user_id = ${user} and g.app_slug = ${app.slug}
      `;
      if (!row) return refused(`Grant this person ${app.name} before setting their role.`);
      if (!row.held) {
        return refused(`This person has a role in ${app.name} but no access. Grant it first.`);
      }
    }
  }

  if (changed) {
    await recordAdminAction(
      { id: actor.id, email: actor.email },
      {
        action: "user.role.set",
        targetType: "user",
        targetId: user,
        details: { appSlug: app.slug, role: next },
      },
    );
  }
  revalidateAccess();
  return { ok: true, changed };
}
