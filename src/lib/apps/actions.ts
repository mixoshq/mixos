/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use server";

import { createServiceClient } from "@/lib/db/server";
import { requireServerSession } from "@/lib/auth/session";
import { getUserById, hasAppGrant } from "@/lib/apps/access";
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

  return (
    data?.map((r: { app_slug: string; pinned: boolean }) => ({
      slug: r.app_slug,
      pinned: r.pinned,
    })) ?? []
  );
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

export async function reorderMyApps(orderedSlugs: string[]): Promise<void> {
  const session = await requireServerSession();
  const dbUser = await getUserById(session.user.id);
  if (!dbUser) throw new Error("User not found");

  const supa = createServiceClient();
  const { data, error: fetchError } = await supa
    .from("user_apps")
    .select("app_slug")
    .eq("user_id", dbUser.id);
  if (fetchError) throw new Error(fetchError.message);

  const installed = new Set(
    (data ?? []).map((r: { app_slug: string }) => r.app_slug),
  );
  if (orderedSlugs.length !== installed.size) {
    throw new Error("Reorder list does not match installed apps");
  }
  const seen = new Set<string>();
  for (const slug of orderedSlugs) {
    if (!installed.has(slug)) {
      throw new Error(`Unknown app in reorder: ${slug}`);
    }
    if (seen.has(slug)) {
      throw new Error(`Duplicate app in reorder: ${slug}`);
    }
    seen.add(slug);
  }

  for (let i = 0; i < orderedSlugs.length; i++) {
    const { error: updateError } = await supa
      .from("user_apps")
      .update({ position: i })
      .match({ user_id: dbUser.id, app_slug: orderedSlugs[i] });
    if (updateError) throw new Error(updateError.message);
  }

  revalidatePath("/apps");
  revalidatePath("/");
}
