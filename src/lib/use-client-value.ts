/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useSyncExternalStore } from "react";

/**
 * Read a browser-only value without a hydration mismatch.
 *
 * The tempting shape — `useState(false)` plus an effect that sets the real value
 * — renders the fallback on the server, the real value on the client, and asks
 * React to reconcile the difference. React's lint rule calls that out as a
 * cascading render, and `docs/apps/app-shell.md` documents the same trap for
 * `localStorage`.
 *
 * `useSyncExternalStore` is the sanctioned answer: SSR and the first client
 * render both produce `serverFallback`, and the real value arrives on hydration.
 *
 * `read` MUST return a stable value — a primitive, or a memoized object.
 * Returning a fresh object each call makes React re-render forever.
 */
export function useClientValue<T>(read: () => T, serverFallback: T): T {
  return useSyncExternalStore(subscribeNever, read, () => serverFallback);
}

/** No subscription: these values do not change without a reload or an event we
 *  already re-render for. */
function subscribeNever(): () => void {
  return () => {};
}
