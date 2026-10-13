/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Suspense } from "react";
import Link from "next/link";
import { ExternalLink, Store } from "lucide-react";
import { revalidatePath } from "next/cache";
import { requireReadOnlySession } from "@/lib/auth/session";
import { docsUrl } from "@/lib/docs";
import { requireAdmin } from "@/lib/apps/access";
import { installEnabled } from "@/lib/repository/policy";
import { themeRegistry } from "@/generated/theme-registry";
import { getActiveTheme, setActiveTheme } from "@/lib/themes/active";
import ThemeRegistryList from "@/components/admin/theme-registry-list";
import RegistryNotices from "@/components/admin/registry-notices";
import ProposedPullRequests from "@/components/admin/github/proposed-pull-requests";

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
    const admin = await requireAdmin(s);
    // Audited as theme.apply, with this admin as the actor.
    await setActiveTheme(slug, { id: admin.id, email: admin.email });
    // The theme is stamped on <html> in the root layout, so every route in the
    // app is downstream of this value.
    revalidatePath("/", "layout");
  }

  return (
    // No width of its own: the admin layout owns the content column, and a page
    // that re-centres itself inside it sits narrower than its siblings for no
    // reason a reader can see. It was the only admin page doing this.
    <div>
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between lg:gap-0">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Themes</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose the single palette every page and app in this instance is
            rendered with.
          </p>
        </div>
        {/*
          Two actions, and the order is the point: Browse reaches the mixos.org
          repository, which is where an admin who wants a theme they do not
          have goes first. The docs are for the case where nobody has built it
          yet, so they keep the brand fill and the second position rather than
          competing with the action most visits to this page want. They open on
          mixos.org in a new tab: the in-app copy at /themes/guide still exists but
          is no longer linked, so the site is the one place the guide is current.

          Browse is absent when installing this kind is turned off
          (lib/repository/policy.ts); the page it leads to is a 404 then anyway.
        */}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {installEnabled("theme") && (
            <Link
              href="/admin/themes/browse"
              className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground shadow-sm hover:bg-muted"
            >
              <Store className="h-4 w-4" aria-hidden />
              Browse Themes
            </Link>
          )}
          <a
            href={docsUrl("extending/themes")}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-foreground shadow-sm hover:bg-brand/90"
          >
            How to create a theme
            <ExternalLink className="h-4 w-4" aria-hidden />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </div>
      </div>
      <RegistryNotices kind="theme" />
      {/* Read from GitHub: the rest of the page doesn't wait for it. */}
      <Suspense fallback={null}>
        <ProposedPullRequests kind="theme" />
      </Suspense>

      <ThemeRegistryList
        themes={themeRegistry}
        activeSlug={theme.slug}
        action={apply}
      />
    </div>
  );
}
