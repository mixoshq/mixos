/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { cache } from "react";
import { createServiceClient } from "@/lib/db/server";
import {
  themeRegistry,
  FALLBACK_THEME,
  getTheme,
} from "@/generated/theme-registry";
import type { ThemeManifest } from "./types";

/**
 * Resolving the active theme for a request.
 *
 * One theme is active for the whole install. That is what makes the signed-out
 * login page, the public `/api/p/` app surfaces, and the favicon coherent —
 * none of them has a current user whose preference could be read.
 *
 * `cache()` dedupes the lookup within a single render pass, so a page with a
 * layout, a header and a dozen server components still makes one query.
 */

const THEME_KEY = "theme";

export interface ActiveTheme {
  theme: ThemeManifest;
}

async function readSettings(): Promise<Record<string, string>> {
  try {
    const supabase = createServiceClient();
    const { data } = await supabase
      .from("platform_settings")
      .select("key, value")
      .in("key", [THEME_KEY]);
    return Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
  } catch {
    // A theme is not worth a 500. An unreachable database on the login page
    // should render an unstyled-but-correct page, not an error — so fall back
    // to what the build bundled rather than propagating.
    return {};
  }
}

export const getActiveTheme = cache(async (): Promise<ActiveTheme> => {
  const settings = await readSettings();

  // A slug that is no longer installed resolves to the fallback rather than to
  // nothing: uninstalling a theme must not leave the platform with no colours.
  const slug = settings[THEME_KEY];
  const installed = themeRegistry.some((t) => t.slug === slug);
  return { theme: getTheme(installed ? slug : FALLBACK_THEME) };
});

/**
 * Admin-only. The caller is responsible for `requireAdmin()`.
 *
 * Writes into `public.platform_settings`, which predates this feature and
 * already holds `scheduler_enabled`. The `theme_mode` key this used to write
 * alongside is gone: a theme has one palette, so the theme slug is the whole
 * appearance decision. Nothing seeds that key, so there is no row to migrate —
 * any left behind on an install is simply never read again.
 */
export async function setActiveTheme(slug: string): Promise<void> {
  if (!themeRegistry.some((t) => t.slug === slug)) {
    throw new Error(`Unknown theme "${slug}".`);
  }
  const supabase = createServiceClient();
  await supabase
    .from("platform_settings")
    .upsert([{ key: THEME_KEY, value: slug, updated_at: new Date().toISOString() }], {
      onConflict: "key",
    });
}
