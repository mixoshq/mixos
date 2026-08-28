/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useCallback, useEffect, useMemo } from "react";
import { usePathname } from "next/navigation";
import {
  ACTIONS,
  Joyride,
  type EventData,
  type Step,
} from "react-joyride";
import { usePreferences } from "@/components/preferences-context";
import { useDashboardEdit } from "@/components/dashboard/edit-mode-context";
import { markOnboardingComplete } from "@/lib/onboarding/actions";
import { getMyApps } from "@/lib/apps/actions";

const FAVORITES_SLUG = "favorites";

const STEPS: Step[] = [
  {
    target: '[data-tour="settings-menu"]',
    title: "Open the menu",
    content:
      "Your settings live in here. Open it and choose Account to get started.",
    placement: "bottom-end",
  },
  {
    // App Manager moved out of this menu and into the settings sidebar, so the
    // tour points at it there. The step before now sends the user into
    // settings, which is where this target exists.
    target: '[data-tour="app-manager-link"]',
    title: "Click App Manager",
    content:
      "App Manager is in the sidebar. It lists every app available to you — open it to install your first one.",
    placement: "right",
  },
  {
    target: `[data-tour-app="${FAVORITES_SLUG}"]`,
    title: "Install Favorites",
    content:
      "Toggle Favorites on to install it. You'll use it to save the links you open most.",
    placement: "left",
  },
  {
    target: `[data-tour-app-nav="${FAVORITES_SLUG}"]`,
    title: "Open Favorites",
    content: "Favorites is now in your menu bar. Click it to open the app.",
    placement: "bottom",
  },
  {
    target: '[data-tour="favorites-url-input"]',
    title: "Add your first link",
    content: (
      <>
        Paste a URL and hit{" "}
        <kbd className="mx-0.5 inline-block rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[0.75em] font-semibold text-foreground shadow-sm">
          Enter
        </kbd>
        . Once you&apos;ve saved at least one, we&apos;ll head back to the
        dashboard.
      </>
    ),
    placement: "bottom",
  },
  {
    target: '[data-tour="dashboard-link"]',
    title: "Back to your Dashboard",
    content:
      "Great! Now head back to your Dashboard to pin a Favorites widget.",
    placement: "bottom",
  },
  {
    target: '[data-tour="edit-dashboard-btn"]',
    title: "Enter edit mode",
    content: "Click Edit Dashboard to start adding widgets.",
    placement: "top",
  },
  {
    target: '[data-tour="add-widget-btn"]',
    title: "Open the widget catalog",
    content: "Click Add Widget to browse everything you can pin.",
    placement: "top",
  },
  {
    target: `[data-tour-widget="${FAVORITES_SLUG}"]`,
    title: "Pick the Favorites widget",
    content: "Click Add to Dashboard on the Favorites widget to configure it.",
    placement: "bottom",
  },
  {
    target: '[data-tour="widget-config-modal"]',
    placement: "left",
    title: "Pick a link to pin",
    content:
      "Move one of your saved links into \u201cLinks to show\u201d \u2014 that's what the widget will display.",
  },
  {
    target: '[data-tour="widget-config-submit"]',
    title: "Pin it to your dashboard",
    content: "Now click Add Widget to drop it onto your dashboard.",
    placement: "top",
  },
  {
    target: '[data-tour="done-editing-btn"]',
    title: "Wrap up your dashboard",
    content:
      "Nice — your first widget is pinned! Click Done Editing Dashboard to finish.",
    placement: "top",
  },
];

const LAST_STEP = STEPS.length - 1;

export default function OnboardingTour() {
  const pathname = usePathname();
  const { isEditing } = useDashboardEdit();
  const {
    onboardingActive,
    onboardingStep,
    advanceOnboarding,
    stopOnboarding,
    triggerCongratulations,
  } = usePreferences();

  const handleFinish = useCallback(async () => {
    stopOnboarding();
    await markOnboardingComplete();
  }, [stopOnboarding]);

  const handleComplete = useCallback(async () => {
    stopOnboarding();
    triggerCongratulations();
    await markOnboardingComplete();
  }, [stopOnboarding, triggerCongratulations]);

  // Step 0 → 1: top-right settings menu opens
  useEffect(() => {
    if (!onboardingActive || onboardingStep !== 0) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ open: boolean }>).detail;
      if (detail?.open) advanceOnboarding();
    };
    window.addEventListener("mix:settings-menu-toggled", handler);
    return () =>
      window.removeEventListener("mix:settings-menu-toggled", handler);
  }, [onboardingActive, onboardingStep, advanceOnboarding]);

  // Step 1 → 2: navigated to /apps AND the Favorites card has rendered. We
  // can't advance on pathname alone — the App Manager's app cards come in
  // after the server component resolves, and Joyride would paint step 2 on a
  // target that doesn't exist yet.
  useEffect(() => {
    if (!onboardingActive || onboardingStep !== 1) return;
    if (pathname !== "/apps") return;
    const interval = window.setInterval(() => {
      if (document.querySelector(`[data-tour-app="${FAVORITES_SLUG}"]`)) {
        window.clearInterval(interval);
        advanceOnboarding();
      }
    }, 150);
    return () => window.clearInterval(interval);
  }, [onboardingActive, onboardingStep, pathname, advanceOnboarding]);

  // Step 2 → 3: Favorites is installed
  useEffect(() => {
    if (!onboardingActive || onboardingStep !== 2) return;
    const handler = async () => {
      const slugs = await getMyApps();
      if (slugs.includes(FAVORITES_SLUG)) advanceOnboarding();
    };
    window.addEventListener("apps:installed-changed", handler);
    return () =>
      window.removeEventListener("apps:installed-changed", handler);
  }, [onboardingActive, onboardingStep, advanceOnboarding]);

  // Step 3 → 4: navigated into the Favorites app
  useEffect(() => {
    if (!onboardingActive) return;
    if (
      onboardingStep === 3 &&
      pathname.startsWith(`/apps/${FAVORITES_SLUG}`)
    ) {
      advanceOnboarding();
    }
  }, [onboardingActive, onboardingStep, pathname, advanceOnboarding]);

  // Step 4 → 5: at least 1 favorite link exists
  useEffect(() => {
    if (!onboardingActive || onboardingStep !== 4) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ count: number }>).detail;
      if ((detail?.count ?? 0) >= 1) advanceOnboarding();
    };
    window.addEventListener("favorites:links-changed", handler);
    return () =>
      window.removeEventListener("favorites:links-changed", handler);
  }, [onboardingActive, onboardingStep, advanceOnboarding]);

  // Step 5 → 6: back on the dashboard
  useEffect(() => {
    if (!onboardingActive) return;
    if (onboardingStep === 5 && pathname === "/") advanceOnboarding();
  }, [onboardingActive, onboardingStep, pathname, advanceOnboarding]);

  // Step 6 → 7: dashboard edit mode engaged
  useEffect(() => {
    if (!onboardingActive) return;
    if (onboardingStep === 6 && isEditing) advanceOnboarding();
  }, [onboardingActive, onboardingStep, isEditing, advanceOnboarding]);

  // Step 7 → 8: widget catalog is open. The catalog modal renders
  // [data-tour-widget] cards; once one is visible, we know we've advanced.
  useEffect(() => {
    if (!onboardingActive || onboardingStep !== 7) return;
    const interval = window.setInterval(() => {
      if (
        document.querySelector(`[data-tour-widget="${FAVORITES_SLUG}"]`)
      ) {
        advanceOnboarding();
      }
    }, 200);
    return () => window.clearInterval(interval);
  }, [onboardingActive, onboardingStep, advanceOnboarding]);

  // Step 8 → 9: user clicks the Favorites widget card (config modal opens)
  useEffect(() => {
    if (!onboardingActive || onboardingStep !== 8) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest(`[data-tour-widget="${FAVORITES_SLUG}"]`)) {
        window.setTimeout(() => advanceOnboarding(), 0);
      }
    };
    document.addEventListener("click", handler, true);
    return () => document.removeEventListener("click", handler, true);
  }, [onboardingActive, onboardingStep, advanceOnboarding]);

  // Step 9 → 10: user dragged at least one link into the "Links to show" list
  // in the Favorites widget config. We poll the DOM because OrderedMultiselect
  // is a generic component — emitting a bespoke event from it would leak tour
  // logic into a widget-agnostic control.
  useEffect(() => {
    if (!onboardingActive || onboardingStep !== 9) return;
    const interval = window.setInterval(() => {
      if (
        document.querySelector('[data-tour="widget-config-selected-item"]')
      ) {
        window.clearInterval(interval);
        advanceOnboarding();
      }
    }, 200);
    return () => window.clearInterval(interval);
  }, [onboardingActive, onboardingStep, advanceOnboarding]);

  // Step 10 → 11: widget added to the dashboard
  useEffect(() => {
    if (!onboardingActive || onboardingStep !== 10) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ appSlug: string }>).detail;
      if (detail?.appSlug === FAVORITES_SLUG) advanceOnboarding();
    };
    window.addEventListener("dashboard:widget-added", handler);
    return () =>
      window.removeEventListener("dashboard:widget-added", handler);
  }, [onboardingActive, onboardingStep, advanceOnboarding]);

  // Step 11 → done: user clicks "Done Editing Dashboard", exiting edit mode.
  // This is the tour's natural end — celebrate with the congrats modal.
  useEffect(() => {
    if (!onboardingActive || onboardingStep !== LAST_STEP) return;
    if (!isEditing) void handleComplete();
  }, [onboardingActive, onboardingStep, isEditing, handleComplete]);

  // Finish gracefully if the step somehow overshoots.
  useEffect(() => {
    if (onboardingActive && onboardingStep > LAST_STEP) void handleFinish();
  }, [onboardingActive, onboardingStep, handleFinish]);

  // Self-heal: if the current step's target selector has been missing from the
  // DOM for longer than the grace window, the tour is wedged (stale localStorage
  // after a refresh, a target that got unmounted, etc.) and Joyride is painting
  // an overlay with no spotlight — silently finish rather than trap the user.
  // `body` and `"center"`-placement steps don't rely on a target, so skip them.
  useEffect(() => {
    if (!onboardingActive) return;
    const step = STEPS[Math.min(Math.max(onboardingStep, 0), LAST_STEP)];
    const selector = typeof step?.target === "string" ? step.target : null;
    if (!selector || selector === "body") return;

    let missingSince: number | null = document.querySelector(selector)
      ? null
      : Date.now();
    const watchdog = window.setInterval(() => {
      if (document.querySelector(selector)) {
        missingSince = null;
        return;
      }
      if (missingSince === null) {
        missingSince = Date.now();
        return;
      }
      if (Date.now() - missingSince >= 3000) {
        window.clearInterval(watchdog);
        void handleFinish();
      }
    }, 300);

    return () => window.clearInterval(watchdog);
  }, [onboardingActive, onboardingStep, handleFinish]);

  const handleEvent = useCallback(
    (data: EventData) => {
      // Only treat an explicit user skip as terminal. Joyride also emits
      // CLOSE/COMPLETE/FINISHED events on ordinary step transitions — reacting
      // to those would prematurely end the tour (e.g. when stepIndex lands on
      // the last step, Joyride fires FINISHED before the user has interacted).
      // `closeButtonAction: "skip"` routes the tooltip close X through SKIP,
      // and our floating "Skip onboarding" button calls handleFinish directly.
      if (data.action === ACTIONS.SKIP) void handleFinish();
    },
    [handleFinish],
  );

  const clampedStep = useMemo(
    () => Math.min(Math.max(onboardingStep, 0), LAST_STEP),
    [onboardingStep],
  );

  if (!onboardingActive) return null;

  // Step 10's target (the Done Editing pill) only exists while the user is in
  // dashboard edit mode. If we somehow land on step 10 without edit mode on
  // (stale localStorage after a refresh, navigation, etc.), mounting Joyride
  // would paint a full-screen overlay with no spotlight cutout — blocking all
  // clicks. The completion effect above will close us out on the next tick;
  // render nothing in the meantime.
  if (onboardingStep === LAST_STEP && !isEditing) return null;

  return (
    <>
      <Joyride
        steps={STEPS}
        stepIndex={clampedStep}
        run={onboardingActive}
        continuous
        onEvent={handleEvent}
        options={{
          // No buttons on the tooltip. The tour advances on real user actions
          // (clicking the highlighted UI), and the always-visible "Skip
          // onboarding" button below handles dismissal — a close X here would
          // just let the user accidentally end the tour while trying to move
          // the tooltip out of the way.
          buttons: [],
          overlayClickAction: false,
          dismissKeyAction: false,
          blockTargetInteraction: false,
          skipBeacon: true,
          disableFocusTrap: true,
          spotlightPadding: 8,
          // A CSS variable, not a token class: Joyride takes a colour VALUE and
          // assigns it straight to backgroundColor / borderTopColor / color as
          // an inline style, so there is nowhere to put a className. `var()`
          // resolves against <html data-theme>, which means this follows the
          // active theme and its light/dark mode instead of pinning the tour to
          // one brand's hex. (Verified: Joyride does no colour maths on this
          // value — it only ever assigns it to those three properties.)
          primaryColor: "var(--primary)",
          zIndex: 10000,
        }}
      />
      {/* Escape hatch: sits above Joyride's overlay (z 10000) so the user can
          always bail out, even if a step's target is missing and Joyride paints
          a spotlight-less overlay that would otherwise swallow every click. */}
      <button
        type="button"
        onClick={() => void handleFinish()}
        className="fixed bottom-4 right-4 rounded-md border border-white/20 bg-black/70 px-3 py-1.5 text-xs font-medium text-white shadow-lg backdrop-blur hover:bg-black/90"
        style={{ zIndex: 10001 }}
      >
        Skip onboarding
      </button>
    </>
  );
}
