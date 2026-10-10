/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MetadataRoute } from "next";
import { getActiveTheme } from "@/lib/themes/active";
import { getBrandName } from "@/lib/branding/resolve";

/**
 * The PWA manifest, generated from the active theme.
 *
 * Was a static `manifest.webmanifest` pointing at `/icon-192.png` and a
 * hardcoded `theme_color`. Both are theme decisions, and a theme switch that
 * left the installed-app icon on the previous brand would be the kind of
 * half-applied change nobody thinks to check.
 *
 * `purpose: "any maskable"` is why the source icons are full-bleed with the
 * mark inset to ~60%: the platform applies its own mask, so a pre-rounded icon
 * gets clipped twice and content near the edge is cropped away.
 *
 * Per request, like the sign-in page and for the same reason. A manifest is a
 * special route handler and is cached by default, and nothing here reads a
 * request-time API — so without this it was prerendered at build time, with
 * no database, and served the fallback theme's icons and the default name
 * whatever the install had selected.
 */
export const dynamic = "force-dynamic";

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const [{ theme }, name] = await Promise.all([
    getActiveTheme(),
    getBrandName(),
  ]);

  const icons: MetadataRoute.Manifest["icons"] = [];

  // `any` and `maskable` are declared SEPARATELY rather than as the spec's
  // "any maskable" — Next's type only accepts one purpose per entry, and
  // splitting them is the better icon anyway: the maskable sources are
  // full-bleed with the mark inset to ~60% for the safe zone, which looks
  // over-padded when a platform renders it unmasked. The rounded favicon plate
  // serves the unmasked case.
  if (theme.assets.favicon) {
    icons.push({
      src: `${theme.assetBase}/${theme.assets.favicon}`,
      sizes: "256x256",
      type: "image/png",
      purpose: "any",
    });
  }
  for (const [asset, sizes] of [
    [theme.assets.appIcon192, "192x192"],
    [theme.assets.appIcon512, "512x512"],
  ] as const) {
    if (!asset) continue;
    icons.push({
      src: `${theme.assetBase}/${asset}`,
      sizes,
      type: "image/png",
      purpose: "maskable",
    });
  }

  const brand = theme.swatches.find((s) => s.token === "brand")?.value;
  const background = theme.swatches.find((s) => s.token === "background")?.value;

  return {
    // The brand name is what the installed app is called. `short_name` is the
    // same string: an OS truncates it under the icon if it must, which is
    // better than inventing an abbreviation nobody chose.
    name,
    short_name: name,
    icons,
    ...(brand ? { theme_color: brand } : {}),
    ...(background ? { background_color: background } : {}),
    display: "standalone",
    start_url: "/",
  };
}
