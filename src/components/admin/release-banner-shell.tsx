/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { IconButton } from "@/components/ui/button";
import { dismissReleaseBannerAction } from "@/lib/platform/release-banner-actions";

/**
 * The banner's frame and its one control: dismiss, until the next release.
 * It goes at once; the cookie the action sets keeps it gone on the next page
 * (src/lib/platform/release-banner.ts). If the action fails, the banner is
 * back on the next page, and nothing else is lost.
 */
export default function ReleaseBannerShell({ tag, children }: { tag: string; children: ReactNode }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <section
      aria-label="A newer release of MixOS"
      data-release-banner={tag}
      className="shrink-0 border-b border-border bg-card text-sm text-foreground"
    >
      <div className="flex items-start gap-2 px-4 py-1.5 sm:px-6 lg:px-8">
        {children}
        <IconButton
          variant="ghost"
          size="sm"
          label="Dismiss until the next release"
          icon={<X className="h-4 w-4" aria-hidden />}
          onClick={() => {
            setDismissed(true);
            dismissReleaseBannerAction({ tag }).catch(() => {});
          }}
        />
      </div>
    </section>
  );
}
