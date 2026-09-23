/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import Image from "next/image";

/**
 * The mark over the wordmark, as the sign-in page shows it.
 *
 * Rendered by the sign-in card AND by the welcome tour's takeover, which is
 * what lets the tour begin with the logo not moving: the same markup at the
 * same sizes in the same card layout lands at the same pixel on both pages.
 * The `data-tour` hooks are what the reveal animates from.
 */
export default function LoginLockup({ logo }: { logo: string | null }) {
  return (
    <>
      {logo && (
        <Image
          src={logo}
          // Decorative: the <h1> below carries the name, so announcing the
          // mark as well would just read the product twice.
          alt=""
          width={72}
          height={69}
          priority
          data-tour="login-mark"
          className="mx-auto mb-4"
        />
      )}
      <h1 className="font-heading text-2xl font-bold text-brand-foreground">
        {/*
          inline-block + leading-none so the measured rect is the glyph box,
          exactly like the menu bar's wordmark span. The h1 keeps its own
          line-height, so nothing moves on the sign-in page.
        */}
        <span data-tour="login-wordmark" className="inline-block leading-none">
          MixOS
        </span>
      </h1>
    </>
  );
}
