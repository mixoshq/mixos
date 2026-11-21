/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use server";

import { z } from "zod";
import { getReadOnlySession } from "@/lib/auth/session";
import { getUserById } from "@/lib/apps/access";
import { safeErrorMessage } from "@/lib/safe-error";
import { saveSearchPreferences } from "./preferences";
import type { SearchPreferences } from "./types";

/**
 * A source key: an app slug or `@apps`. Checked for shape only: a key for an
 * app the person doesn't hold is stored and ignored, as an uninstalled app's
 * place in the order is (./types.ts `orderSources`).
 */
const SourceKey = z.string().regex(/^@?[a-z0-9][a-z0-9_-]{0,199}$/);

const PreferencesSchema = z.object({
  showIcon: z.boolean(),
  shortcutEnabled: z.boolean(),
  order: z.array(SourceKey).max(500),
  disabled: z.array(SourceKey).max(500),
});

/**
 * Save the signed-in person's search settings, all of them at once: the page
 * holds the whole state and sends it on each change, so two quick changes
 * can't interleave into a state neither of them asked for.
 *
 * Revalidates nothing: the settings page and the menu bar already show the
 * new state, from the search provider (src/components/search/search-context.tsx).
 */
export async function updateMySearchPreferences(
  input: SearchPreferences,
): Promise<{ error: string | null }> {
  const parsed = PreferencesSchema.safeParse(input);
  if (!parsed.success) return { error: "Those settings couldn't be saved." };
  const session = await getReadOnlySession();
  if (!session) return { error: "Sign in again to change your settings." };
  const user = await getUserById(session.user.id);
  if (!user) return { error: "Sign in again to change your settings." };
  try {
    await saveSearchPreferences(user.id, {
      ...parsed.data,
      order: [...new Set(parsed.data.order)],
      disabled: [...new Set(parsed.data.disabled)],
    });
    return { error: null };
  } catch (err) {
    return { error: safeErrorMessage(err, "Your search settings couldn't be saved.") };
  }
}
