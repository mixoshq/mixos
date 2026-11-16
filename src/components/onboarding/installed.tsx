/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import Image from "next/image";
import { AppWindow, Palette, Plug, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CARD_SURFACE } from "@/components/ui/card";
import { fitLogo, type LogoBox } from "@/lib/branding/fit";
import type { BrandLogo } from "@/lib/branding/types";
import { cn } from "@/lib/utils";
import { SPELLERS, spellSpots, type WordBox } from "./confetti";
import MixosMarkDrawn, { isMixosMark } from "./mixos-mark";
import { useTour } from "./tour-context";

/**
 * The end of the welcome tour, the moment the takeover has collapsed into
 * the menu bar: "MixOS is yours.", popping in in the middle of the screen,
 * its mark drawing itself on above the headline and the three things there
 * are to add below it.
 *
 * I'M READY IS THE CELEBRATION. Pressing it — or closing the card any other
 * way, Enter, Escape or a click on the dim — fades the card out and sets the
 * confetti off from the button (./confetti.tsx, through `burst()`): 40% of
 * it flies to loosely spell the name across the whole width of the screen,
 * hangs there about 470ms and crumbles; the rest bursts out everywhere, over
 * the word too, and falls at once.
 *
 * MixOS's own mark draws itself on stroke by stroke (./mixos-mark.tsx,
 * traced from the PNG). Any other mark —
 * a theme's, an app's — is an image, so it animates in as one: drawn on by a
 * sweep as it turns into place, then one glint across it. Motion is CSS
 * (`mark-draw` and `celebrate-*` in globals.css); reduced motion gets the
 * mark, still.
 *
 * Two layers around the confetti (z-120): the dim under it, which takes the
 * click, and the card, which lets clicks through. The card starts above the
 * confetti's layer and drops under it as it fades, so the burst comes out of
 * the button over the card rather than from behind it. It fades rather than
 * vanishing, then unmounts.
 */

/**
 * What there is to add, under the headline: words only, no links, each
 * line short enough to sit on one line. The icons are the ones
 * Administration uses for each (src/lib/admin/sections.ts).
 */
const EXTENSIONS: { icon: LucideIcon; label: string; line: string }[] = [
  { icon: AppWindow, label: "Add Apps", line: "Tools for how you work." },
  { icon: Plug, label: "Add Connectors", line: "Plug in your services." },
  { icon: Palette, label: "Add Themes", line: "Make it look like yours." },
];

const MARK_BOX: LogoBox = { height: 88, maxWidth: 200 };
const LEAVE_MS = 300;

/** The word's margin from the screen's edges and the menu bar. */
const WORD_EDGE = 16;
/** The word is no taller than this share of the screen, however wide. */
const WORD_MAX_SHARE = 0.5;

/**
 * Where the confetti spells the name: the screen's whole width, less a
 * margin, centred in the page under the menu bar. The word is set as large
 * as fits, so a short name is as wide as this and a long one shorter.
 */
function wordBox(barBottom: number, vw: number, vh: number): WordBox {
  const top = barBottom + WORD_EDGE;
  const room = vh - WORD_EDGE - top;
  const height = Math.min(room, vh * WORD_MAX_SHARE);
  return {
    left: WORD_EDGE,
    top: top + (room - height) / 2,
    width: vw - 2 * WORD_EDGE,
    height,
  };
}

export default function Installed({
  name,
  logo,
}: {
  name: string;
  logo: BrandLogo | null;
}) {
  const { installed } = useTour();
  if (!installed) return null;
  return <Message name={name} logo={logo} />;
}

function Message({ name, logo }: { name: string; logo: BrandLogo | null }) {
  const { dismissInstalled, burst: burstIn } = useTour();
  const [leaving, setLeaving] = useState(false);
  const mark = logo ? fitLogo(logo, MARK_BOX) : null;
  const ownMark = isMixosMark(mark?.src);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  // Every way out: the confetti from the button's centre, the word set in
  // the headline's typeface, then the fade. Once — a click on the dim while
  // the card fades is not a second celebration.
  const close = useCallback(() => {
    if (leaving) return;
    setLeaving(true);
    const button = buttonRef.current?.getBoundingClientRect();
    const title = titleRef.current;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const bar = document.querySelector('[data-tour="menu-bar"]');
    const { spots, grain } = title
      ? spellSpots(
          name,
          wordBox(bar?.getBoundingClientRect().bottom ?? 0, vw, vh),
          getComputedStyle(title).fontFamily,
          SPELLERS,
        )
      : { spots: [], grain: 0 };
    burstIn({
      x: button ? button.left + button.width / 2 : vw / 2,
      y: button ? button.top + button.height / 2 : vh / 2,
      vw,
      vh,
      word: spots,
      grain,
    });
  }, [leaving, burstIn, name]);

  // Fade, then go.
  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(dismissInstalled, LEAVE_MS);
    return () => clearTimeout(t);
  }, [leaving, dismissInstalled]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const fade = cn(
    "transition-opacity duration-300",
    leaving ? "opacity-0" : "opacity-100",
  );
  return (
    <>
      <div
        aria-hidden
        onClick={close}
        className={cn("fixed inset-0 z-[110] cursor-pointer bg-black/45", fade)}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="installed-title"
        className={cn(
          "pointer-events-none fixed inset-0 flex items-center justify-center px-4",
          leaving ? "z-[115]" : "z-[130]",
          fade,
        )}
      >
        <div
          className={cn(
            CARD_SURFACE,
            "celebrate-card w-full max-w-2xl px-6 pb-8 pt-6 text-center shadow-2xl sm:px-10",
          )}
        >
          <div
            aria-hidden
            className="relative mx-auto flex h-36 w-36 items-center justify-center"
          >
            {ownMark ? (
              <MixosMarkDrawn height={MARK_BOX.height} />
            ) : (
              <span className="celebrate-logo relative block">
                {mark ? (
                  <span className="celebrate-draw relative block">
                    <Image
                      src={mark.src}
                      alt=""
                      width={mark.width}
                      height={mark.height}
                      className="block"
                    />
                    {/* The glint, cut to the mark's own shape. */}
                    <span
                      className="celebrate-glint absolute inset-0"
                      style={
                        {
                          maskImage: `url("${mark.src}")`,
                          WebkitMaskImage: `url("${mark.src}")`,
                        } as CSSProperties
                      }
                    />
                  </span>
                ) : (
                  <span className="celebrate-draw block h-20 w-20 rounded-2xl bg-brand" />
                )}
              </span>
            )}
          </div>
          <h2
            id="installed-title"
            ref={titleRef}
            className="mt-2 font-heading text-2xl font-bold text-foreground sm:text-3xl"
          >
            {name} is yours.
          </h2>
          {/* Three columns, or on a phone, where three one-line captions
              can't sit side by side, three rows: the icon, and beside it the
              label over its line. Centred as a block there, so the rows
              line up with each other rather than with the card's edge. */}
          <ul className="mx-auto mt-6 grid w-fit grid-cols-1 gap-4 sm:w-full sm:grid-cols-3 sm:gap-3">
            {EXTENSIONS.map(({ icon: Icon, label, line }) => (
              <li
                key={label}
                className="flex items-center gap-3 text-left sm:flex-col sm:gap-0 sm:text-center"
              >
                <span
                  aria-hidden
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground"
                >
                  <Icon className="h-5 w-5" />
                </span>
                <span className="flex flex-col sm:mt-2 sm:items-center">
                  <span className="text-sm font-semibold leading-tight text-foreground">
                    {label}
                  </span>
                  <span className="mt-1 whitespace-nowrap text-xs leading-snug text-muted-foreground">
                    {line}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          {/* The card's one control, in a layer that otherwise lets clicks
              through to the dim. Focused, so Enter is it too. */}
          <Button
            ref={buttonRef}
            variant="primary"
            autoFocus
            onClick={close}
            className="pointer-events-auto mt-8"
          >
            I&apos;m ready
          </Button>
        </div>
      </div>
    </>
  );
}
