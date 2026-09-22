/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { CARD_SURFACE } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useTour, type BurstOrigin } from "./tour-context";
import { GUIDE_STEPS, type GuideStep } from "./steps";

/**
 * The step bubble. Spotlights a live element and explains it — or asks for a
 * click and waits for it.
 *
 * THE PAGE STAYS LIVE. The dim is a box-shadow on the spotlight, not a
 * backdrop element, and the spotlight has `pointer-events: none` — so the
 * thing being pointed at is clickable while the bubble is up. That is what
 * lets an `auto` step ask for a real action: the user clicks the very control
 * in the spotlight, the page changes, `done()` sees it, and the guide moves
 * on.
 *
 * MEASURED EVERY FRAME. One animation-frame loop while a step is showing:
 * find the target (first of the step's candidates that exists), read its
 * rect, and ask `done()`. A resize, a theme with a taller bar, a pill still
 * animating in, a modal opening — all handled by the same loop, with no
 * listeners to forget. One step at a time, so the cost is one
 * `getBoundingClientRect` per frame.
 *
 * PORTALLED. The bubble sits above everything, modals included, and is
 * positioned from viewport coordinates, so where it is in the React tree
 * does not matter and where it is on screen always does.
 */

type Rect = { top: number; left: number; width: number; height: number };

const subscribeNoop = () => () => {};
const getTrue = () => true;
const getFalse = () => false;

const BUBBLE_W = 352; // w-[22rem]; a constant so placement needs no measuring
const BUBBLE_GAP = 12;
const EDGE = 16;
const ARROW = 12;

function selectorFor(step: GuideStep): string {
  const names = Array.isArray(step.target) ? step.target : [step.target];
  return names.map((n) => `[data-tour="${n}"]`).join(", ");
}

/** The step's target rect, and whether its `done()` has become true. */
function useStepState(step: GuideStep): { rect: Rect | null; done: boolean } {
  const [rect, setRect] = useState<Rect | null>(null);
  const [done, setDone] = useState(false);
  const selector = selectorFor(step);
  const check = step.advance === "auto" ? step.done : undefined;

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const el = document.querySelector<HTMLElement>(selector);
      if (el) {
        const r = el.getBoundingClientRect();
        setRect((prev) =>
          prev &&
          prev.top === r.top &&
          prev.left === r.left &&
          prev.width === r.width &&
          prev.height === r.height
            ? prev
            : { top: r.top, left: r.left, width: r.width, height: r.height },
        );
      } else {
        setRect(null);
      }
      if (check?.()) setDone(true);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [selector, check]);

  return { rect, done };
}

/**
 * Mounted only during the guide phase. Unmounting between plays resets the
 * step index, and it keeps the measuring loop from running when there is
 * nothing to measure.
 */
export default function Guide() {
  const { phase } = useTour();
  // Portals need document.body, which the server does not have: both first
  // renders yield null, then the client re-renders with the bubble.
  const mounted = useSyncExternalStore(subscribeNoop, getTrue, getFalse);
  if (!mounted || phase !== "guide") return null;
  return <Steps />;
}

function Steps() {
  // The index lives in the tour context rather than here so the page can
  // stage itself around it — the dashboard keeps its empty state out of view
  // until the step that talks about it. Guide unmounts between plays and the
  // provider resets the index when the guide begins, so each play starts at
  // the first step.
  const { complete, guideStep: index, setGuideStep } = useTour();
  // Skip is in the bubble here; the takeover's own Skip left with it.
  const step = GUIDE_STEPS[index];
  const last = index === GUIDE_STEPS.length - 1;
  // Keyed on the index so each step gets a fresh `done`, never the previous
  // step's stale true.
  return (
    <Step
      key={index}
      step={step}
      last={last}
      onAdvance={(origin) =>
        last && origin ? complete(origin) : setGuideStep(index + 1)
      }
    />
  );
}

function Step({
  step,
  last,
  onAdvance,
}: {
  step: GuideStep;
  last: boolean;
  /** The last step passes where its Done button is, for the confetti. */
  onAdvance: (origin?: BurstOrigin) => void;
}) {
  const { finish } = useTour();
  const { rect, done } = useStepState(step);

  // An `auto` step advances itself the frame its action is seen. Deferred
  // by one tick so the setState lands outside the frame loop's render.
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(onAdvance, 0);
    return () => clearTimeout(t);
  }, [done, onAdvance]);

  if (!rect) return null;

  const placement = step.placement ?? "below";
  const dim = step.dim ?? true;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Left edge: `along` the target, then kept on-screen. The arrow is placed
  // afterwards so it points at the target's centre wherever the bubble ended
  // up, and is kept inside the bubble's rounded corners.
  const wanted = rect.left + (step.along ?? 0) * rect.width;
  const left = Math.max(EDGE, Math.min(wanted, vw - BUBBLE_W - EDGE));
  const targetCenter = rect.left + rect.width / 2;
  const arrowLeft = Math.max(
    16,
    Math.min(targetCenter - left - ARROW / 2, BUBBLE_W - 16 - ARROW),
  );

  const vertical =
    placement === "below"
      ? { top: rect.top + rect.height + BUBBLE_GAP }
      : { bottom: vh - rect.top + BUBBLE_GAP };

  return createPortal(
    <>
      <div
        aria-hidden
        className="pointer-events-none fixed z-[90] rounded-md transition-[top,left,width,height] duration-150"
        style={{
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
          boxShadow: dim ? "0 0 0 100vmax rgba(0, 0, 0, 0.45)" : "none",
        }}
      />
      <div
        role="dialog"
        aria-labelledby="tour-step-title"
        className={cn(
          CARD_SURFACE,
          "tour-screen-in fixed z-[95] w-[22rem] max-w-[calc(100vw-2rem)] p-4 shadow-lg",
        )}
        style={{ left, ...vertical }}
      >
        {/* Arrow: a rotated square sharing the card's border and fill. */}
        <span
          aria-hidden
          className={cn(
            "absolute h-3 w-3 rotate-45 bg-card",
            placement === "below"
              ? "-top-1.5 border-l border-t border-border"
              : "-bottom-1.5 border-b border-r border-border",
          )}
          style={{ left: arrowLeft }}
        />
        <div
          id="tour-step-title"
          className="text-sm font-semibold text-foreground"
        >
          {step.title}
        </div>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          {step.body}
        </p>
        <div className="mt-4 flex items-center justify-between">
          <span className="flex items-center gap-3 text-xs text-muted-foreground">
            {GUIDE_STEPS.indexOf(step) + 1} of {GUIDE_STEPS.length}
            {!last && (
              <button
                type="button"
                onClick={finish}
                className="underline underline-offset-2 hover:text-foreground"
              >
                Skip tour
              </button>
            )}
          </span>
          {step.advance === "auto" ? (
            <span className="text-xs text-muted-foreground">
              Waiting for you…
            </span>
          ) : (
            <button
              type="button"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                onAdvance({
                  x: r.left + r.width / 2,
                  y: r.top + r.height / 2,
                  vw: window.innerWidth,
                  vh: window.innerHeight,
                });
              }}
              className="rounded-md bg-brand px-4 py-1.5 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand/90"
            >
              {last ? "Done" : "Next"}
            </button>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}
