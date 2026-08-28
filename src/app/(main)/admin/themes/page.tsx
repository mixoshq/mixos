/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { revalidatePath } from "next/cache";
import { requireReadOnlySession } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/apps/access";
import { themeRegistry } from "@/generated/theme-registry";
import { getActiveTheme, setActiveTheme } from "@/lib/themes/active";
import ThemeRegistryList from "@/components/admin/theme-registry-list";

export const metadata = { title: "Themes" };

export default async function ThemesAdminPage() {
  const session = await requireReadOnlySession();
  const adminUser = await requireAdmin(session);
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
      <h1 className="text-2xl font-bold text-foreground">Themes</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Signed in as {adminUser.email}. Themes are authored in{" "}
        <code className="font-mono text-xs">themes/</code> and ship with a
        deploy; the build verifies every colour pair against WCAG AA before one
        can be installed. Each theme is a single palette — a dark look is a
        theme you select here, not a mode you switch inside another one.
      </p>

      <ThemeRegistryList
        themes={themeRegistry}
        activeSlug={theme.slug}
        action={apply}
      />
    </div>
  );
}
