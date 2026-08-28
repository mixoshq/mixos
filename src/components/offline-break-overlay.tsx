/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

/** Re-render whenever the browser's connectivity flips. */
function subscribe(callback: () => void): () => void {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

// Client reads the live flag; the server assumes online so SSR renders nothing
// (no flash, no hydration mismatch) — same guard idiom as welcome-modal.tsx.
const getSnapshot = () => navigator.onLine;
const getServerSnapshot = () => true;

/**
 * Platform-wide "we're on a break" screen. When the browser goes offline, a
 * full-screen overlay takes over the authenticated app; when the `online` event
 * fires it unmounts and the still-mounted app resumes exactly where it was (no
 * reload). Mounted only in the (main) layout, so it never shows on the login
 * screen or the public customer pages (/p/...).
 */
export default function OfflineBreakOverlay() {
  const online = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  if (online) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="You're offline"
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-8 bg-brand px-6 text-center text-brand-foreground"
    >
      <h1 className="text-4xl font-extrabold tracking-tight sm:text-6xl">
        WE&apos;RE ON A <span className="text-brand-accent">BREAK!</span>
      </h1>
      {/* Raw <img> with a root-absolute src (public/we_are_on_a_break.png),
          matching the asset convention in src/components/dashboard/grid.tsx.
          Deliberately NOT next/image: that routes through /_next/image, which
          is a server round-trip and therefore unreachable at the only moment
          this overlay exists. The file itself is precached by public/sw.js so
          it is already on the device when the network drops. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/we_are_on_a_break.png"
        alt="We're on a break"
        width={800}
        height={400}
        className="max-h-[70vh] w-auto max-w-full rounded-xl shadow-2xl"
      />
      <p className="text-sm text-white/60">
        No internet connection — we&apos;ll pick right back up as soon as
        you&apos;re reconnected.
      </p>
    </div>,
    document.body,
  );
}
