/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useEffect, useState, type CSSProperties } from "react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { CARD_SURFACE } from "@/components/ui/card";
import { fitLogo, type LogoBox } from "@/lib/branding/fit";
import type { BrandLogo } from "@/lib/branding/types";
import { cn } from "@/lib/utils";
import MixosMarkDrawn, { isMixosMark } from "./mixos-mark";
import { useTour } from "./tour-context";

/**
 * The end of the welcome tour: "MixOS is yours.", in the middle of the
 * screen, while the confetti shoots up from the bottom (./confetti.tsx).
 *
 * Above the headline, the install's mark, once. MixOS's own draws itself on,
 * stroke by stroke (./mixos-mark.tsx, traced from the PNG). Any other mark —
 * a theme's, an app's — is an image, so it animates in as one: drawn on by a
 * sweep as it turns into place, then one glint across it. Motion is CSS
 * (`mark-draw` and `celebrate-*` in globals.css); reduced motion gets the
 * mark, still.
 *
 * Two layers around the confetti (z-120): the dim under it, which takes the
 * click, and the card over it, which lets clicks through — so the pieces fly
 * behind and around the card without crossing its words. Setup Complete
 * closes it, and so does a click anywhere else, Enter or Escape. It fades
 * rather than vanishing, then unmounts.
 */

const MARK_BOX: LogoBox = { height: 88, maxWidth: 200 };
const LEAVE_MS = 300;

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
          <div
            aria-hidden
            className="relative mx-auto flex h-36 w-36 items-center justify-center"
          >
            {isMixosMark(mark?.src) ? (
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
            className="mt-2 font-heading text-2xl font-bold text-foreground sm:text-3xl"
          >
            {name} is yours.
          </h2>
          <p className="mt-2 text-base leading-relaxed text-muted-foreground">
            Add more apps, arrange your dashboard,
            <br />
            set up your workspace.
          </p>
          {/* The card's one control, in a layer that otherwise lets clicks
              through to the dim. Focused, so Enter is it too. */}
          <Button
            variant="primary"
            autoFocus
            onClick={() => setLeaving(true)}
            className="pointer-events-auto mt-6"
          >
            Setup Complete
          </Button>
        </div>
      </div>
    </>
  );
}
