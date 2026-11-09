/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useEffect, useState, type CSSProperties } from "react";
import Image from "next/image";
import {
  CalendarDays,
  GitPullRequest,
  MessageSquare,
  Sheet,
  SquareKanban,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { CARD_SURFACE } from "@/components/ui/card";
import { fitLogo, type LogoBox } from "@/lib/branding/fit";
import type { BrandLogo } from "@/lib/branding/types";
import { cn } from "@/lib/utils";
import { useTour } from "./tour-context";

/**
 * The end of the welcome tour: "MixOS is installed!", in the middle of the
 * screen, while the confetti shoots up from the bottom (./confetti.tsx).
 *
 * Above the headline, the install's mark, and apps springing out from
 * behind it into an arch — a sheet, a chat, pull requests, a board, a chart,
 * a calendar — then floating there: the workspace it just set up, and what
 * comes next. Colours are theme tokens; motion is CSS (`celebrate-*` in
 * globals.css), and reduced motion gets the arch already made, still.
 *
 * Two layers around the confetti (z-120): the dim under it, which takes the
 * click, and the card over it, which lets clicks through — so the pieces fly
 * behind and around the card without crossing its words. A click anywhere
 * closes it, as do Enter and Escape. It fades rather than vanishing, then
 * unmounts.
 */

const MARK_BOX: LogoBox = { height: 48, maxWidth: 120 };
const LEAVE_MS = 300;

/** Each app's place in the arch, from the mark's centre, and its colour. */
const APPS: { icon: LucideIcon; tint: string; x: number; y: number }[] = [
  { icon: Sheet, tint: "text-cat-3", x: -112, y: 12 },
  { icon: MessageSquare, tint: "text-cat-2", x: -84, y: -40 },
  { icon: GitPullRequest, tint: "text-cat-1", x: -34, y: -64 },
  { icon: SquareKanban, tint: "text-cat-4", x: 34, y: -64 },
  { icon: TrendingUp, tint: "text-success", x: 84, y: -40 },
  { icon: CalendarDays, tint: "text-cat-5", x: 112, y: 12 },
];

/** Twinkles around the arch: where, and when in their loop. */
const SPARKLES = [
  { x: -132, y: -34, delay: 0 },
  { x: 128, y: -30, delay: 600 },
  { x: -60, y: -86, delay: 1100 },
  { x: 62, y: -88, delay: 300 },
  { x: 0, y: -96, delay: 900 },
];

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
  const { dismissInstalled } = useTour();
  const [leaving, setLeaving] = useState(false);
  const mark = logo ? fitLogo(logo, MARK_BOX) : null;

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
        setLeaving(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const fade = cn(
    "transition-opacity duration-300",
    leaving ? "opacity-0" : "opacity-100",
  );
  return (
    <>
      <div
        aria-hidden
        onClick={() => setLeaving(true)}
        className={cn("fixed inset-0 z-[110] cursor-pointer bg-black/45", fade)}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="installed-title"
        className={cn(
          "pointer-events-none fixed inset-0 z-[130] flex items-center justify-center px-4",
          fade,
        )}
      >
        <div
          className={cn(
            CARD_SURFACE,
            "celebrate-card w-full max-w-md px-8 pb-8 pt-6 text-center shadow-2xl",
          )}
        >
          <div aria-hidden className="relative mx-auto h-36 w-72">
            {/* Everything is placed from the mark's centre, low in the box so
              the arch has room above it. */}
            <div className="absolute left-1/2 top-[6.5rem]">
              {SPARKLES.map((s, i) => (
                <span
                  key={i}
                  className="celebrate-sparkle absolute block h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[1px] bg-primary"
                  style={
                    {
                      left: s.x,
                      top: s.y,
                      animationDelay: `${s.delay}ms`,
                    } as CSSProperties
                  }
                />
              ))}
              {APPS.map(({ icon: Icon, tint, x, y }, i) => (
                <span
                  key={i}
                  className="celebrate-tile absolute -ml-4 -mt-4 flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-card shadow-md"
                  style={
                    {
                      "--tile-x": `${x}px`,
                      "--tile-y": `${y}px`,
                      "--tile-delay": `${250 + i * 90}ms`,
                    } as CSSProperties
                  }
                >
                  <Icon className={`h-4 w-4 ${tint}`} />
                </span>
              ))}
              <span className="celebrate-ring absolute -ml-9 -mt-9 block h-[4.5rem] w-[4.5rem] rounded-full border-2 border-primary/40" />
              {/* w-max: placed in a box with no width of its own, it would
                otherwise shrink, and the mark with it, to nothing. */}
              <span className="celebrate-mark absolute flex w-max -translate-x-1/2 -translate-y-1/2 items-center justify-center">
                {mark ? (
                  <Image
                    src={mark.src}
                    alt=""
                    width={mark.width}
                    height={mark.height}
                    className="shrink-0"
                  />
                ) : (
                  <span className="block h-10 w-10 rounded-xl bg-brand" />
                )}
              </span>
            </div>
          </div>
          <h2
            id="installed-title"
            className="mt-2 font-heading text-2xl font-bold text-foreground sm:text-3xl"
          >
            {name} is installed!
          </h2>
          <p className="mt-2 text-base leading-relaxed text-muted-foreground">
            Add more apps, arrange your dashboard, set up your workspace.
          </p>
        </div>
      </div>
    </>
  );
}
