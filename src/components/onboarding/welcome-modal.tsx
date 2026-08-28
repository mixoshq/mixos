/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { usePreferences } from "@/components/preferences-context";

interface Slide {
  eyebrow: string;
  title: string;
  body: string;
}

const subscribeNoop = () => () => {};
const getTrue = () => true;
const getFalse = () => false;

const SLIDES: Slide[] = [
  {
    eyebrow: "What is MixOS?",
    title: "Your home base is MixOS",
    body: "MixOS is a workspace of apps that connect your favorite tools — Gmail, Google Sheets, Slack, GitHub, Trello — into a single place, shaped around how you actually work.",
  },
  {
    eyebrow: "Why MixOS exists",
    title: "Let computers do computer things, and humans do human things",
    body: "MixOS exists to make that more possible. Instead of bouncing between a dozen tabs to copy, paste, and reconcile, MixOS pulls the apps and information you need into one dashboard — so your time goes to the work only you can do.",
  },
  {
    eyebrow: "How MixOS works",
    title: "Install, pin, personalize",
    body: "Install apps from the App Manager. Pin widgets to your dashboard. Over time, MixOS adapts to your role and surfaces what's most useful to you. Your workspace, your way.",
  },
  {
    eyebrow: "Where does it all come from?",
    title: "Built by developers so anyone can develop",
    body: "MixOS comes with apps, connectors, and themes ready to use — or vibe-code your own: describe what you need, and it gets built.",
  },
];

export default function WelcomeModal() {
  const { startOnboarding } = usePreferences();
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  // Portals render to document.body, which doesn't exist during SSR. The
  // server snapshot returns false, the client snapshot returns true — both
  // initial renders produce null, then the client re-renders the modal.
  const mounted = useSyncExternalStore(subscribeNoop, getTrue, getFalse);

  if (!mounted || dismissed) return null;

  const slide = SLIDES[index];
  const isLast = index === SLIDES.length - 1;

  function handleStart() {
    setDismissed(true);
    startOnboarding();
  }

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="relative mx-4 w-full max-w-lg overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <div className="bg-brand px-8 pb-10 pt-8 text-brand-foreground">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            {slide.eyebrow}
          </p>
          <h2 className="mt-3 text-2xl font-bold tracking-tight">
            {slide.title}
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-white/85">
            {slide.body}
          </p>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border bg-card px-6 py-4">
          <div className="flex items-center gap-1.5">
            {SLIDES.map((_, i) => (
              <span
                key={i}
                className={`h-1.5 rounded-full transition-all ${
                  i === index ? "w-6 bg-brand" : "w-1.5 bg-border"
                }`}
              />
            ))}
          </div>

          <div className="flex items-center gap-2">
            {index > 0 && (
              <button
                type="button"
                onClick={() => setIndex((i) => Math.max(0, i - 1))}
                className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-accent"
              >
                Back
              </button>
            )}
            {!isLast ? (
              <button
                type="button"
                onClick={() => setIndex((i) => Math.min(SLIDES.length - 1, i + 1))}
                className="rounded-md bg-brand px-4 py-1.5 text-sm font-medium text-brand-foreground hover:bg-brand/90"
              >
                Next
              </button>
            ) : (
              <button
                type="button"
                onClick={handleStart}
                className="rounded-md bg-primary px-4 py-1.5 text-sm font-semibold text-white hover:bg-primary/90"
              >
                Let&apos;s get started!
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
