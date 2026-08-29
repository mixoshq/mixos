# Theme assets

Everything a theme ships beyond CSS lives in `themes/<slug>/assets/` and is copied to `public/themes/<slug>/` by the generator. Reference it from `theme.css` with a path relative to `assets/`; the compiler rewrites it to the public URL.

```css
src: url("fonts/inter-variable.woff2") format("woff2-variations");
/* becomes */
src: url("/themes/mixos/fonts/inter-variable.woff2") format("woff2-variations");
```

## No external hosts

A theme may not `@import` or `url()` another host. `data:` URIs are fine — they are self-contained.

This is a hard rule with two reasons behind it. A third-party asset is a request on **every page load** for every user, and a webfont fetched at render time is a flash of unstyled text on every cold load. It is also a channel: a theme is CSS, and CSS that can reach the network can report who loaded it and when.

The platform previously pulled Roboto from `fonts.googleapis.com` in `globals.css`. Self-hosting three variable fonts replaced it with about 107 KB served from the same origin.

## Fonts

Declare each family in `theme.json` **and** `@font-face` it in `theme.css`. The build cross-checks: a manifest entry nobody `@font-face`s is a file shipped to every user for nothing, and an `@font-face` with no manifest entry hides a dependency from review.

```jsonc
"fonts": [
  { "family": "Inter", "file": "fonts/inter-variable.woff2",
    "weight": "300 600", "style": "normal", "display": "swap" }
]
```

**Prefer variable fonts and the latin subset.** One file covers a whole weight range, which is usually the difference between one request and five. When pulling from Google Fonts, take the URL from the block after the `/* latin */` comment — the first block in the response is typically Cyrillic, and grabbing it yields a file that renders nothing.

`font-display: swap` unless you have a specific reason; the alternative is invisible text while the font loads.

## Logo and wordmark

```jsonc
"assets": { "logo": "logo.svg" }
```

SVG, ideally. The mark renders at 32px in the menu bar and again as a favicon, and a raster that looks right at one size rarely does at the other.

When `assets.logo` is absent, the menu bar falls back to the text wordmark in `--type-heading`. That is a legitimate shipping state, not a broken one — most brand books specify a text wordmark treatment precisely for this.

Usage restrictions a brand book states ("never on violet") cannot be enforced by CSS. Record them in a comment beside the asset so the next author sees them.

## Favicon and app icons

```jsonc
"assets": { "favicon": "favicon.svg", "appIcon192": "icon-192.png", "appIcon512": "icon-512.png" }
```

Wired through Next metadata in the root layout. These follow the **active** theme, which is coherent only because one theme is active for the whole install — a per-user theme could not change a favicon for everyone.

Omit them and `public/` keeps serving the existing icons. The layout deliberately leaves `icons` undefined rather than passing an empty array, which would override Next's default discovery with nothing.

## Preview

```jsonc
"assets": { "preview": "preview.png" }
```

Optional. The admin picker already renders a live swatch row from the theme's own resolved tokens, plus a specimen of each `--type-*` role set in its own family — both more honest than a screenshot, and neither can go stale. A preview image is worth adding only when the theme's distinction is something colour and type cannot show: a texture, a shadow treatment, a border language.

## Verification

Every path in `assets` and `fonts` is checked to exist on disk. A manifest naming a missing logo does not degrade gracefully — it ships a broken image into the menu bar of every page in the install — so it aborts the build instead.
