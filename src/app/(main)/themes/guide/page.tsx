/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { requireReadOnlySession } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/apps/access";
import GuidePage from "@/components/guide-page";
import { loadThemeGuideTabs } from "@/components/themes/theme-guide-tabs";

export default async function ThemeGuidePage() {
  const session = await requireReadOnlySession();
  await requireAdmin(session);

  return (
    <GuidePage
      title="How to Create a Theme"
      back={{ href: "/admin/themes", label: "Themes" }}
      intro={
        <>
          A theme is the single palette every page and app in this instance is
          rendered with. Themes live in the{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-sm">/themes</code>{" "}
          directory and ship with a deploy; the build verifies every colour pair
          against WCAG AA before one can be installed.
        </>
      }
      command="/mix-theme"
      usage="/mix-theme create my-theme optional brand book path or notes"
      tabs={await loadThemeGuideTabs()}
    />
  );
}
