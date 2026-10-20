/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use server";

import { cookies } from "next/headers";
import { getReadOnlySession } from "@/lib/auth/session";
import { getAppOrigin } from "@/lib/env/origin";
import { isReleaseTag } from "@/lib/github/names";
import { RELEASE_BANNER_COOKIE, RELEASE_BANNER_COOKIE_MAX_AGE, dismissalFor } from "./release-banner";

/**
 * Remember that this admin dismissed the banner for the release `tag`, until a
 * newer one (./release-banner.ts). It sets one cookie and changes nothing
 * else: not the admin pages' notice, and nothing about the release. Anyone but
 * an admin, or a tag that isn't a release's, changes nothing.
 */
export async function dismissReleaseBannerAction(input: { tag?: unknown }): Promise<void> {
  const session = await getReadOnlySession();
  const tag = input?.tag;
  if (session?.user.isAdmin !== true || !isReleaseTag(tag)) return;
  (await cookies()).set(RELEASE_BANNER_COOKIE, dismissalFor(session.user.id, tag), {
    httpOnly: true,
    sameSite: "lax",
    secure: getAppOrigin().startsWith("https:"),
    path: "/",
    maxAge: RELEASE_BANNER_COOKIE_MAX_AGE,
  });
}
