/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use server";

import { z } from "zod";
import { getUserById } from "@/lib/apps/access";
import { getReadOnlySession } from "@/lib/auth/session";
import { markReleaseNotesSeen, recentReleaseNotesFor } from "./server";
import type { RecentReleaseNoteGroup } from "./types";

/**
 * The menu bar's release notes for whoever is signed in (./server.ts). None
 * without a session: the menu bar is not where a lapsed one is dealt with, and
 * the page it sits on redirects on its own.
 */
export async function getMyRecentReleaseNotes(): Promise<RecentReleaseNoteGroup[]> {
  const session = await getReadOnlySession();
  if (!session) return [];
  const user = await getUserById(session.user.id);
  if (!user) return [];
  return recentReleaseNotesFor(user.id);
}

/** As many ids as one batch from the menu bar can carry, each as long as an id can be. */
const SeenIdsSchema = z.array(z.string().min(1).max(200)).max(200);

/**
 * Mark notes seen for whoever is signed in. The ids come from the browser, so
 * they are checked here and again against the build (markReleaseNotesSeen()).
 * Revalidates nothing: a note seen changes nothing else on the page, and a
 * re-render on every hover would cost the page it sits on.
 */
export async function markMyReleaseNotesSeen(input: { ids?: unknown }): Promise<void> {
  const ids = SeenIdsSchema.safeParse(input?.ids);
  if (!ids.success || ids.data.length === 0) return;
  const session = await getReadOnlySession();
  if (!session) return;
  const user = await getUserById(session.user.id);
  if (!user) return;
  await markReleaseNotesSeen(user.id, ids.data);
}
