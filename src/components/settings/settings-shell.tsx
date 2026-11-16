/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import ReleaseNotice, { ReleaseCheckStatus } from "@/components/admin/release-notice";
import { getReadOnlySession } from "@/lib/auth/session";
import { mixosUpdateOffer } from "@/lib/github/update-pull";
import { releaseCheckViewThisRequest } from "@/lib/platform/release-view";
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
   * Name the MixOS version and commit under the page, with the release check's
   * line, and put a notice above the page when a newer release of MixOS is
   * out. The admin layout asks for it, and it renders for admins only, checked
   * here rather than left to the page: a layout renders alongside its page, so
   * the page's own admin check does not stop it.
   */
  showBuild?: boolean;
}) {
  const session = await getReadOnlySession();
  const isAdmin = session?.user.isAdmin === true;
  // From the stored answer, never the network: read once per request, for both
  // places here and the banner over the page.
  const releases = showBuild && isAdmin ? await releaseCheckViewThisRequest() : null;
  // What the GitHub App offers for the release, from what is stored alone.
  const offer = releases?.notice ? await mixosUpdateOffer(releases.notice) : null;

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <div className="grid grid-cols-1 gap-8 md:grid-cols-[220px_1fr]">
        <SettingsNav isAdmin={isAdmin} />
        <div className="min-w-0">
          {releases?.notice && <ReleaseNotice notice={releases.notice} offer={offer} />}
          {children}
        </div>
      </div>
      <footer className="mt-12 space-y-1 text-center text-xs text-muted-foreground">
        {showBuild && isAdmin && <p>{describeBuild()}</p>}
        {releases?.status && <ReleaseCheckStatus status={releases.status} checkNow={releases.canCheckNow} />}
        <p>Made in Detroit with 🫶🏽</p>
      </footer>
    </div>
  );
}
