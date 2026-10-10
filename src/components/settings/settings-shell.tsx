/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { getReadOnlySession } from "@/lib/auth/session";
import { describeBuild } from "@/lib/platform/version";
import SettingsNav from "./settings-nav";

/**
 * The shell every settings page shares: one sidebar on the left, the page at
 * full width on the right.
 *
 * WHY A COMPONENT AND NOT THREE LAYOUTS. Administration, the account pages and
 * App Manager are one area to a user — the sidebar links across all three — but
 * they live under three unrelated route segments, and `/apps` cannot take a
 * layout at all because `/apps/[appSlug]` renders installed apps beneath it. A
 * shared component is what lets the three agree without a route move.
 */
export default async function SettingsShell({
  children,
  showBuild = false,
}: {
  children: React.ReactNode;
  /**
   * Name the MixOS version and commit under the page. The admin layout asks for
   * it, and it renders for admins only, checked here rather than left to the
   * page: a layout renders alongside its page, so the page's own admin check
   * does not stop it.
   */
  showBuild?: boolean;
}) {
  const session = await getReadOnlySession();
  const isAdmin = session?.user.isAdmin === true;

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <div className="grid grid-cols-1 gap-8 md:grid-cols-[220px_1fr]">
        <SettingsNav isAdmin={isAdmin} />
        <div className="min-w-0">{children}</div>
      </div>
      <footer className="mt-12 space-y-1 text-center text-xs text-muted-foreground">
        {showBuild && isAdmin && <p>{describeBuild()}</p>}
        <p>Made in Detroit with 🫶🏽</p>
      </footer>
    </div>
  );
}
