/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { updateMySearchPreferences } from "@/lib/search/actions";
import { searchAvailable, type SearchPreferences } from "@/lib/search/types";
import { useClientValue } from "@/lib/use-client-value";
import SearchModal from "./search-modal";

interface SearchContextValue {
  prefs: SearchPreferences;
  /** The icon or the shortcut is on. With both off there is no search at all. */
  available: boolean;
  open: boolean;
  openSearch: () => void;
  closeSearch: () => void;
  /**
   * Change the settings: shown at once, then saved. A save that fails puts the
   * previous settings back and answers the error for the caller to show.
   */
  updatePrefs: (next: SearchPreferences) => Promise<string | null>;
  /** "⌘K" on a Mac, "Ctrl+K" elsewhere. */
  shortcutLabel: string;
}

const SearchCtx = createContext<SearchContextValue | null>(null);

/** Apple platforms say ⌘; everything else says Ctrl. */
function isApplePlatform(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? nav.platform ?? "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/**
 * Global search for the signed-in person: their settings, the ⌘K / Ctrl+K
 * shortcut and the modal. Mounted once, in the main layout, and seeded from the
 * server so the menu bar's icon is right on the first paint rather than
 * appearing a moment later.
 *
 * The shortcut listens on `window` in the bubbling phase and ignores a
 * keydown something else already handled (`defaultPrevented`): an app whose
 * editor binds ⌘K to "insert link" keeps it while that editor has focus.
 */
export function SearchProvider({
  initialPrefs,
  children,
}: {
  initialPrefs: SearchPreferences;
  children: ReactNode;
}) {
  const [prefs, setPrefs] = useState(initialPrefs);
  const [open, setOpen] = useState(false);
  // The settings the server last confirmed, which a failed save goes back to.
  const saved = useRef(initialPrefs);
  const apple = useClientValue(isApplePlatform, false);
  const available = searchAvailable(prefs);

  const openSearch = useCallback(() => {
    if (available) setOpen(true);
  }, [available]);
  const closeSearch = useCallback(() => setOpen(false), []);

  const updatePrefs = useCallback(async (next: SearchPreferences) => {
    setPrefs(next);
    const { error } = await updateMySearchPreferences(next);
    if (error) {
      setPrefs(saved.current);
      return error;
    }
    saved.current = next;
    return null;
  }, []);

  useEffect(() => {
    if (!prefs.shortcutEnabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.shiftKey) return;
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "k") return;
      e.preventDefault();
      setOpen((was) => !was);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prefs.shortcutEnabled]);

  const value = useMemo<SearchContextValue>(
    () => ({
      prefs,
      available,
      open: open && available,
      openSearch,
      closeSearch,
      updatePrefs,
      shortcutLabel: apple ? "⌘K" : "Ctrl+K",
    }),
    [prefs, available, open, openSearch, closeSearch, updatePrefs, apple],
  );

  return (
    <SearchCtx.Provider value={value}>
      {children}
      {open && available && <SearchModal onClose={closeSearch} />}
    </SearchCtx.Provider>
  );
}

export function useSearch(): SearchContextValue {
  const ctx = useContext(SearchCtx);
  if (!ctx) throw new Error("useSearch() needs a <SearchProvider> above it.");
  return ctx;
}
