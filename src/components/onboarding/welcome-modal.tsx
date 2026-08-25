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
    eyebrow: "What is MOS?",
    title: "Your home base at MONTALBANO",
    body: "MONTALBANO Operating System is one workspace that brings the tools you use every day — HubSpot, Notion, Gong, GitHub, Subskribe, and more — into a single place, shaped around how you actually work.",
  },
  {
    eyebrow: "Why MOS exists",
    title: "Let computers do computer things, and humans do human things",
    body: "MOS exists to make that more possible. Instead of bouncing between a dozen tabs to copy, paste, and reconcile, MOS pulls the apps and information you need into one dashboard — so your time goes to the work only you can do.",
  },
  {
    eyebrow: "How MOS works",
    title: "Install, pin, personalize",
    body: "Install apps from the App Manager. Pin widgets to your dashboard. Over time, MOS adapts to your role and surfaces what's most useful to you. Your workspace, your way.",
  },
  {
    eyebrow: "Where do apps come from?",
    title: "Built by MONTALBANO, for MONTALBANO",
    body: "MONTALBANO has MOS app developers who build apps tailored to how we operate. Need something that doesn't exist yet? Let us know — chances are we can build it for you.",
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
        <div className="bg-mixcharcoal px-8 pb-10 pt-8 text-white">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-mixgrey">
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
                  i === index ? "w-6 bg-mixcharcoal" : "w-1.5 bg-border"
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
                className="rounded-md bg-mixcharcoal px-4 py-1.5 text-sm font-medium text-white hover:bg-mixcharcoal/90"
              >
                Next
              </button>
            ) : (
              <button
                type="button"
                onClick={handleStart}
                className="rounded-md bg-mixgrey px-4 py-1.5 text-sm font-semibold text-white hover:bg-mixgrey/90"
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
