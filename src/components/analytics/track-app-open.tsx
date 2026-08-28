/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useEffect } from "react";

/**
 * Fire-and-forget beacon that records an "app opened" analytics event when an
 * app page mounts for the user. Firing on mount (rather than server-side) means
 * Next.js prefetches and server re-renders don't inflate open counts — only a
 * real render in the user's browser is counted. Renders nothing.
 */
export default function TrackAppOpen({ appSlug }: { appSlug: string }) {
  useEffect(() => {
    fetch("/api/analytics/app-open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appSlug }),
      keepalive: true,
    }).catch(() => {
      // Analytics is best-effort; never surface failures to the user.
    });
  }, [appSlug]);

  return null;
}
