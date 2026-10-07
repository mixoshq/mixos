/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The brand an install presents: its name, and the marks beside that name in
 * the menu bar and on the sign-in page.
 *
 * Three slots, each resolved independently, in this order:
 *
 *   core default → theme `assets.logo` (logos only) → app filters → theme `branding.*`
 *
 * A theme's `branding` block is a CLAIM: a slot it declares is final, and the
 * app filters for it never run. Its `assets.logo` is not a claim, only the
 * seed the filters start from — both default themes ship one, and treating it
 * as a claim would leave no install where an app could rebrand.
 *
 * WHY THIS MODULE HAS NO IMPORTS: the registry generator and the manifest
 * schemas import the limits below, and they run under tsx outside Next, where
 * the `@/` alias is not resolved. The same reason `src/lib/screenshots.ts` is
 * dependency-free.
 */

/** The core hooks that carry the brand. Never slug-prefixed. */
export const BRAND_HOOKS = ["brand-name", "menu-bar-logo", "login-logo"] as const;
export type BrandHook = (typeof BRAND_HOOKS)[number];

/** Of those, the two whose value is a mark rather than text. */
export const BRAND_LOGO_HOOKS = ["menu-bar-logo", "login-logo"] as const;

/** What the menu bar and sign-in page say when nothing else claims the name. */
export const DEFAULT_BRAND_NAME = "MixOS";

/**
 * Long enough for a real product name, short enough that the menu bar still
 * has room for the Dashboard link and the apps menu beside it.
 */
export const BRAND_NAME_MAX_LENGTH = 40;

/**
 * A mark as rendered: its public URL and its INTRINSIC size, measured at build
 * time. Display size is derived from these by `fitLogo`, so a mark of any
 * aspect ratio keeps its shape instead of being drawn into a fixed square.
 */
export interface BrandLogo {
  src: string;
  width: number;
  height: number;
}

/** The resolved brand for one request. */
export interface Branding {
  name: string;
  menuBarLogo: BrandLogo | null;
  loginLogo: BrandLogo | null;
}

/**
 * What a logo filter may return:
 *
 * - `null` — no mark; the name stands alone.
 * - the value it was given, unchanged — pass.
 * - a string naming one of the calling app's own declared `branding.logos`,
 *   e.g. `"branding/acme.png"`. The platform resolves it to the published URL
 *   and measured size.
 *
 * Anything else is discarded and the previous value kept. There is no way to
 * return a URL: every mark on the sign-in page is a file the build published.
 */
export type BrandLogoFilterResult = BrandLogo | string | null;

/** One logo an app declared, as the generated registry carries it. */
export interface BrandLogoAsset {
  /** As written in `app.json`, always `branding/<name>`. */
  file: string;
  /** Resolved public URL, e.g. `/branding/apps/acme/mark.png`. */
  url: string;
  width: number;
  height: number;
}

/**
 * An APP's logos: no SVG, for the reason screenshots have none — they are
 * served from an unauthenticated path, and an SVG is a script-bearing
 * document.
 */
export const BRAND_LOGO_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"] as const;

/**
 * A THEME's logos may also be SVG. Theme assets have always been, and the theme
 * docs recommended SVG for the mark, so refusing it would break themes written
 * to that advice. The build reads the size from the root element's
 * `width`/`height` or `viewBox`; next/image serves an `.svg` unoptimized.
 */
export const THEME_LOGO_EXTENSIONS = [...BRAND_LOGO_EXTENSIONS, ".svg"] as const;

/** A mark is drawn at most 240px wide; half a megabyte is generous for that. */
export const BRAND_LOGO_MAX_BYTES = 512 * 1024;

/** One per slot, plus room for a variant or two. */
export const BRAND_LOGO_MAX_COUNT = 4;

/** Where an app keeps its marks, relative to its own root. */
export const BRAND_LOGO_DIR = "branding";

/** Public URL for an app's mark once the generator has copied it out. */
export function brandLogoUrl(slug: string, file: string): string {
  const name = file.replace(/^branding\//, "");
  return `/${BRAND_LOGO_DIR}/apps/${slug}/${name}`;
}

/**
 * The name as the platform will render it, or null when the value is not
 * acceptable. React renders it as a text node, so this is not about markup; it
 * is about a name that fits on one line of the menu bar.
 */
export function sanitizeBrandName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length === 0 || clean.length > BRAND_NAME_MAX_LENGTH) return null;
  return clean;
}
