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
