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
 * - `welcome` — the brand takeover with its screens.
 * - `reveal`  — "Let's begin" was pressed: the overlay is collapsing into the
 *               menu bar, where the lockup already flew on Next. When it has,
 *               the tour is over and the "is yours" message comes up.
 * - `done`    — no takeover. The only phase a returning user sees.
 */
export type TourPhase = "welcome" | "reveal" | "done";

/**
 * A burst under way: the point it bursts from, the viewport it has to reach
 * the edges of, and the spots where pieces gather to spell the name, in
 * viewport coordinates — none when the word could not be set — with the
 * spacing between them. Measured where the burst is set off, where reading
 * the DOM is legitimate, so the confetti's render stays pure.
 */
export interface Celebration {
  x: number;
  y: number;
  vw: number;
  vh: number;
  word: readonly (readonly [number, number])[];
  grain: number;
}

interface TourContextValue {
  phase: TourPhase;
  /** `welcome` → `reveal`. The overlay calls `revealed()` when its animation ends. */
  begin: () => void;
  /**
   * `reveal` → `done`: stamps completion and puts up the message that says
   * the install is yours, which sets the confetti off with `burst()`.
   */
  revealed: () => void;
  /** Set the confetti off, once: the message calls it as it is closed. */
  burst: (celebration: Celebration) => void;
  /** The burst under way, for a few seconds after `burst()`; null otherwise. */
  celebrating: Celebration | null;
  /** The "is yours" message is up, from `revealed()` until it is dismissed. */
  installed: boolean;
  /** The message was clicked away. */
  dismissInstalled: () => void;
  /** The confetti has fallen. */
  celebrated: () => void;
}

const TourContext = createContext<TourContextValue>({
  phase: "done",
  begin: () => {},
  revealed: () => {},
  burst: () => {},
  celebrating: null,
  installed: false,
  dismissInstalled: () => {},
  celebrated: () => {},
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

  const [celebrating, setCelebrating] = useState<Celebration | null>(null);
  const [installed, setInstalled] = useState(false);

  const begin = useCallback(() => setPhase("reveal"), []);
  // Whether the message may still set the confetti off: armed by
  // `revealed()`, spent by the burst, so a second call does nothing.
  const burstArmed = useRef(false);
  const revealed = useCallback(() => {
    setPhase("done");
    // Fire-and-forget: the takeover is already gone, and a failed stamp only
    // means the tour plays again next time, which is the safe direction to
    // fail.
    void markOnboardingComplete();
    burstArmed.current = true;
    setInstalled(true);
  }, []);
  const burst = useCallback((celebration: Celebration) => {
    if (!burstArmed.current) return;
    burstArmed.current = false;
    setCelebrating(celebration);
  }, []);
  const celebrated = useCallback(() => setCelebrating(null), []);
  const dismissInstalled = useCallback(() => setInstalled(false), []);

  return (
    <TourContext.Provider
      value={{
        phase,
        begin,
        revealed,
        burst,
        celebrating,
        installed,
        dismissInstalled,
        celebrated,
      }}
    >
      {children}
    </TourContext.Provider>
  );
}

export function useTour() {
  return useContext(TourContext);
}
