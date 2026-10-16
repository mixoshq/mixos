/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use server";

import { createServiceClient } from "@/lib/db/server";
import { requireServerSession } from "@/lib/auth/session";
import { filterHeldApps, getUserById, hasAppGrant } from "@/lib/apps/access";
import { removeAppWidgetsForUser } from "@/lib/dashboard/cleanup";
import { revalidatePath } from "next/cache";

export async function getMyApps(): Promise<string[]> {
  const session = await requireServerSession();
  const dbUser = await getUserById(session.user.id);
  if (!dbUser) return [];

  const supa = createServiceClient();
  const { data } = await supa
    .from("user_apps")
    .select("app_slug, position")
    .eq("user_id", dbUser.id)
    .order("position", { ascending: true })
    .order("app_slug", { ascending: true });

  return data?.map((r: { app_slug: string }) => r.app_slug) ?? [];
}

export type InstalledApp = { slug: string; pinned: boolean };

/**
 * The user's installed apps with their pinned state, in persisted order
 * (position then slug). Pinned apps drive the inline menu-bar order; the Apps
 * dropdown lists them all.
 *
 * Only apps the user still holds: an install outlives the access behind it
 * when an app is deactivated or stops being global, and a menu entry that
 * opens onto a refusal is worse than none.
 */
export async function getMyInstalledApps(): Promise<InstalledApp[]> {
  const session = await requireServerSession();
  const dbUser = await getUserById(session.user.id);
  if (!dbUser) return [];

  const supa = createServiceClient();
  const { data } = await supa
    .from("user_apps")
    .select("app_slug, position, pinned")
    .eq("user_id", dbUser.id)
    .order("position", { ascending: true })
    .order("app_slug", { ascending: true });

  const rows = (data ?? []) as { app_slug: string; pinned: boolean }[];
  const held = new Set(await filterHeldApps(dbUser.id, rows.map((r) => r.app_slug)));
  return rows
    .filter((r) => held.has(r.app_slug))
    .map((r) => ({ slug: r.app_slug, pinned: r.pinned }));
}

/**
 * Pin or unpin an installed app. Pinning promotes it into the menu bar;
 * unpinning drops it back to the Apps dropdown only. Install state is
 * unaffected — the row must already exist for this user.
 */
export async function setMyAppPinned(
  slug: string,
  pinned: boolean,
): Promise<void> {
  const session = await requireServerSession();
  const dbUser = await getUserById(session.user.id);
  if (!dbUser) throw new Error("User not found");

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("user_apps")
    .update({ pinned })
    .match({ user_id: dbUser.id, app_slug: slug })
    .select("app_slug");
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) {
    throw new Error(`App ${slug} is not installed`);
  }

  revalidatePath("/apps");
  revalidatePath("/");
}

export async function toggleMyAppInstall(
  slug: string,
  currentlyInstalled: boolean,
) {
  const session = await requireServerSession();
  const dbUser = await getUserById(session.user.id);
  if (!dbUser) throw new Error("User not found");

  const supa = createServiceClient();

  if (currentlyInstalled) {
    const { error } = await supa.from("user_apps").delete().match({
      user_id: dbUser.id,
      app_slug: slug,
    });
    if (error) throw new Error(error.message);

    await removeAppWidgetsForUser(dbUser.id, slug);
  } else {
    // Installing requires an active grant. The FK would reject the insert
    // anyway, but checking first gives a clearer error for a UI that
    // somehow shows an ungranted app.
    const granted = await hasAppGrant(dbUser.id, slug);
    if (!granted) {
      throw new Error(
        `You have not been granted access to ${slug}. Ask an admin.`,
      );
    }

    const { data: existing } = await supa
      .from("user_apps")
      .select("position")
      .eq("user_id", dbUser.id);
    const positions = (existing ?? []).map(
      (r: { position: number }) => r.position,
    );
    const nextPosition =
      positions.length > 0 ? Math.max(...positions) + 1 : 0;

    const { error } = await supa.from("user_apps").upsert({
      user_id: dbUser.id,
      app_slug: slug,
      position: nextPosition,
    });
    if (error) throw new Error(error.message);
  }

  revalidatePath("/apps");
  revalidatePath("/");
}

/**
 * Put the user's apps in a new order, as the menu bar sends it: the apps
 * `getMyInstalledApps()` lists, which are the ones they hold.
 *
 * An install of an app they don't hold (switched off, out of the build, or
 * no longer theirs) isn't listed, so it isn't in the new order either. It
 * keeps its place among the others: the held apps take the places the held
 * apps had, in the order given, and every install is numbered again from 0.
 */
export async function reorderMyApps(orderedSlugs: string[]): Promise<void> {
  const session = await requireServerSession();
  const dbUser = await getUserById(session.user.id);
  if (!dbUser) throw new Error("User not found");

  const supa = createServiceClient();
  const { data, error: fetchError } = await supa
    .from("user_apps")
    .select("app_slug, position")
    .eq("user_id", dbUser.id)
    .order("position", { ascending: true })
    .order("app_slug", { ascending: true });
  if (fetchError) throw new Error(fetchError.message);

  const order = ((data ?? []) as { app_slug: string }[]).map((r) => r.app_slug);
  const held = new Set(await filterHeldApps(dbUser.id, order));
  const listed = order.filter((slug) => held.has(slug));
  if (orderedSlugs.length !== listed.length) {
    throw new Error("Reorder list does not match installed apps");
  }
  const seen = new Set<string>();
  for (const slug of orderedSlugs) {
    if (!held.has(slug)) {
      throw new Error(`Unknown app in reorder: ${slug}`);
    }
    if (seen.has(slug)) {
      throw new Error(`Duplicate app in reorder: ${slug}`);
    }
    seen.add(slug);
  }

  // The held apps' places, filled in the new order.
  let next = 0;
  const merged = order.map((slug) => (held.has(slug) ? orderedSlugs[next++] : slug));
  for (let i = 0; i < merged.length; i++) {
    const { error: updateError } = await supa
      .from("user_apps")
      .update({ position: i })
      .match({ user_id: dbUser.id, app_slug: merged[i] });
    if (updateError) throw new Error(updateError.message);
  }

  revalidatePath("/apps");
  revalidatePath("/");
}
