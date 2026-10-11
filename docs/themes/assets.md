# Theme assets

Everything a theme ships beyond CSS lives in `themes/<slug>/assets/` and is copied to `public/themes/<slug>/` by the generator. Reference it from `theme.css` with a path relative to `assets/`; the compiler rewrites it to the public URL.

```css
src: url("fonts/inter-variable.woff2") format("woff2-variations");
/* becomes */
src: url("/themes/mixos/fonts/inter-variable.woff2") format("woff2-variations");
```

## No external hosts

A theme may not `@import` anything, or `url()` another host. `data:` URIs are fine — they are self-contained.

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

SVG, ideally: the same mark is drawn 23px high in the menu bar and 69px high on
the sign-in page, and a vector is sharp at both. Each time it keeps its own
aspect ratio, capped at 160px and 240px wide.

The build measures the file to know that ratio. For an SVG, it reads the root
element's absolute `width` and `height`, or failing those its `viewBox`. An SVG
that states neither fails the build, so give the mark a `viewBox`. A `.png`,
`.jpg` or `.webp` also works; export it at least 138px high, so it stays sharp at
2x on the sign-in page.

When `assets.logo` is absent, the menu bar falls back to the text wordmark in `--type-heading`. That is a legitimate shipping state, not a broken one — most brand books specify a text wordmark treatment precisely for this.

`assets.logo` is a **default**. An active app with a brand filter may replace it,
in the menu bar, on the sign-in page, or both. To stop that, claim the slot.

## Claiming the brand

```jsonc
"branding": {
  "name": "Acme Workspace",
  "menuBarLogo": "acme-bar.png",
  "loginLogo": "acme-login.png"
}
```

All three fields are optional, and each one you set is final. The platform uses
it as is and never runs an app's brand filter for that slot. Slots you leave out
stay open to apps, which start from "MixOS" and `assets.logo`.

- `name` replaces "MixOS" in the menu bar, on the sign-in page, in the welcome
  tour, in the tab title and as the installed PWA's name. One line, up to 40
  characters.
- `menuBarLogo` and `loginLogo` are paths inside `assets/`, under the same rules
  as `assets.logo`. They let the two places use different marks, for example a
  symbol in the bar and a full lockup on the sign-in page. When they differ, the
  welcome tour fades the sign-in mark rather than flying it into the bar.

Claim only what the theme genuinely owns. A palette theme that claims the name
takes that choice away from every install that selects it.

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

When a theme declares one, the picker shows it at the top of the theme's tile, above the swatch row, cropped to 16:9 and keeping its top-left corner. Compose it in that shape, with what matters at the top left.

## Screenshots

```jsonc
"screenshots": [
  {
    "file": "screenshots/dashboard.png",
    "alt": "The dashboard, with the menu bar sitting on --brand",
    "caption": "Menu bar and widgets"
  },
  { "file": "screenshots/sign-in.png" }
]
```

Files live in `themes/<slug>/screenshots/` — a sibling of `assets/`, **not** inside it. That separation is load-bearing: `assets/` is copied wholesale to `/themes/<slug>/`, so a screenshot filed there would end up with two public URLs.

### Not a replacement for `preview`

Both survive, because they answer different questions, and the difference is about what the viewer can already see.

`assets.preview` is the **admin picker** thumbnail. It sits beside a live swatch row and a type specimen, both rendered from this theme's own resolved tokens — which is exactly why the picker needs so little of it, and why the section above says a preview image earns its place only when the theme's distinction is something colour and type cannot show.

`screenshots` is the **listing gallery**, read by someone who has not installed the theme. None of those swatches exist for them; there is no live anything. A picture is all there is. So this is where a theme shows what its token table cannot: how the menu bar sits on `--brand`, what a table looks like at density, what the sign-in page does.

Worth including — they are the surfaces you are asked to review before merging anyway: a page with a table, a form, and **the sign-in page signed out**, which is the surface theme authors forget and the first one every user sees.

### What the build enforces

| Rule | Limit |
| --- | --- |
| Format | `.png`, `.jpg`, `.jpeg`, `.webp` — no SVG |
| Count | 8 |
| File size | 2 MB each |
| Minimum width | 640px |

Any violation aborts the build with a message naming the file and the measured value. `alt` and `caption` are optional; `url`, `width` and `height` are filled in by the build from the file itself.

Declared files are copied to `/screenshots/themes/<slug>/<name>` and served without authentication, for the same reason theme assets are: a listing is read before anything is installed. Only declared files are copied, so a draft left in the directory stays local.

## Verification

Every path in `assets` and `fonts` is checked to exist on disk. A manifest naming a missing logo does not degrade gracefully — it ships a broken image into the menu bar of every page in the install — so it aborts the build instead. Declared `screenshots` are verified and measured in the same pass.
