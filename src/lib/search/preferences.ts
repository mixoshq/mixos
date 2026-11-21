/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Each person's search settings, in `public.user_search_preferences`
 * (supabase/migrations/0003_user_search_preferences.sql). Server only.
 */

import { sql } from "@/lib/db/client";
import { DEFAULT_SEARCH_PREFERENCES, type SearchPreferences } from "./types";

interface Row {
  show_icon: boolean;
  shortcut_enabled: boolean;
  source_order: string[];
  disabled_sources: string[];
}

/**
 * The person's settings, or the defaults when they have changed nothing.
 *
 * A read that fails answers the defaults too, and says so in the log: the
 * menu bar is on every page, and a broken settings read should cost the person
 * their custom order, not the page.
 */
export async function getSearchPreferences(userId: string): Promise<SearchPreferences> {
  try {
    const [row] = await sql<Row[]>`
      select show_icon, shortcut_enabled, source_order, disabled_sources
      from public.user_search_preferences
      where user_id = ${userId}
    `;
    if (!row) return DEFAULT_SEARCH_PREFERENCES;
    return {
      showIcon: row.show_icon,
      shortcutEnabled: row.shortcut_enabled,
      order: row.source_order,
      disabled: row.disabled_sources,
    };
  } catch (err) {
    console.error("[search] could not read the search preferences; using the defaults:", err);
    return DEFAULT_SEARCH_PREFERENCES;
  }
}

/** Replace the person's settings. The caller has already checked the values. */
export async function saveSearchPreferences(userId: string, prefs: SearchPreferences): Promise<void> {
  await sql`
    insert into public.user_search_preferences
      (user_id, show_icon, shortcut_enabled, source_order, disabled_sources, updated_at)
    values (${userId}, ${prefs.showIcon}, ${prefs.shortcutEnabled},
            ${prefs.order}::text[], ${prefs.disabled}::text[], now())
    on conflict (user_id) do update
      set show_icon = excluded.show_icon,
          shortcut_enabled = excluded.shortcut_enabled,
          source_order = excluded.source_order,
          disabled_sources = excluded.disabled_sources,
          updated_at = now()
  `;
}
