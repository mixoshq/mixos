/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft } from "lucide-react";
import LoginLockup from "@/components/login-lockup";
import CredentialsFields from "@/app/(auth)/login/credentials-fields";
import type { Branding } from "@/lib/branding/types";
import DashboardIllustration from "./dashboard-illustration";
import { useTour } from "./tour-context";

/**
 * The welcome tour's takeover: what a first-time user sees between the
 * sign-in form fading out and the dashboard appearing.
 *
 * IT STARTS AS THE SIGN-IN PAGE WITH THE FORM GONE. Same brand background,
 * same centred card layout, same LoginLockup — and the sign-in fields rendered
 * as an invisible ghost so the card is exactly as tall as the real one. That
 * is what keeps the logo at the same pixel across the redirect: the sign-in
 * card fades its frame and fields on submit, the server redirects here, and
 * the logo simply has not moved. The first screen's copy is positioned over
 * the ghost, where the form used to be. The wordmark is never drawn here —
 * the welcome line says the name itself, and the sign-in card faded it with
 * the form — but keeps its box, so the mark stays where it is. It fades in
 * as the lockup lands in the corner.
 *
 * THE COPY IS CHOREOGRAPHED, NOT PAGED. Each screen is a list of beats with
 * a delay before each; the beats fade in one at a time and Next — the Enter
 * key, or the faint keycap that says so — fades the whole screen out before
 * the next one begins. The pauses are the design — two seconds on the
 * welcome line before the keycap, a second on the picture before the words
 * for it and two on those before the keycap again, then the tagline alone,
 * two seconds before "Let's begin". Enter is Let's begin too, there.
 *
 * NEXT SENDS THE LOGO HOME. The second screen is the workspace's, not the
 * sign-in page's: the welcome line fades out completely (COPY_FADE_MS), then
 * the mark and the wordmark each fly to their counterpart in the menu bar
 * (measured, translate + uniform scale), the wordmark fading back in on the
 * way, and stay pinned there, and a picture
 * of a dashboard fades in below as they land, with the copy saying what it
 * is. The flight is slow enough to be watched rather than glimpsed: it is the
 * one moment that explains where the logo went, and that the workspace starts
 * there.
 *
 * Unless the two marks differ. The sign-in and menu-bar marks are separate
 * brand slots, and a mark that flew into a different image would land and then
 * swap. So when they are not the same file the sign-in mark fades where it is,
 * over the flight's length, and only the wordmark flies.
 *
 * THE REVEAL IS A COLLAPSE. "Let's begin" fades the tagline and itself, then
 * the overlay's height collapses to the bar's bottom edge, under a lockup that
 * is already in place. Both are `bg-brand`, so the overlay's last frame is the
 * bar and it unmounts without a seam. Reduced motion moves the lockup without
 * flying it, and replaces the collapse with one fade.
 *
 * SERVER-RENDERED. Whether the tour is active is a server fact (see
 * TourProvider), so this overlay is in the HTML from the first byte and the
 * dashboard never paints underneath it first.
 */

const FLY_MS = 1400;
const COLLAPSE_MS = 1100;
const FADE_MS = 300;
/** How long the copy takes to fade, in and out. Matches `duration-500`. */
const COPY_FADE_MS = 500;
/** Gap between a screen fading out and the next one starting. */
const EXIT_MS = 300;

type Beat =
  | { kind: "title"; text: string; delay: number }
  | { kind: "illustration"; delay: number }
  | { kind: "body"; text: string; delay: number }
  | { kind: "statement"; text: string; delay: number }
  | { kind: "next"; delay: number }
  | { kind: "begin"; delay: number };

/**
 * A screen's beats, and where they sit. `card` is the sign-in page's layout,
 * the copy where the form was. `corner` is the workspace's: the lockup in the
 * menu bar's corner, where it stays, and the copy centred below the bar.
 */
interface Screen {
  layout: "card" | "corner";
  beats: Beat[];
}

/** The copy names the brand, so a rebranded install does not welcome you to MixOS. */
const screens = (name: string): Screen[] => [
  {
    layout: "card",
    beats: [
      {
        kind: "title",
        text: `Welcome to ${name}, your new home base.`,
        delay: 400,
      },
      { kind: "next", delay: 2000 },
    ],
  },
  {
    layout: "corner",
    beats: [
      // The screen starts as the lockup takes off, so the picture arrives
      // as it lands.
      { kind: "illustration", delay: FLY_MS - 400 },
      {
        kind: "body",
        text: `${name} is a workspace of apps that connect your favorite tools into a single place, shaped around how you actually work.`,
        delay: 1000,
      },
      { kind: "next", delay: 2000 },
    ],
  },
  {
    layout: "corner",
    beats: [
      {
        kind: "statement",
        text: "Let computers do computer things so humans can do human things.",
        delay: 200,
      },
      { kind: "begin", delay: 2000 },
    ],
  },
];

/** The space above a beat: none at the top of a screen, more under the picture. */
function gapAbove(beats: Beat[], i: number): string {
  if (i === 0) return "";
  switch (beats[i].kind) {
    case "next":
      return "mt-4";
    case "begin":
      return "mt-8";
    case "statement":
      return "mt-6";
    default:
      return beats[i - 1].kind === "illustration" ? "mt-8" : "mt-4";
  }
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * FLIP each piece of the lockup to its counterpart in the bar, and leave it
 * there: measure where it is, pin it to the viewport there, then transform to
 * where it belongs. The pin matters because the card is centred, and left in
 * flow the pieces would move with it as the layout changes around them.
 * `ms` of 0 moves them without a flight.
 *
 * The wordmark, hidden on the first screen, fades in over the flight, so it
 * lands as the bar's own does: inline, over the class that hid it.
 *
 * A sign-in mark that differs from the bar's is pinned too but does not fly —
 * it fades where it is. Pinning it still matters: left in flow it would jump
 * as the wordmark leaves and the centred card re-centres.
 *
 * With no bar to fly to, the lockup fades instead, so it can't sit under the
 * second screen's picture.
 */
function flyHome(card: HTMLElement, sameMark: boolean, ms: number): void {
  const barLockup = document.querySelector<HTMLElement>(
    '[data-tour="menu-bar-logo"]',
  );
  if (!barLockup) {
    card.style.transition = `opacity ${COPY_FADE_MS}ms ease-out`;
    card.style.opacity = "0";
    return;
  }

  const loginMark = card.querySelector<HTMLElement>('[data-tour="login-mark"]');
  const pairs: { from: HTMLElement | null; to: HTMLElement | null; appear?: boolean }[] = [
    ...(sameMark ? [{ from: loginMark, to: barLockup.querySelector("img") }] : []),
    {
      from: card.querySelector<HTMLElement>('[data-tour="login-wordmark"]'),
      to: barLockup.querySelector("span"),
      appear: true,
    },
  ];
  const fading = sameMark ? null : loginMark;

  const moves = pairs.flatMap(({ from, to, appear = false }) => {
    if (!from || !to) return [];
    return [
      {
        el: from,
        a: from.getBoundingClientRect(),
        b: to.getBoundingClientRect(),
        appear,
      },
    ];
  });
  // Measured with the rest, before anything is pinned.
  const fade = fading ? { el: fading, a: fading.getBoundingClientRect() } : null;
  for (const { el, a } of fade ? [...moves, fade] : moves) {
    el.style.position = "fixed";
    el.style.top = `${a.top}px`;
    el.style.left = `${a.left}px`;
    el.style.width = `${a.width}px`;
    el.style.height = `${a.height}px`;
    el.style.margin = "0";
  }
  // Commit the pin as its own layout before the transform, or the browser
  // coalesces both into one change and there is nothing to animate from.
  void card.offsetWidth;

  for (const { el, a, b, appear } of moves) {
    el.style.transformOrigin = "top left";
    el.style.transition = ms
      ? `transform ${ms}ms cubic-bezier(0.32, 0, 0.2, 1), opacity ${ms}ms ease-in`
      : "none";
    el.style.transform = `translate(${b.left - a.left}px, ${b.top - a.top}px) scale(${b.width / a.width})`;
    if (appear) el.style.opacity = "1";
  }
  if (fade) {
    fade.el.style.transition = ms ? `opacity ${ms}ms ease-out` : "none";
    fade.el.style.opacity = "0";
  }
}

/**
 * Mounted only while the takeover is up. Unmounting between plays is what
 * resets the choreography: a replay always starts at the first beat, with the
 * lockup back in the card.
 */
export default function WelcomeTour({ branding }: { branding: Branding }) {
  const { phase } = useTour();
  if (phase !== "welcome" && phase !== "reveal") return null;
  return <Takeover branding={branding} />;
}

function Takeover({ branding }: { branding: Branding }) {
  const { name, loginLogo, menuBarLogo } = branding;
  const sameMark = loginLogo?.src === menuBarLogo?.src;
  // Memoized: `beats` is an effect dependency, and a fresh array every render
  // would restart the current beat's delay on any unrelated re-render.
  const SCREENS = useMemo(() => screens(name), [name]);
  const { phase, begin, revealed } = useTour();
  const [screen, setScreen] = useState(0);
  const [shown, setShown] = useState(0);
  const [exiting, setExiting] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const { layout, beats } = SCREENS[screen];
  const revealing = phase === "reveal";

  // Reveal the next beat after its delay. Re-arms whenever `shown` moves.
  useEffect(() => {
    if (revealing || exiting || shown >= beats.length) return;
    const t = window.setTimeout(
      () => setShown((n) => n + 1),
      beats[shown].delay,
    );
    return () => clearTimeout(t);
  }, [beats, shown, exiting, revealing]);

  const next = useCallback(() => {
    setExiting(true);
    const toCorner =
      layout === "card" && SCREENS[screen + 1]?.layout === "corner";
    // Into the corner, the copy fades out completely before the lockup
    // moves: pinning takes it out of flow, which pulls the copy up by its
    // height — harmless once the copy is invisible, a visible jolt while it
    // is still being read.
    window.setTimeout(
      () => {
        if (toCorner && cardRef.current) {
          flyHome(cardRef.current, sameMark, prefersReducedMotion() ? 0 : FLY_MS);
        }
        setScreen((s) => s + 1);
        setShown(0);
        setExiting(false);
      },
      toCorner ? COPY_FADE_MS : EXIT_MS,
    );
  }, [layout, SCREENS, screen, sameMark]);

  // Enter does what the screen's control does — the keycap's Next, or Let's
  // begin — once that control is showing; unless focus is on a control Enter
  // already activates, that one included, so it can't go twice.
  const actionBeat = beats.findIndex((b) => b.kind === "next" || b.kind === "begin");
  const onEnter =
    actionBeat >= 0 && actionBeat < shown && !exiting && !revealing
      ? beats[actionBeat].kind === "next"
        ? next
        : begin
      : null;
  useEffect(() => {
    if (!onEnter) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.repeat || e.isComposing || e.defaultPrevented) return;
      if (
        e.target instanceof Element &&
        e.target.closest("button, a, input, textarea, select, [contenteditable]")
      ) {
        return;
      }
      e.preventDefault();
      onEnter();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onEnter]);

  useEffect(() => {
    if (!revealing) return;
    const overlay = overlayRef.current;
    const bar = document.querySelector<HTMLElement>('[data-tour="menu-bar"]');
    if (!overlay || !bar) {
      revealed();
      return;
    }
    const timers: number[] = [];

    if (prefersReducedMotion()) {
      overlay.style.transition = `opacity ${FADE_MS}ms ease-out`;
      overlay.style.opacity = "0";
      timers.push(window.setTimeout(revealed, FADE_MS));
      return () => timers.forEach(clearTimeout);
    }

    // The lockup is already in the bar's corner: it flew there on Next. The
    // tagline fades out first (COPY_FADE_MS, driven by `revealing` in
    // render), then the overlay collapses onto the bar.
    timers.push(
      window.setTimeout(() => {
        // The bar's bottom edge, not its height: the overlay is anchored to
        // the viewport top and the bar is too, so they share a coordinate.
        const barBottom = bar.getBoundingClientRect().bottom;
        overlay.style.transition = `height ${COLLAPSE_MS}ms cubic-bezier(0.32, 0, 0.2, 1)`;
        overlay.style.height = `${barBottom}px`;
        timers.push(window.setTimeout(revealed, COLLAPSE_MS));
      }, COPY_FADE_MS),
    );

    return () => timers.forEach(clearTimeout);
  }, [revealing, revealed]);

  const visible = (i: number) => i < shown && !exiting && !revealing;
  const fade = (i: number) =>
    `transition-opacity duration-500 ${visible(i) ? "opacity-100" : "opacity-0"}`;

  /** The screen has the dashboard picture on it, which plays. */
  const playing = beats.some((b) => b.kind === "illustration");

  const beat = (b: Beat, i: number) => {
    const gap = gapAbove(beats, i);
    switch (b.kind) {
      case "title":
        return (
          <h2
            key={i}
            className={`whitespace-nowrap font-heading text-lg font-semibold sm:text-xl ${fade(i)}`}
          >
            {b.text}
          </h2>
        );
      case "illustration":
        return (
          <div key={i} className={`${gap} ${fade(i)}`}>
            <DashboardIllustration
              logo={menuBarLogo}
              name={name}
              shown={visible(i)}
            />
          </div>
        );
      case "body":
        return (
          <p
            key={i}
            className={`${gap} mx-auto max-w-xl text-base leading-relaxed text-brand-foreground/85 sm:text-lg ${fade(i)}`}
          >
            {b.text}
          </p>
        );
      case "statement":
        return (
          <p
            key={i}
            className={`${gap} mx-auto max-w-xl font-heading text-2xl font-bold leading-snug sm:text-3xl ${fade(i)}`}
          >
            {b.text}
          </p>
        );
      case "next":
        // A keycap, faint until hovered, under the line's right edge: press
        // Enter, or click it. Its name says both what it does and what it shows.
        // Once it is up it blinks like a cursor (`keycap-blink`, globals.css);
        // the class goes on with it, so the blinking starts once it has
        // faded in, not while it still is. Not beside the playing picture:
        // one thing moving on the screen at a time.
        return (
          <div key={i} className={`${gap} mx-auto flex max-w-xl justify-end ${fade(i)}`}>
            <button
              type="button"
              onClick={next}
              disabled={!visible(i)}
              aria-label="Next (Enter)"
              aria-keyshortcuts="Enter"
              className={`flex items-center gap-1.5 rounded-md border border-b-2 border-brand-foreground/25 px-2 py-1 font-mono text-xs text-brand-foreground/60 transition-colors hover:border-brand-foreground/50 hover:text-brand-foreground ${
                visible(i) && !playing ? "keycap-blink" : ""
              }`}
            >
              Enter
              <CornerDownLeft className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        );
      case "begin":
        return (
          <div key={i} className={`${gap} ${fade(i)}`}>
            <button
              type="button"
              onClick={begin}
              disabled={!visible(i)}
              aria-keyshortcuts="Enter"
              className="rounded-md bg-brand-foreground px-6 py-2.5 text-base font-semibold text-brand shadow-sm transition-colors hover:bg-brand-foreground/90"
            >
              Let&apos;s begin
            </button>
          </div>
        );
    }
  };

  return (
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Welcome to ${name}`}
      className="fixed left-0 right-0 top-0 z-[100] h-full overflow-hidden bg-brand text-brand-foreground"
    >
      {/* The sign-in page's layout, so the logo is where sign-in left it. */}
      <div className="flex min-h-screen flex-col items-center justify-center px-4">
        <div ref={cardRef} className="w-full max-w-sm p-8 text-center">
          <LoginLockup logo={loginLogo} name={name} nameShown={false} />

          <div className="relative mt-8">
            <div className="invisible" aria-hidden>
              <CredentialsFields ghost />
            </div>

            {layout === "card" && (
              // As wide as the welcome line, so the keycap ends where it does,
              // and raised into the wordmark's place: the wordmark has faded,
              // and the line says the name, so it sits close under the mark.
              <div className="absolute -top-12 left-1/2 w-max max-w-[calc(100vw-2rem)] -translate-x-1/2">
                {beats.map(beat)}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* The workspace's layout: below the bar's h-10, where the dashboard
          will be. `m-auto` rather than centring the flex row, so a screen
          too short for the copy scrolls instead of clipping its top. */}
      {layout === "corner" && (
        <div className="absolute inset-x-0 bottom-0 top-10 flex overflow-y-auto px-4 py-6">
          <div className="m-auto w-full max-w-2xl text-center">
            {beats.map(beat)}
          </div>
        </div>
      )}
    </div>
  );
}
