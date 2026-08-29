# Theme architecture

A theme is the third first-class abstraction in this repo, alongside apps and connectors, and it follows their conventions deliberately: folder-name-is-slug, one schema-validated manifest, `_`-prefixed templates skipped, `lastUpdated` stamped by the pre-commit hook, a generated registry nobody hand-edits.

## Directory layout

```
themes/
  AGENTS.md                  the authoritative guide
  _template/                 scaffold; skipped by the registry
  mixos/
    theme.json               manifest — schema-validated at build time
    theme.css                tokens + allowlisted .mix-* surfaces
    assets/
      fonts/*.woff2
      logo.svg               optional
      favicon.svg            optional
      preview.png            optional
```

## What a theme controls, and what it cannot

| | Owned by |
|---|---|
| Token **values** — colour, radius, type stacks | the theme |
| Styling of the ten `.mix-*` surfaces | the theme |
| Fonts, logo, favicon | the theme |
| The utility → variable mapping (`@theme inline`) | the platform |
| Which token a component uses | the platform |
| Layout, spacing scale, component structure | the platform |

The asymmetry in the first and fourth rows is the load-bearing design decision. A theme supplies values; it can never add or remove a Tailwind utility. That is what makes `bg-card` mean the same thing under every theme, and it is why an app written once against the token names survives a rebrand without being touched.

## How a theme reaches the browser

```
themes/<slug>/theme.css
        │
        │  scripts/theme-css.ts  — postcss parse
        │    · reject unknown tokens, foreign selectors, external url()
        │    · assert the required token set is complete
        │    · compute WCAG ratios for every declared pair
        │    · rewrite :root → [data-theme="<slug>"]
        │    · rewrite url() → /themes/<slug>/…
        ▼
src/generated/themes.css        every installed theme, concatenated
src/generated/theme-registry.ts names, fonts, assets, swatches, typefaces
src/generated/theme-tokens.json resolved values, read by the lint rule
public/themes/<slug>/…          assets, copied
        │
        │  @import in src/app/globals.css
        ▼
<html data-theme="mixos">
```

Every installed theme is bundled. Switching the active one is a row in `platform_settings` and an attribute on `<html>` — not a rebuild, not a redeploy.

## Selection

One theme is active for the entire install, chosen by an admin at `/admin/themes`. There is no per-user override, and that is a deliberate simplification rather than a missing feature: the sign-in page, the public `/api/p/` app surfaces, and the favicon all have to render correctly with no current user to read a preference from.

**There is no mode axis.** A theme declares exactly one palette, so the theme slug is the whole appearance decision — `mixos` is light, `mixos-dark` is dark, and an admin picks one.

That used to be two axes: a theme could declare its tokens a second time under `:root[data-mode="dark"]`, and a separate `theme_mode` setting chose light / dark / system. Collapsing them removed a class of bug rather than a feature. Two answers to "which colours am I looking at" could disagree; a palette in a block nobody had selected was a palette nobody had looked at (that is how a 2.00:1 `--destructive` survived); and `system` needed a blocking inline script in `<head>` to resolve `prefers-color-scheme` before first paint. One palette per theme deletes all three — the active theme is a server value, so `data-theme` is correct in the first byte of HTML with nothing left to resolve on the client. See [`docs/plans/20260826_2041-single-palette-themes.md`](../plans/20260826_2041-single-palette-themes.md).

**Known gap:** because nothing now tells the browser a render is dark, native UI the CSS does not paint — scrollbars, `<select>` popups, autofill, date pickers — renders light chrome under a dark theme. The fix is an `appearance` field on the manifest that the generator turns into `color-scheme`; it is deferred, not overlooked.

`getActiveTheme()` ([`src/lib/themes/active.ts`](../../src/lib/themes/active.ts)) is wrapped in React `cache()`, so a page with a layout, a header and a dozen server components makes one query. It degrades in two directions on purpose: an unreachable database falls back to the bundled default rather than 500-ing the sign-in page, and a slug naming an uninstalled theme resolves to the fallback rather than to nothing.

## No environment-conditional colour

Every colour the UI renders comes from the active theme, in every environment. A local tab and a production tab are visually identical; the menu bar carried an off-brand band on localhost until that was deliberately dropped in favour of one consistent look.

`FORBIDDEN_TOKENS` in [`src/lib/themes/tokens.ts`](../../src/lib/themes/tokens.ts) is empty but retained: it is where a value that must survive a theme change would go.

## Related

- [Authoring](authoring.md) · [Tokens](tokens.md) · [Contrast](contrast.md) · [Assets](assets.md)
- [`themes/AGENTS.md`](../../themes/AGENTS.md) — the invariants
- [`docs/apps/ux.md`](../apps/ux.md) — how an app is expected to consume tokens
