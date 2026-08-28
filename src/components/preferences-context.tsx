/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import {
  createContext,
  useContext,
  useState,
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
  onboardingActive: boolean;
  onboardingStep: number;
  startOnboarding: () => void;
  advanceOnboarding: () => void;
  setOnboardingStep: (step: number) => void;
  stopOnboarding: () => void;
  showCongratulations: boolean;
  triggerCongratulations: () => void;
  dismissCongratulations: () => void;
}

const DEFAULTS: Preferences = {
  menuBar: "always",
  menuBarAppDisplay: "icon-and-name",
};

const STORAGE_KEY = "mixpreferences";
const ONBOARDING_STATE_KEY = "mixonboarding";

interface OnboardingState {
  active: boolean;
  step: number;
}

const ONBOARDING_DEFAULTS: OnboardingState = { active: false, step: 0 };

/**
 * Module-level stores rather than state hydrated by an effect. See
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

const onboardingStore = createLocalStore<OnboardingState>(
  ONBOARDING_STATE_KEY,
  ONBOARDING_DEFAULTS,
  (raw) => {
    const parsed = (raw ?? {}) as Partial<OnboardingState>;
    return {
      active: parsed.active === true,
      step: typeof parsed.step === "number" ? parsed.step : 0,
    };
  },
);

const PreferencesContext = createContext<PreferencesContextValue>({
  ...DEFAULTS,
  setMenuBar: () => {},
  setMenuBarAppDisplay: () => {},
  onboardingActive: false,
  onboardingStep: 0,
  startOnboarding: () => {},
  advanceOnboarding: () => {},
  setOnboardingStep: () => {},
  stopOnboarding: () => {},
  showCongratulations: false,
  triggerCongratulations: () => {},
  dismissCongratulations: () => {},
});

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const prefs = useSyncExternalStore(
    prefsStore.subscribe,
    prefsStore.read,
    prefsStore.server,
  );
  const onboarding = useSyncExternalStore(
    onboardingStore.subscribe,
    onboardingStore.read,
    onboardingStore.server,
  );
  const [showCongratulations, setShowCongratulations] = useState(false);

  const update = prefsStore.write;
  const persistOnboarding = onboardingStore.write;

  function startOnboarding() {
    persistOnboarding({ active: true, step: 0 });
  }

  function advanceOnboarding() {
    persistOnboarding({ active: true, step: onboarding.step + 1 });
  }

  function setOnboardingStep(step: number) {
    persistOnboarding({ active: true, step });
  }

  function stopOnboarding() {
    persistOnboarding({ active: false, step: 0 });
  }

  return (
    <PreferencesContext.Provider
      value={{
        ...prefs,
        setMenuBar: (v) => update({ ...prefs, menuBar: v }),
        setMenuBarAppDisplay: (v) =>
          update({ ...prefs, menuBarAppDisplay: v }),
        onboardingActive: onboarding.active,
        onboardingStep: onboarding.step,
        startOnboarding,
        advanceOnboarding,
        setOnboardingStep,
        stopOnboarding,
        showCongratulations,
        triggerCongratulations: () => setShowCongratulations(true),
        dismissCongratulations: () => setShowCongratulations(false),
      }}
    >
      {children}
    </PreferencesContext.Provider>
  );
}

export function usePreferences() {
  return useContext(PreferencesContext);
}
