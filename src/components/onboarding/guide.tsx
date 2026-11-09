/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { LayoutGrid, type LucideIcon } from "lucide-react";
import { createPortal } from "react-dom";
import { CARD_SURFACE } from "@/components/ui/card";
import { useDashboardEdit } from "@/components/dashboard/edit-mode-context";
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
 *
 * SKIP IS NOT IN THE BUBBLE. It is quiet words of their own in the
 * bottom-left corner, outlined only under the pointer, above the dim, in the
 * page's background colour
 * so it reads as part of the dimmed page rather than another card — and in
 * the muted text colour when there is no dim behind it, where that colour
 * would vanish. It stays while a step waits out of sight — on App Manager,
 * say — so there is always a way out of a tour that is waiting for something
 * the user may never do, except while the dashboard is being edited, where
 * Done Editing is the tour's last step and Skip would be a second way to end
 * it. A target reaching into that corner moves it to the target's right.
 */

type Rect = { top: number; left: number; width: number; height: number };

const subscribeNoop = () => () => {};
const getTrue = () => true;
const getFalse = () => false;

/** A beat after the overlay has gone, so the bar is seen before it is explained. */
const START_DELAY_MS = 400;

const BUBBLE_W = 416; // w-[26rem]; a constant so placement needs no measuring
/** About the tallest a bubble gets: less room than this on its side flips it. */
const BUBBLE_MIN_H = 140;
/** Skip's corner, with room to spare: a target reaching into it moves Skip right. */
const SKIP_CLEAR_W = 160;
const SKIP_CLEAR_H = 72;
const BUBBLE_GAP = 12;
const EDGE = 16;
const ARROW = 12;

function selectorFor(step: GuideStep): string {
  const names = Array.isArray(step.target) ? step.target : [step.target];
  return names.map((n) => `[data-tour="${n}"]`).join(", ");
}

/**
 * The step's target rect, and whether the step is done: its `doneWhen`
 * element is on the page — once its `armedBy` event has fired, for a step
 * that has one.
 */
function useStepState(step: GuideStep): { rect: Rect | null; done: boolean } {
  const [rect, setRect] = useState<Rect | null>(null);
  const [done, setDone] = useState(false);
  const selector = selectorFor(step);
  const { doneWhen, armedBy } = step;

  useEffect(() => {
    let frame = 0;
    let armed = !armedBy;
    const arm = () => {
      armed = true;
    };
    if (armedBy) window.addEventListener(armedBy, arm);
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
      if (armed && document.querySelector(doneWhen)) setDone(true);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      if (armedBy) window.removeEventListener(armedBy, arm);
    };
  }, [selector, doneWhen, armedBy]);

  return { rect, done };
}

/**
 * Icons a step's body can draw as `{name}`: the ones on the controls it sends
 * the user to, so the words match what they will see. Decorative: the name
 * beside each says the same.
 */
const BODY_ICONS: Record<string, LucideIcon> = {
  apps: LayoutGrid, // the Apps button's (src/components/apps/apps-dropdown.tsx)
};

function withIcons(text: string): ReactNode[] {
  return text.split(/\{(\w+)\}/).map((part, i) => {
    if (i % 2 === 0) return part;
    const Icon = BODY_ICONS[part];
    return Icon ? (
      <Icon key={i} aria-hidden className="mb-0.5 inline h-3.5 w-3.5 align-middle" />
    ) : (
      `{${part}}`
    );
  });
}

/** A step's body: its `**…**` parts in bold, in the title's colour, and its `{icons}` drawn. */
function withBold(text: string): ReactNode {
  return text.split(/\*\*(.+?)\*\*/).map((part, i) =>
    i % 2 ? (
      <strong key={i} className="font-semibold text-foreground">
        {withIcons(part)}
      </strong>
    ) : (
      <Fragment key={i}>{withIcons(part)}</Fragment>
    ),
  );
}

/** The confetti's origin: the centre of the screen, behind the message card. */
function screenCentre(): BurstOrigin {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return { x: vw / 2, y: vh / 2, vw, vh };
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
  const step = GUIDE_STEPS[index];
  const last = index === GUIDE_STEPS.length - 1;
  // Stable, so a step's pending advance isn't restarted by a render. The
  // last one is the end of the tour: the celebration.
  const onAdvance = useCallback(
    () => (last ? complete(screenCentre()) : setGuideStep(index + 1)),
    [last, complete, setGuideStep, index],
  );
  if (!started) return null;
  // Keyed on the index so each step gets a fresh `done`, never the previous
  // step's stale true.
  return <Step key={index} step={step} onAdvance={onAdvance} />;
}

function Step({ step, onAdvance }: { step: GuideStep; onAdvance: () => void }) {
  const { finish } = useTour();
  const { isEditing } = useDashboardEdit();
  const { rect, done } = useStepState(step);

  // A step advances itself once it is done. Deferred so the setState lands
  // outside the frame loop's render.
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(onAdvance, 0);
    return () => clearTimeout(t);
  }, [done, onAdvance]);

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Skip's corner, unless the target is in it: then just right of the target.
  const skipAt =
    rect && rect.left < SKIP_CLEAR_W && rect.top + rect.height > vh - SKIP_CLEAR_H
      ? { left: rect.left + rect.width + BUBBLE_GAP, bottom: EDGE }
      : { left: EDGE, bottom: EDGE };
  // Whether the dim is behind it, which is when the bubble is up.
  const overDim = !!rect && !done && (step.dim ?? true);

  return createPortal(
    <>
      {/* Not once it's done: its target can be the very thing whose
          appearance said so — the pencil, back after editing. */}
      {rect && !done && <Bubble step={step} rect={rect} vw={vw} vh={vh} />}
      {!isEditing && (
        <button
          type="button"
          onClick={finish}
          className={cn(
            "tour-bubble-in fixed z-[95] rounded-full border bg-transparent px-3 py-1.5 text-xs font-medium transition-colors",
            // The outline only on hover: at rest it's the words alone.
            overDim
              ? "border-transparent text-background hover:border-background/60"
              : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
          )}
          style={skipAt}
        >
          Skip tour
        </button>
      )}
    </>,
    document.body,
  );
}

/** The dim and the card, for a step whose target is on the page. */
function Bubble({
  step,
  rect,
  vw,
  vh,
}: {
  step: GuideStep;
  rect: Rect;
  vw: number;
  vh: number;
}) {
  // The step's side, unless there is no room for the bubble on it: the
  // dashboard's pencil sits at the foot of the screen, and a bubble below it
  // would be drawn off the bottom.
  const wantedSide = step.placement ?? "below";
  const roomBelow = vh - (rect.top + rect.height) - BUBBLE_GAP;
  const roomAbove = rect.top - BUBBLE_GAP;
  const placement =
    wantedSide === "below" && roomBelow < BUBBLE_MIN_H && roomAbove > roomBelow
      ? "above"
      : wantedSide === "above" &&
          roomAbove < BUBBLE_MIN_H &&
          roomBelow > roomAbove
        ? "below"
        : wantedSide;
  const dim = step.dim ?? true;

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

  return (
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
        {/* No count, no Next and no Skip: the step moves on when the user
            does what it asks, and Skip has its own corner. */}
        <div
          id="tour-step-title"
          className="text-base font-semibold text-foreground"
        >
          {step.title}
        </div>
        {step.body && (
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            {withBold(step.body)}
          </p>
        )}
      </div>
    </>
  );
}
