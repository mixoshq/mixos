/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import Image from "next/image";
import { fitLogo, LOGIN_LOGO_BOX } from "@/lib/branding/fit";
import type { BrandLogo } from "@/lib/branding/types";

/**
 * The mark over the wordmark, as the sign-in page shows it.
 *
 * Rendered by the sign-in card AND by the welcome tour's takeover, which is
 * what lets the tour begin with the logo not moving: the same markup at the
 * same sizes in the same card layout lands at the same pixel on both pages.
 * The `data-tour` hooks are what the reveal animates from.
 *
 * Both values come from `getBranding()`, resolved on the server: the theme,
 * then the apps' brand filters, then whatever the theme claims outright.
 *
 * `nameShown` false hides the wordmark but keeps its box, so the mark above it
 * stays put: the sign-in card fades it with the form on submit, and the tour
 * never draws it, since its welcome line says the name.
 */
export default function LoginLockup({
  logo,
  name,
  nameShown = true,
}: {
  logo: BrandLogo | null;
  name: string;
  nameShown?: boolean;
}) {
  const mark = logo ? fitLogo(logo, LOGIN_LOGO_BOX) : null;
  return (
    <>
      {mark && (
        <Image
          src={mark.src}
          // Decorative: the <h1> below carries the name, so announcing the
          // mark as well would just read the product twice.
          alt=""
          width={mark.width}
          height={mark.height}
          priority
          data-tour="login-mark"
          className="mx-auto mb-4"
        />
      )}
      <h1 className="font-heading text-2xl font-bold text-brand-foreground">
        {/*
          inline-block + leading-none so the measured rect is the glyph box,
          exactly like the menu bar's wordmark span. The h1 keeps its own
          line-height, so nothing moves on the sign-in page. The 4px of
          padding mirrors the bar wordmark's 3px at this size (24/18), so the
          two rects still differ by a pure scale.
        */}
        <span
          data-tour="login-wordmark"
          className={`-my-1 inline-block py-1 leading-none transition-opacity duration-300 ${
            nameShown ? "" : "opacity-0"
          }`}
        >
          {name}
        </span>
      </h1>
    </>
  );
}
