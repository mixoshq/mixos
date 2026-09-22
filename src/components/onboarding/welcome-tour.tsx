/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useEffect, useRef, useState } from "react";
import LoginLockup from "@/components/login-lockup";
import CredentialsFields from "@/app/(auth)/login/credentials-fields";
import { useTour } from "./tour-context";

/**
 * The welcome tour's takeover: what a first-time user sees between the
 * sign-in form fading out and the dashboard appearing.
 *
 * IT IS THE SIGN-IN PAGE WITH THE FORM GONE. Same brand background, same
 * centred card layout, same LoginLockup — and the sign-in fields rendered as
 * an invisible ghost so the card is exactly as tall as the real one. That is
 * what keeps the logo at the same pixel across the redirect: the sign-in card
 * fades its frame and fields on submit, the server redirects here, and the
 * logo simply has not moved. The copy is positioned over the ghost, where the
 * form used to be.
 *
 * THE COPY IS CHOREOGRAPHED, NOT PAGED. Each screen is a list of beats with
 * a delay before each; the beats fade in one at a time and Next fades the
 * whole screen out before the next one begins. The pauses are the design —
 * a second on the welcome line, a beat and a half on the tagline before
 * "Let's begin" appears.
 *
 * THE REVEAL IS TWO FLIPs AND A COLLAPSE. The mark and the wordmark each fly
 * to their counterpart in the menu bar (measured, translate + uniform scale),
 * then the overlay's height collapses to the bar's bottom edge. Both are
 * `bg-brand`, so the overlay's last frame is the bar and it unmounts without
 * a seam. Reduced motion replaces all of it with one fade.
 *
 * SERVER-RENDERED. Whether the tour is active is a server fact (see
 * TourProvider), so this overlay is in the HTML from the first byte and the
 * dashboard never paints underneath it first.
 */

const FLY_MS = 700;
const COLLAPSE_MS = 700;
const FADE_MS = 300;
/** How long the copy takes to fade, in and out. Matches `duration-500`. */
const COPY_FADE_MS = 500;
/** Gap between a screen fading out and the next one starting. */
const EXIT_MS = 300;

type Beat =
  | { kind: "title"; text: string; delay: number }
  | { kind: "body"; text: string; delay: number }
  | { kind: "statement"; text: string; delay: number }
  | { kind: "next"; delay: number }
  | { kind: "begin"; delay: number };

const SCREENS: Beat[][] = [
  [
    {
      kind: "title",
      text: "Welcome to MixOS, your new home base.",
      delay: 400,
    },
    {
      kind: "body",
      text: "MixOS is a workspace of apps that connect your favorite tools (Gmail, Google Sheets, Slack, GitHub, Trello, etc.) into a single place, shaped around how you actually work.",
      delay: 1000,
    },
    { kind: "next", delay: 500 },
  ],
  [
    {
      kind: "title",
      text: "MixOS exists to make that more possible.",
      delay: 200,
    },
    {
      kind: "body",
      text: "Instead of bouncing between a dozen tabs to copy, paste, and reconcile, MixOS pulls the apps and information you need into one dashboard, so your time goes to the work only you can do.",
      delay: 1000,
    },
    { kind: "next", delay: 500 },
  ],
  [
    {
      kind: "statement",
      text: "Let computers do computer things so humans can do human things.",
      delay: 200,
    },
    { kind: "begin", delay: 1500 },
  ],
];

/**
 * Mounted only while the takeover is up. Unmounting between plays is what
 * resets the choreography: a replay always starts at the first beat.
 */
export default function WelcomeTour({ logo }: { logo?: string | null }) {
  const { phase } = useTour();
  if (phase !== "welcome" && phase !== "reveal") return null;
  return <Takeover logo={logo ?? null} />;
}

function Takeover({ logo }: { logo: string | null }) {
  const { phase, begin, revealed } = useTour();
  const [screen, setScreen] = useState(0);
  const [shown, setShown] = useState(0);
  const [exiting, setExiting] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const beats = SCREENS[screen];
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

  function next() {
    setExiting(true);
    window.setTimeout(() => {
      setScreen((s) => s + 1);
      setShown(0);
      setExiting(false);
    }, EXIT_MS);
  }

  useEffect(() => {
    if (!revealing) return;
    const overlay = overlayRef.current;
    const card = cardRef.current;
    const barLockup = document.querySelector<HTMLElement>(
      '[data-tour="menu-bar-logo"]',
    );
    const bar = document.querySelector<HTMLElement>('[data-tour="menu-bar"]');
    if (!overlay || !card || !barLockup || !bar) {
      revealed();
      return;
    }

    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const timers: number[] = [];

    if (reduced) {
      overlay.style.transition = `opacity ${FADE_MS}ms ease-out`;
      overlay.style.opacity = "0";
      timers.push(window.setTimeout(revealed, FADE_MS));
      return () => timers.forEach(clearTimeout);
    }

    // FLIP each piece of the lockup to its counterpart in the bar. Rects are
    // all measured before any style changes, so each piece's own layout is
    // its "first" state. Each is then pinned to the viewport at exactly that
    // rect: the card is centred in an overlay that is about to shrink to
    // 40px, and left in flow the pieces would ride up with it.
    const pairs: [HTMLElement | null, HTMLElement | null][] = [
      [
        card.querySelector('[data-tour="login-mark"]'),
        barLockup.querySelector("img"),
      ],
      [
        card.querySelector('[data-tour="login-wordmark"]'),
        barLockup.querySelector("span"),
      ],
    ];
    const moves = pairs.flatMap(([from, to]) => {
      if (!from || !to) return [];
      return [
        {
          el: from,
          a: from.getBoundingClientRect(),
          b: to.getBoundingClientRect(),
        },
      ];
    });
    for (const { el, a } of moves) {
      el.style.position = "fixed";
      el.style.top = `${a.top}px`;
      el.style.left = `${a.left}px`;
      el.style.width = `${a.width}px`;
      el.style.height = `${a.height}px`;
      el.style.margin = "0";
    }
    void card.offsetWidth;

    // The copy fades out first (COPY_FADE_MS, driven by `revealing` in
    // render); the logo flies only once the screen is empty, so the two
    // motions are read one after the other rather than fighting for
    // attention.
    timers.push(
      window.setTimeout(() => {
        for (const { el, a, b } of moves) {
          el.style.transformOrigin = "top left";
          el.style.transition = `transform ${FLY_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`;
          el.style.transform = `translate(${b.left - a.left}px, ${b.top - a.top}px) scale(${b.width / a.width})`;
        }
        timers.push(
          window.setTimeout(() => {
            // The bar's bottom edge, not its height: the overlay is anchored
            // to the viewport top and the bar is too, so they share a
            // coordinate.
            const barBottom = bar.getBoundingClientRect().bottom;
            overlay.style.transition = `height ${COLLAPSE_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`;
            overlay.style.height = `${barBottom}px`;
            timers.push(window.setTimeout(revealed, COLLAPSE_MS));
          }, FLY_MS),
        );
      }, COPY_FADE_MS),
    );

    return () => timers.forEach(clearTimeout);
  }, [revealing, revealed]);

  const visible = (i: number) => i < shown && !exiting && !revealing;
  const fade = (i: number) =>
    `transition-opacity duration-500 ${visible(i) ? "opacity-100" : "opacity-0"}`;

  return (
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to MixOS"
      className="fixed left-0 right-0 top-0 z-[100] h-full overflow-hidden bg-brand text-brand-foreground"
    >
      {/* The sign-in page's layout, so the logo is where sign-in left it. */}
      <div className="flex min-h-screen flex-col items-center justify-center px-4">
        <div ref={cardRef} className="w-full max-w-sm p-8 text-center">
          <LoginLockup logo={logo} />

          <div className="relative mt-8">
            <div className="invisible" aria-hidden>
              <CredentialsFields ghost />
            </div>

            <div className="absolute left-1/2 top-0 w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2">
              {beats.map((beat, i) => {
                switch (beat.kind) {
                  case "title":
                    return (
                      <h2
                        key={i}
                        className={`whitespace-nowrap font-heading text-lg font-semibold sm:text-xl ${fade(i)}`}
                      >
                        {beat.text}
                      </h2>
                    );
                  case "body":
                    return (
                      <p
                        key={i}
                        className={`mt-4 text-base leading-relaxed text-brand-foreground/85 sm:text-lg ${fade(i)}`}
                      >
                        {beat.text}
                      </p>
                    );
                  case "statement":
                    return (
                      <p
                        key={i}
                        className={`font-heading text-2xl font-bold leading-snug sm:text-3xl ${fade(i)}`}
                      >
                        {beat.text}
                      </p>
                    );
                  case "next":
                    return (
                      <div key={i} className={`mt-8 ${fade(i)}`}>
                        <button
                          type="button"
                          onClick={next}
                          disabled={!visible(i)}
                          className="rounded-md bg-brand-foreground px-6 py-2.5 text-base font-semibold text-brand shadow-sm transition-colors hover:bg-brand-foreground/90"
                        >
                          Next
                        </button>
                      </div>
                    );
                  case "begin":
                    return (
                      <div key={i} className={`mt-8 ${fade(i)}`}>
                        <button
                          type="button"
                          onClick={begin}
                          disabled={!visible(i)}
                          className="rounded-md bg-brand-foreground px-6 py-2.5 text-base font-semibold text-brand shadow-sm transition-colors hover:bg-brand-foreground/90"
                        >
                          Let&apos;s begin
                        </button>
                      </div>
                    );
                }
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
