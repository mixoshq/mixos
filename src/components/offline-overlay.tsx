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
 * Platform-wide offline screen. When the browser goes offline a full-screen
 * overlay takes over the authenticated app; when the `online` event fires it
 * unmounts and the still-mounted app resumes exactly where it was (no reload).
 * Mounted only in the (main) layout, so it never shows on the login screen or
 * the public customer pages (/p/...).
 *
 * Deliberately text-only. It previously rendered an image, which had to be
 * precached by a service worker to be available at the one moment the overlay
 * exists — the network being down. Text needs no such machinery.
 */
export default function OfflineOverlay() {
  const online = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  if (online) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="You're offline"
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-3 bg-mixcharcoal px-6 text-center text-white"
    >
      <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl">
        Offline
      </h1>
      <p className="text-sm text-white/60">
        No internet connection — we&apos;ll pick right back up as soon as
        you&apos;re reconnected.
      </p>
    </div>,
    document.body,
  );
}
