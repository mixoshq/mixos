/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
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
 * lets every step ask for a real action: the user clicks the very control in
 * the spotlight, the page shows what changed, and the guide moves on.
 *
 * MEASURED EVERY FRAME. One animation-frame loop while a step is showing:
 * find the target (first of the step's candidates that exists) and read its
 * rect. A resize, a theme with a taller bar, a pill still animating in, a
 * modal opening — all handled by the same loop, with no listeners to forget.
 * One step at a time, so the cost is one `getBoundingClientRect` per frame.
 * No target, no bubble: a step whose target is on another page waits there,
 * out of sight, until the user comes back to it.
 *
 * PORTALLED. The bubble sits above everything, modals included, and is
 * positioned from viewport coordinates, so where it is in the React tree
 * does not matter and where it is on screen always does.
 */

type Rect = { top: number; left: number; width: number; height: number };

const subscribeNoop = () => () => {};
const getTrue = () => true;
const getFalse = () => false;

/** A beat after the overlay has gone, so the bar is seen before it is explained. */
const START_DELAY_MS = 400;
/** Long enough to see the page a step went to before its menu opens over it. */
const OPEN_DELAY_MS = 600;
/** Long enough for the catalog to close and the new widget to be drawn. */
const SETTLE_MS = 400;

const BUBBLE_W = 416; // w-[26rem]; a constant so placement needs no measuring
const BUBBLE_GAP = 12;
const EDGE = 16;
const ARROW = 12;

function selectorFor(step: GuideStep): string {
  const names = Array.isArray(step.target) ? step.target : [step.target];
  return names.map((n) => `[data-tour="${n}"]`).join(", ");
}

/**
 * The step's target rect, and whether the step is done: its `doneWhen`
 * element is on the page, its `doneOn` event fired, or, for an
 * `endsWithTarget` step, its target came and went.
 */
function useStepState(step: GuideStep): { rect: Rect | null; done: boolean } {
  const [rect, setRect] = useState<Rect | null>(null);
  const [done, setDone] = useState(false);
  const selector = selectorFor(step);
  const { doneWhen, doneOn, endsWithTarget } = step;

  useEffect(() => {
    let frame = 0;
    let seen = false;
    const tick = () => {
      const el = document.querySelector<HTMLElement>(selector);
      if (el) {
        seen = true;
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
        if (endsWithTarget && seen) setDone(true);
      }
      if (doneWhen && document.querySelector(doneWhen)) setDone(true);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [selector, endsWithTarget, doneWhen]);

  useEffect(() => {
    if (!doneOn) return;
    const onDone = () => setDone(true);
    window.addEventListener(doneOn, onDone);
    return () => window.removeEventListener(doneOn, onDone);
  }, [doneOn]);

  return { rect, done };
}

/** The confetti's origin: the centre of `el`, or of the screen without one. */
function burstFrom(el: Element | null | undefined): BurstOrigin {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (!el) return { x: vw / 2, y: vh / 2, vw, vh };
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, vw, vh };
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
  // Mounted when the guide begins, so this delays the first step only.
  const [started, setStarted] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setStarted(true), START_DELAY_MS);
    return () => clearTimeout(t);
  }, []);
  // Skip is in the bubble here; the takeover's own Skip left with it.
  const step = GUIDE_STEPS[index];
  const last = index === GUIDE_STEPS.length - 1;
  // Stable, so a step's pending advance isn't restarted by a render.
  const onAdvance = useCallback(
    () =>
      last
        ? complete(burstFrom(step.celebrateAt?.()))
        : setGuideStep(index + 1),
    [last, complete, step, setGuideStep, index],
  );
  if (!started) return null;
  // Keyed on the index so each step gets a fresh `done`, never the previous
  // step's stale true.
  return <Step key={index} step={step} onAdvance={onAdvance} />;
}

function Step({
  step,
  onAdvance,
}: {
  step: GuideStep;
  onAdvance: () => void;
}) {
  const { finish } = useTour();
  const { rect, done } = useStepState(step);
  const router = useRouter();
  const pathname = usePathname();
  const { route, opens } = step;

  // Go to the step's page when it starts — once, so a user who then leaves
  // is not pulled back.
  useEffect(() => {
    if (route && window.location.pathname !== route) router.push(route);
  }, [route, router]);

  // Open what the target is inside, once the step's page is the one showing.
  const opened = useRef(false);
  useEffect(() => {
    if (!opens || opened.current || (route && pathname !== route)) return;
    const t = window.setTimeout(() => {
      opened.current = true;
      window.dispatchEvent(new Event(opens));
    }, OPEN_DELAY_MS);
    return () => clearTimeout(t);
  }, [opens, route, pathname]);

  // A step advances itself once it is done. Deferred so the setState lands
  // outside the frame loop's render, and for a `doneOn` step until the page
  // has drawn what the event announced: the confetti bursts from it.
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(onAdvance, step.doneOn ? SETTLE_MS : 0);
    return () => clearTimeout(t);
  }, [done, onAdvance, step.doneOn]);

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
      {/* The dim and the bubble fade in together, gently: they arrive over a
          page the user is already looking at. */}
      <div
        aria-hidden
        className="tour-bubble-in pointer-events-none fixed z-[90] rounded-md transition-[top,left,width,height] duration-150"
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
          "tour-bubble-in fixed z-[95] w-[26rem] max-w-[calc(100vw-2rem)] p-4 shadow-lg",
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
        {step.body && (
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            {step.body}
          </p>
        )}
        {/* No count and no Next: the step moves on when the user does what
            it asks. Skip is the one way out, and kept quiet. */}
        <button
          type="button"
          onClick={finish}
          className="mt-3 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          Skip tour
        </button>
      </div>
    </>,
    document.body,
  );
}
