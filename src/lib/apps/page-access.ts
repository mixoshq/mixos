/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AppManifest, RouteAuth } from "./types";

export interface PageAccessLookups {
  hasAppGrant: (userId: string, appSlug: string) => Promise<boolean>;
  isAppActive: (appSlug: string) => Promise<boolean>;
}

/**
 * Whether `/apps/<appSlug>/<pageKey>` may render for the signed-in user
 * `userId`.
 *
 * A page accepts `["session"]` unless `pageVisibility` says otherwise, and
 * `session` means a user holding the app's grant. A page that accepts
 * `signed-in` is for any signed-in user, grant or not, as the same tier is on
 * an API route. It still needs the app to be active, because a deactivated app
 * serves nothing at any tier. Pages accepting only `public` or `password` are
 * served from `/p/<slug>/...`, and need the grant here.
 *
 * The lookups are parameters so the rule can be tested without a session or a
 * database.
 */
export async function canOpenAppPage(
  manifest: Pick<AppManifest, "slug" | "pageVisibility">,
  pageKey: string,
  userId: string,
  lookups: PageAccessLookups,
): Promise<boolean> {
  const accepted: readonly RouteAuth[] =
    manifest.pageVisibility?.[pageKey] ?? ["session"];
  if (accepted.includes("signed-in")) {
    return lookups.isAppActive(manifest.slug);
  }
  return lookups.hasAppGrant(userId, manifest.slug);
}
