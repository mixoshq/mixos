/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

/**
 * A `localStorage`-backed store that React can read without a hydration
 * mismatch.
 *
 * The tempting shape — `useState(defaults)` plus an effect that reads storage
 * and calls `setState` — renders the default on the server and the stored value
 * on the client, which React's lint rule flags as a cascading render and
 * `docs/apps/app-shell.md` documents as a hydration trap.
 *
 * Two details make this safe with `useSyncExternalStore`:
 *
 * - **The snapshot is cached against the raw string.** `getSnapshot` runs on
 *   every render, and returning a freshly-parsed object each time would give
 *   React a new identity every render and loop forever. Re-parsing only when the
 *   raw text actually changed keeps the identity stable.
 * - **The server snapshot is a fixed object**, not a fresh `{...defaults}`, for
 *   the same reason.
 *
 * The `storage` event subscription is a bonus the effect version never had: two
 * open tabs stay in step.
 */
export interface LocalStore<T> {
  read: () => T;
  write: (next: T) => void;
  subscribe: (onChange: () => void) => () => void;
  server: () => T;
}

export function createLocalStore<T>(
  key: string,
  defaults: T,
  parse: (raw: unknown) => T,
): LocalStore<T> {
  let cachedRaw: string | null = null;
  let cached: T = defaults;
  let primed = false;
  const listeners = new Set<() => void>();

  function read(): T {
    if (typeof window === "undefined") return defaults;
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(key);
    } catch {
      // Private mode, blocked site data, or a browser that throws on access.
      return defaults;
    }
    if (primed && raw === cachedRaw) return cached;
    cachedRaw = raw;
    primed = true;
    if (raw == null) {
      cached = defaults;
      return cached;
    }
    try {
      cached = parse(JSON.parse(raw));
    } catch {
      cached = defaults;
    }
    return cached;
  }

  function write(next: T): void {
    cached = next;
    primed = true;
    try {
      cachedRaw = JSON.stringify(next);
      window.localStorage.setItem(key, cachedRaw);
    } catch {
      // Storage may be unavailable; the in-memory value still stands for this
      // tab, which is better than dropping the user's choice on the floor.
    }
    for (const listener of listeners) listener();
  }

  function subscribe(onChange: () => void): () => void {
    listeners.add(onChange);
    const onStorage = (e: StorageEvent) => {
      if (e.key === key) {
        primed = false;
        onChange();
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(onChange);
      window.removeEventListener("storage", onStorage);
    };
  }

  return { read, write, subscribe, server: () => defaults };
}
