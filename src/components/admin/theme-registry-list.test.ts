/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ThemeRegistryList from "./theme-registry-list";
import type { ThemeManifest } from "@/lib/themes/types";

function theme(assets: ThemeManifest["assets"]): ThemeManifest {
  return {
    slug: "fixture",
    name: "Fixture",
    description: "A theme for tests.",
    authors: [],
    fonts: [],
    assets,
    screenshots: [],
    surfaces: [],
    escapes: [],
    assetBase: "/themes/fixture",
    logo: null,
    branding: { name: null, menuBarLogo: null, loginLogo: null },
    swatches: [{ token: "background", value: "#ffffff" }],
    typefaces: [],
    lastUpdated: null,
  };
}

function render(t: ThemeManifest): string {
  return renderToStaticMarkup(
    createElement(ThemeRegistryList, {
      themes: [t],
      activeSlug: "other",
      action: async () => {},
    }),
  );
}

test("a theme's assets.preview is shown on its picker tile", () => {
  const html = render(theme({ preview: "preview.png" }));
  const img = html.match(/<img[^>]*alt="Preview of the Fixture theme"[^>]*>/)?.[0];
  assert.ok(img, "no preview image on the tile");
  // Served from the theme's own copied assets, through the image optimizer.
  const src = img.match(/ src="([^"]+)"/)?.[1] ?? "";
  assert.match(decodeURIComponent(src), /^\/_next\/image\?url=\/themes\/fixture\/preview\.png&/);
  // Beside the live swatch row, not instead of it.
  assert.match(html, /title="--background: #ffffff"/);
});

test("a theme without one shows the swatch row alone", () => {
  const html = render(theme({}));
  assert.doesNotMatch(html, /Preview of the/);
  assert.match(html, /title="--background: #ffffff"/);
});
