/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import Link from "next/link";
import { revalidatePath } from "next/cache";
import { requireReadOnlySession } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/apps/access";
import { themeRegistry } from "@/generated/theme-registry";
import { getActiveTheme, setActiveTheme } from "@/lib/themes/active";
import ThemeRegistryList from "@/components/admin/theme-registry-list";

export const metadata = { title: "Themes" };

export default async function ThemesAdminPage() {
  const session = await requireReadOnlySession();
  await requireAdmin(session);
  const { theme } = await getActiveTheme();

  async function apply(slug: string) {
    "use server";
    // Re-authorize inside the action. The page's own check guards the render;
    // a server action is a separate entry point and must not trust it.
    const s = await requireReadOnlySession();
    await requireAdmin(s);
    await setActiveTheme(slug);
    // The theme is stamped on <html> in the root layout, so every route in the
    // app is downstream of this value.
    revalidatePath("/", "layout");
  }

  return (
    // No width of its own: the admin layout owns the content column, and a page
    // that re-centres itself inside it sits narrower than its siblings for no
    // reason a reader can see. It was the only admin page doing this.
    <div>
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Themes</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose the single palette every page and app in this instance is
            rendered with.
          </p>
        </div>
        <Link
          href="/themes/guide"
          className="shrink-0 inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-foreground shadow-sm hover:bg-brand/90"
        >
          How to create a theme
        </Link>
      </div>

      <ThemeRegistryList
        themes={themeRegistry}
        activeSlug={theme.slug}
        action={apply}
      />
    </div>
  );
}
