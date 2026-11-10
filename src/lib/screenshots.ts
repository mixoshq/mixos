/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Screenshots: the one visual an app or theme gets in a listing.
 *
 * An extension is chosen before it is installed, and until now there was
 * almost nothing to look at while choosing. An app declares a Lucide `icon`
 * name; a theme may declare a single `assets.preview` thumbnail for the admin
 * picker. Neither shows what the thing actually looks like in use, and the
 * README cannot fill the gap — the listing renderer resolves relative image
 * paths against mixos.org, so an image committed beside the README publishes
 * as a 404.
 *
 * So a screenshot is a manifest-declared file under the extension's own
 * `screenshots/` directory, verified at build time and copied to a public URL.
 *
 * WHY THIS MODULE EXISTS: apps and themes both have screenshots, and the rules
 * have to be identical between them or an author learns the convention twice.
 * The type, the limits, and the URL derivation live here once and are imported
 * by `src/lib/apps/types.ts`, `src/lib/themes/types.ts`,
 * `scripts/manifest-schemas.ts` and the registry generator.
 *
 * Connectors deliberately have none. A connector has no UI to photograph — its
 * icon is its whole visual identity, and it is already validated as such.
 */

/** Which extension kinds carry screenshots. Also the public URL segment. */
export type ScreenshotKind = "apps" | "themes";

/**
 * One screenshot, as the generated registry carries it.
 *
 * An author writes only `file`, `alt` and `caption` in the manifest. The rest
 * is measured and derived by the generator, which is why this shape is not the
 * manifest shape: a build that has already opened the file to check its size
 * may as well record what it found, so a gallery can reserve the right box
 * before the image loads.
 *
 * Deliberately close to the catalogue's own `ScreenshotSchema` in
 * `src/lib/repository/types.ts`, so the locally-derived record and the one
 * fetched back from mixos.org describe the same thing in the same terms.
 */
export interface Screenshot {
  /**
   * Path as written in the manifest, relative to the extension root — always
   * `screenshots/<name>`. Kept alongside `url` because this is the half an
   * author recognises: it is what a build error names, and what they edit.
   */
  file: string;
  /** Resolved public URL, e.g. `/screenshots/apps/wall-e-345e113c/dashboard.png`. */
  url: string;
  /**
   * `null` when the author supplied none — which is not the same as `""`.
   *
   * An empty alt means "decorative, skip me", and a screenshot never is. A
   * renderer that gets `null` should synthesize something honest from the
   * extension's name rather than emit `alt=""` and hide the image from a
   * screen reader entirely.
   */
  alt: string | null;
  /** Visible caption under the image. `null` when undeclared. */
  caption: string | null;
  /** Measured at build time, so a gallery can reserve the box. */
  width: number;
  height: number;
}

/**
 * No SVG, and that is not an oversight.
 *
 * A screenshot is a raster by definition — there is no vector source for a
 * picture of a rendered page. More to the point, these are served from an
 * unauthenticated path, and an SVG is a script-bearing document rather than an
 * image: it can carry `<script>`, a foreign object, or an external reference.
 * A PNG cannot.
 */
export const SCREENSHOT_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"] as const;

/** A gallery nobody scrolls past item eight. */
export const SCREENSHOT_MAX_COUNT = 8;

/** These live in the repo and go over the wire on a listing page. */
export const SCREENSHOT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Below this it is a thumbnail, not a screenshot, and it ships visibly soft on
 * any display made this decade. There is deliberately no height or aspect
 * rule: an app page, a widget and a theme's menu bar are different shapes, and
 * forcing one aspect would mean letterboxing two of them.
 */
export const SCREENSHOT_MIN_WIDTH = 640;

/** The directory an extension keeps them in, relative to its own root. */
export const SCREENSHOT_DIR = "screenshots";

/** Public URL for a screenshot the generator has copied out. */
export function screenshotUrl(
  kind: ScreenshotKind,
  slug: string,
  file: string,
): string {
  const name = file.replace(/^screenshots\//, "");
  return `/${SCREENSHOT_DIR}/${kind}/${slug}/${name}`;
}
