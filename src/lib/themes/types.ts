/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Authoritative runtime types for the theme abstraction.
 *
 * A theme is the third first-class abstraction in this repo, alongside apps and
 * connectors, and it follows their conventions exactly: the folder name IS the
 * slug, `_`-prefixed folders are templates the registry skips, `lastUpdated` is
 * stamped by the pre-commit hook, and `themes/<slug>/theme.json` is
 * schema-validated at build time by scripts/manifest-schemas.ts.
 *
 * The on-disk manifest shape lives in that schema file; this is the *runtime*
 * shape emitted into src/generated/theme-registry.ts.
 */

export interface ThemeAuthor {
  name: string;
  email: string;
}

/**
 * One `@font-face` family the theme self-hosts. Fonts are files under the
 * theme's own `assets/`, never a request to a third-party host — the generator
 * rejects an external `@import` or `url()` outright. Beyond the privacy and
 * offline story, a webfont fetched at render time is a flash of unstyled text
 * on every cold load.
 */
export interface ThemeFontFace {
  /** CSS family name, exactly as `font-family` will reference it. */
  family: string;
  /** Path relative to the theme's `assets/` directory. */
  file: string;
  weight: number | string;
  style: "normal" | "italic";
  /** Defaults to "swap". */
  display?: "auto" | "block" | "swap" | "fallback" | "optional";
}

/**
 * Paths relative to the theme's `assets/` directory. Every one is verified to
 * exist on disk by the generator — a manifest naming a missing file aborts the
 * build rather than shipping a broken <img> to every page.
 */
export interface ThemeAssets {
  /**
   * Wordmark/symbol for the menu bar. There is no dark variant: a theme has one
   * palette, so it knows what ground its own menu bar is. A dark look is a
   * separate theme shipping its own dark-ground mark.
   */
  logo?: string;
  favicon?: string;
  appIcon192?: string;
  appIcon512?: string;
  /** Thumbnail shown in the admin theme picker. */
  preview?: string;
}

/**
 * A theme may escape the contrast gate, but only by naming the exact pair and
 * why. This mirrors the `escapes` mechanism apps already use: breaking a
 * platform guarantee is possible, declared, and visible in review — never
 * silent. An unknown rule name, or a pair that actually passes, aborts the
 * build, because a stale escape reads as "reviewed" while protecting nothing.
 */
export interface ThemeEscape {
  rule: "contrast-aa";
  /** The pair id from the token contract, e.g. "primary-foreground/primary". */
  pair: string;
  reason: string;
}

/** A swatch surfaced in the admin picker so a theme is legible before it is applied. */
export interface ThemeSwatch {
  token: string;
  value: string;
}

export interface ThemeManifest {
  /** Derived from the folder name. Never declared in theme.json. */
  slug: string;
  name: string;
  description: string;
  tagline?: string;
  authors: ThemeAuthor[];
  fonts: ThemeFontFace[];
  assets: ThemeAssets;
  /** Allowlisted `.mix-*` surfaces this theme styles, cross-checked against theme.css. */
  surfaces: string[];
  escapes: ThemeEscape[];
  /** Public URL prefix for this theme's copied assets: `/themes/<slug>`. */
  assetBase: string;
  swatches: ThemeSwatch[];
  lastUpdated: number | null;
}
