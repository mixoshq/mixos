/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The slim banner over every page of the interface, for admins, when a newer
 * release of MixOS is out (src/components/admin/release-banner.tsx):
 *
 *   MixOS v0.3.0 is out (you run v0.2.0). Run /mixos upgrade in Claude Code
 *   to upgrade.  [Copy]  Details  [×]
 *
 * It shows exactly when the admin pages' notice does, from the same stored
 * answer (./releases.ts, describeRelease()), never from the network: so never
 * with the update check off or before it has answered, and never to anyone but
 * an admin. It isn't in the public, app-password or sign-in pages' layouts at
 * all.
 *
 * Dismissing it lasts until the next release, per admin: an HttpOnly cookie
 * holding the admin's user id and the release's tag. A cookie, not a column on
 * `users`, because the server reads it in the same request, with no query, and
 * renders nothing rather than a banner that vanishes after load; and because a
 * new column would be a platform migration, which keeps every instance on the
 * maintenance page until its release step runs, for a dismissed banner. It is
 * per browser, then: dismissing on one doesn't dismiss on another. The admin
 * pages' notice ignores it.
 */

import type { ReleaseNotice } from "./releases";

/** The dismissal's cookie. Its value is `<user id>:<tag>`. */
export const RELEASE_BANNER_COOKIE = "mixos-release-banner";

/** A year. Chrome keeps a cookie at most 400 days; a newer release shows the banner again whatever it holds. */
export const RELEASE_BANNER_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

/** What the cookie holds once the admin `userId` dismissed the banner for `tag`. */
export function dismissalFor(userId: string, tag: string): string {
  return `${userId}:${tag}`;
}

export interface ReleaseBanner {
  /** The newer release: `v0.3.0`. */
  tag: string;
  /** This build's version, as a tag: `v0.2.0`. */
  current: string;
}

/**
 * The banner a request calls for, or null: an admin, a notice the stored
 * answer calls for (null with the check off, before it has answered, or with
 * nothing newer on the channel), and no dismissal by this admin of this
 * release.
 */
export function releaseBannerFor(input: {
  isAdmin: boolean;
  userId: string | null;
  notice: ReleaseNotice | null;
  /** This build's version, `0.2.0`. */
  current: string;
  /** The cookie's value, if there is one. */
  dismissed: string | undefined;
}): ReleaseBanner | null {
  const { isAdmin, userId, notice } = input;
  if (!isAdmin || !userId || !notice) return null;
  if (input.dismissed === dismissalFor(userId, notice.tag)) return null;
  return { tag: notice.tag, current: `v${input.current}` };
}
