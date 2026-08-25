"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  type ReactNode,
} from "react";

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
  const [prefs, setPrefs] = useState<Preferences>(DEFAULTS);
  const [onboarding, setOnboarding] = useState<OnboardingState>({
    active: false,
    step: 0,
  });
  const [showCongratulations, setShowCongratulations] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Preferences>;
        setPrefs({
          menuBar: parsed.menuBar === "hidden" ? "hidden" : "always",
          menuBarAppDisplay:
            parsed.menuBarAppDisplay === "icon" ? "icon" : "icon-and-name",
        });
      }
      const onboardingRaw = localStorage.getItem(ONBOARDING_STATE_KEY);
      if (onboardingRaw) {
        const parsed = JSON.parse(onboardingRaw) as Partial<OnboardingState>;
        setOnboarding({
          active: parsed.active === true,
          step: typeof parsed.step === "number" ? parsed.step : 0,
        });
      }
    } catch {
      // ignore
    }
  }, []);

  function update(next: Preferences) {
    setPrefs(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  }

  function persistOnboarding(next: OnboardingState) {
    setOnboarding(next);
    try {
      localStorage.setItem(ONBOARDING_STATE_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  }

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
