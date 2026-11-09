/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { markOnboardingComplete } from "@/lib/onboarding/actions";

/**
 * Where the welcome tour is.
 *
 * - `welcome` — the brand takeover with its two screens.
 * - `reveal`  — "Let's begin" was pressed: the overlay is collapsing into the
 *               menu bar, where the lockup already flew on Next.
 * - `guide`   — the overlay is gone; the step bubble is pointing at things.
 * - `done`    — nothing rendered. The only phase a returning user sees.
 */
export type TourPhase = "welcome" | "reveal" | "guide" | "done";

/**
 * The point the confetti bursts from, and the viewport it has to reach the
 * edges of. Measured in the click handler, where reading the DOM is
 * legitimate, so the confetti's render stays pure.
 */
export interface BurstOrigin {
  x: number;
  y: number;
  vw: number;
  vh: number;
}

interface TourContextValue {
  phase: TourPhase;
  /** `welcome` → `reveal`. The overlay calls `revealed()` when its animation ends. */
  begin: () => void;
  /** `reveal` → `guide`. */
  revealed: () => void;
  /** Any phase → `done`, and stamps completion. Used by Skip. */
  finish: () => void;
  /**
   * The end of the guide: `finish`, plus the celebration — the message that
   * says the install is done, now, and confetti from `origin` when the
   * message calls `burst()`.
   */
  complete: (origin: BurstOrigin) => void;
  /**
   * Set the confetti off, once: the message calls it the moment its mark has
   * drawn itself on, so the burst lands on the mark finishing.
   */
  burst: () => void;
  /** Where the confetti is bursting from, for a few seconds after `complete()`; null otherwise. */
  celebrating: BurstOrigin | null;
  /** The "is installed" message is up, from `complete()` until it is dismissed. */
  installed: boolean;
  /** The message was clicked away. */
  dismissInstalled: () => void;
  /** Index of the guide step showing, so the page can stage itself around it. */
  guideStep: number;
  setGuideStep: (i: number) => void;
  /** The confetti has fallen. */
  celebrated: () => void;
}

const TourContext = createContext<TourContextValue>({
  phase: "done",
  begin: () => {},
  revealed: () => {},
  finish: () => {},
  complete: () => {},
  burst: () => {},
  celebrating: null,
  installed: false,
  dismissInstalled: () => {},
  celebrated: () => {},
  guideStep: 0,
  setGuideStep: () => {},
});

/**
 * `active` comes from the server (`onboarding_completed_at IS NULL`), so the
 * first render — server and client alike — already knows whether the takeover
 * is up. That is what keeps the dashboard from flashing before the overlay.
 *
 * It is also watched, not just read once: the Preferences replay button
 * clears the stamp and refreshes, and the provider has to notice `active`
 * turning true again on a component that never unmounted.
 */
export function TourProvider({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  const [phase, setPhase] = useState<TourPhase>(active ? "welcome" : "done");

  // A prop turning true again (replay) restarts the tour. Adjusted during
  // render, the way React asks for prop-derived state, so there is no extra
  // commit with the stale phase.
  const [seenActive, setSeenActive] = useState(active);
  if (active !== seenActive) {
    setSeenActive(active);
    if (active) setPhase("welcome");
  }

  const [celebrating, setCelebrating] = useState<BurstOrigin | null>(null);
  const [installed, setInstalled] = useState(false);
  const [guideStep, setGuideStep] = useState(0);

  const begin = useCallback(() => setPhase("reveal"), []);
  const revealed = useCallback(() => {
    setGuideStep(0);
    setPhase("guide");
  }, []);
  const finish = useCallback(() => {
    setPhase("done");
    // Fire-and-forget: the UI is already gone, and a failed stamp only means
    // the tour plays again next time, which is the safe direction to fail.
    void markOnboardingComplete();
  }, []);
  // Where the confetti will burst from, held between `complete()` and the
  // message's `burst()`; cleared by the burst, so a second call does nothing.
  const pendingBurst = useRef<BurstOrigin | null>(null);
  const complete = useCallback(
    (origin: BurstOrigin) => {
      finish();
      pendingBurst.current = origin;
      setInstalled(true);
    },
    [finish],
  );
  const burst = useCallback(() => {
    if (!pendingBurst.current) return;
    setCelebrating(pendingBurst.current);
    pendingBurst.current = null;
  }, []);
  const celebrated = useCallback(() => setCelebrating(null), []);
  const dismissInstalled = useCallback(() => setInstalled(false), []);

  return (
    <TourContext.Provider
      value={{
        phase,
        begin,
        revealed,
        finish,
        complete,
        burst,
        celebrating,
        installed,
        dismissInstalled,
        celebrated,
        guideStep,
        setGuideStep,
      }}
    >
      {children}
    </TourContext.Provider>
  );
}

export function useTour() {
  return useContext(TourContext);
}
