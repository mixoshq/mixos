/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Metadata } from "next";
import "./globals.css";
import { getActiveTheme } from "@/lib/themes/active";

/*
 * There is no mode-resolution script here, and that is the point.
 *
 * This file used to carry a blocking inline `matchMedia` script to resolve
 * `system` before first paint, because an effect would run after it and flash a
 * white page at a dark-mode user. Collapsing the mode axis into the theme axis
 * deleted the problem rather than the workaround: the active theme is a server
 * value, so `data-theme` is correct in the first byte of HTML and there is
 * nothing left to resolve on the client.
 */

export async function generateMetadata(): Promise<Metadata> {
  const { theme } = await getActiveTheme();
  // File-convention icons (src/app/icon.*, apple-icon.*) would take precedence
  // over these, which is why there are none — the tab icon is a theme decision.
  const icons: Metadata["icons"] = [];
  if (theme.assets.favicon) {
    icons.push({ rel: "icon", url: `${theme.assetBase}/${theme.assets.favicon}` });
  }
  if (theme.assets.appIcon192) {
    icons.push({
      rel: "apple-touch-icon",
      sizes: "192x192",
      url: `${theme.assetBase}/${theme.assets.appIcon192}`,
    });
  }

  return {
    title: {
      default: "MixOS",
      template: "%s | MixOS",
    },
    description: "Internal tools for the commercial team",
    // An empty array would override Next's default favicon discovery with
    // nothing; leaving it undefined lets public/ keep serving the icons until
    // a theme supplies its own.
    ...(icons.length > 0 ? { icons } : {}),
  };
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { theme } = await getActiveTheme();

  return (
    <html
      lang="en"
      className="h-full antialiased"
      // Resolved on the SERVER, so it is right in the first byte and there is
      // no hydration mismatch to suppress. Every installed theme is bundled
      // into src/generated/themes.css scoped to [data-theme="<slug>"], so
      // switching themes is this attribute changing — not a rebuild.
      data-theme={theme.slug}
    >
      <body className="mix-app-shell min-h-full">{children}</body>
    </html>
  );
}
