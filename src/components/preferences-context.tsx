/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createLocalStore } from "@/lib/local-store";

export type MenuBarMode = "always" | "hidden";
export type MenuBarAppDisplay = "icon" | "icon-and-name";

interface Preferences {
  menuBar: MenuBarMode;
  menuBarAppDisplay: MenuBarAppDisplay;
}

interface PreferencesContextValue extends Preferences {
  setMenuBar: (v: MenuBarMode) => void;
  setMenuBarAppDisplay: (v: MenuBarAppDisplay) => void;
}

const DEFAULTS: Preferences = {
  menuBar: "always",
  menuBarAppDisplay: "icon-and-name",
};

const STORAGE_KEY = "mixpreferences";

/**
 * Module-level store rather than state hydrated by an effect. See
 * `createLocalStore` for why, and `docs/apps/app-shell.md` for the pattern.
 */
const prefsStore = createLocalStore<Preferences>(STORAGE_KEY, DEFAULTS, (raw) => {
  const parsed = (raw ?? {}) as Partial<Preferences>;
  return {
    menuBar: parsed.menuBar === "hidden" ? "hidden" : "always",
    menuBarAppDisplay:
      parsed.menuBarAppDisplay === "icon" ? "icon" : "icon-and-name",
  };
});

const PreferencesContext = createContext<PreferencesContextValue>({
  ...DEFAULTS,
  setMenuBar: () => {},
  setMenuBarAppDisplay: () => {},
});

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const prefs = useSyncExternalStore(
    prefsStore.subscribe,
    prefsStore.read,
    prefsStore.server,
  );

  const update = prefsStore.write;

  return (
    <PreferencesContext.Provider
      value={{
        ...prefs,
        setMenuBar: (v) => update({ ...prefs, menuBar: v }),
        setMenuBarAppDisplay: (v) =>
          update({ ...prefs, menuBarAppDisplay: v }),
      }}
    >
      {children}
    </PreferencesContext.Provider>
  );
}

export function usePreferences() {
  return useContext(PreferencesContext);
}
