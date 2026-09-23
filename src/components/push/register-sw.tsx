/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useEffect } from "react";

/**
 * Registers the platform service worker (`/sw.js`) once, on mount, for every
 * authenticated user. This only installs the worker so it can receive pushes —
 * it does NOT request notification permission. The permission prompt stays
 * user-gesture-driven via `enablePushNotifications()` in the apps SDK.
 */
export default function RegisterServiceWorker() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Registration is best-effort; push simply won't work in this browser.
    });
  }, []);

  return null;
}
