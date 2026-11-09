/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import Link from "next/link";
import { cookies } from "next/headers";
import { ArrowUpCircle } from "lucide-react";
import { RELEASE_BANNER_COOKIE, releaseBannerFor, type ReleaseBanner as Banner } from "@/lib/platform/release-banner";
import { UPGRADE_COMMAND } from "@/lib/platform/releases";
import { releaseCheckViewThisRequest } from "@/lib/platform/release-view";
import { mixosVersion } from "@/lib/platform/version";
import { CopyButton } from "./copy-button";
import ReleaseBannerShell from "./release-banner-shell";
import { RELEASE_NOTICE_ID } from "./release-notice";

/** The full notice: at the top of the first admin page, where /admin goes. */
export const RELEASE_NOTICE_URL = `/admin/apps#${RELEASE_NOTICE_ID}`;

/**
 * The slim banner over every page of the main interface, for admins, when a
 * newer release of MixOS is out (src/lib/platform/release-banner.ts says when).
 * In the admin pages' accent, as their full notice is (./release-notice.tsx).
 * The main layout renders it above the menu bar, with the session it already
 * resolved; for anyone but an admin it returns before reading anything. The
 * release comes from the stored answer, read once per request with the admin
 * pages' notice (src/lib/platform/release-view.ts).
 */
export default async function ReleaseBanner({ isAdmin, userId }: { isAdmin: boolean; userId: string }) {
  if (!isAdmin) return null;
  const { notice } = await releaseCheckViewThisRequest();
  const dismissed = (await cookies()).get(RELEASE_BANNER_COOKIE)?.value;
  const banner = releaseBannerFor({ isAdmin, userId, notice, current: mixosVersion(), dismissed });
  return banner ? <ReleaseBannerView banner={banner} /> : null;
}

/** The banner itself, for `banner`'s release. */
export function ReleaseBannerView({ banner }: { banner: Banner }) {
  return (
    <ReleaseBannerShell tag={banner.tag}>
      <ArrowUpCircle className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3">
        <p className="min-w-0">
          MixOS {banner.tag} is out (you run {banner.current}). Run{" "}
          <code className="rounded border border-border bg-background px-1 font-mono text-[11px]">
            {UPGRADE_COMMAND}
          </code>{" "}
          in Claude Code to upgrade.
        </p>
        <span className="flex items-center gap-x-2">
          <CopyButton text={UPGRADE_COMMAND} label="Copy" compact />
          <Link href={RELEASE_NOTICE_URL} className="font-medium text-primary underline underline-offset-2">
            Details
          </Link>
        </span>
      </div>
    </ReleaseBannerShell>
  );
}
