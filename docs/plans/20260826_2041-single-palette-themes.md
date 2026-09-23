# One palette per theme; `mixos-dark` as a sibling theme

## Context

The theme abstraction shipped with a **two-axis** model: an admin picks a theme
*and* a mode, and a theme may declare its tokens twice — once in `:root`, once
in `:root[data-mode="dark"]`. Dark mode arrived on `feat/theme-abstraction` and
immediately produced a class of bug the model makes easy: a palette that is
correct in one block and quietly wrong in the other, plus a whole platform's
worth of chrome written against only one of them (see
[`20260826_1959-dark-mode-legibility.md`](20260826_1959-dark-mode-legibility.md)).

The two axes are collapsed into one. **A theme declares exactly one palette.**
Light is what an install gets by default; a dark look is a *different theme*
you install, not a switch you flip inside the current one.

This is a smaller system that says the same thing. "Which colours am I looking
at" already had an answer — the active theme — and the mode axis was a second,
partly-redundant answer that could disagree with the first.

## Decisions

All four confirmed with the user before starting.

- **Full rip-out, not a dormant contract.** `ThemeMode`, `ThemeModePreference`,
  the `modes` manifest field, `:root[data-mode="dark"]` support in the compiler,
  the `data-mode` attribute, the blocking `prefers-color-scheme` script, the
  admin mode picker and `assets.logoDark` all go. The alternative — leaving the
  dark block supported but unselectable — was rejected: in a system this heavily
  documented, machinery nothing reaches is worse than the churn of removing it.
- **`mixos` is the light palette, and it is the default.** The fallback theme is
  the alphabetically-first installed slug, and `mixos` sorts before
  `mixos-dark`, so a fresh install with no `platform_settings` row lands on
  light with no extra logic.
- **`mixos-dark` duplicates its assets.** A theme is self-contained — invariant
  13 forbids reaching another host and there is no cross-theme path. The three
  variable fonts and the icon set are copied into
  `themes/mixos-dark/assets/`. A shared-asset pool was considered and rejected:
  it is a theme-*system* change that weakens self-containment to save a few
  hundred KB.
- **The two themes are free to diverge.** `mixos-dark` is not a maintained
  mirror. It starts as the dark palette this branch built and is thereafter an
  independent theme that may pick its own type, radius and ramp. No sync check.
- **`color-scheme` is deliberately NOT emitted — this is a known rough edge.**
  With the mode axis gone the platform no longer knows a render is dark, so
  native UI that the CSS does not paint — scrollbars, `<select>` popups,
  autofill backgrounds, date pickers — will render light chrome inside
  `mixos-dark`. The fix is a `"appearance": "light" | "dark"` field on the
  manifest that the generator turns into `color-scheme` in the theme's `:root`.
  Explicitly deferred, not overlooked.

## Structure

### Contract — `src/lib/themes/`

`types.ts`: delete `ThemeMode` and `ThemeModePreference`. Drop `modes` from
`ThemeManifest`, `mode?` from `ThemeEscape`, and `logoDark` from `ThemeAssets`
(a dark theme's `logo` *is* its dark-ground wordmark).

`tokens.ts`: the contract itself is unchanged — the token set, the ~24 contrast
pairs and the surface allowlist all describe one palette already. Only the
prose that says "in every mode a theme ships" needs to stop saying it.

### Compiler — `scripts/theme-css.ts`

`:root` becomes the only token block. `DARK_SELECTOR`, the `dark` map, `sawDark`,
the partial-dark-block completeness check, the second `checkContrast` pass and
the `[data-mode="dark"]` rewrite all go. `checkContrast` loses its `mode`
parameter, and so do the error messages and the report lines. An escape is
matched by `pair` alone.

A theme that still carries a `:root[data-mode="dark"]` block must fail loudly
rather than silently drop it — the selector is no longer recognised, so it falls
through to `assertSurfaceSelector`, which already rejects anything that is not
an allowlisted `.mix-*` class. Worth a targeted error message so the author is
told to split the block into its own theme instead of reading a confusing one
about surfaces.

### Manifest schema — `scripts/manifest-schemas.ts`

Drop `logoDark` from `themeAssetsSchema` and `mode` from `themeEscapeSchema`.
Both are `z.strictObject`, so an old manifest carrying either now fails
validation with a message naming the field — which is the correct outcome.

### Runtime — layout, resolution, admin

`src/app/layout.tsx`: remove `data-mode`, `SYSTEM_MODE_SCRIPT` and the `<head>`
that carried it. `suppressHydrationWarning` goes with it — it existed *only*
because that script rewrote an attribute before hydration, and leaving it behind
would suppress real mismatches for free.

`src/lib/themes/active.ts`: `MODE_KEY`, the mode resolution and the
`supportsDark` clamp go. `ActiveTheme` becomes `{ theme }`; `setActiveTheme`
takes a slug only and writes one row. The `theme_mode` key is simply no longer
read or written — `platform_settings` is a generic key/value table and nothing
seeds that row, so **no migration is required**.

`src/app/(main)/admin/themes/page.tsx` and
`src/components/admin/theme-registry-list.tsx`: the "Light and dark" card and
the three-way mode control are removed; the picker becomes a list of themes and
an Apply. The per-theme caption drops `modes.join(" + ")`.

### Themes

`themes/mixos/theme.css` — keep the `:root` block exactly as it stands and
delete the dark block. The light palette is unchanged by this plan.

`themes/mixos-dark/` — new, and it inherits the dark palette built in the
previous plan rather than the one that shipped: the four-rung surface ladder,
the re-toned `--destructive` / `--success` / `--border` / `--input`, and the
`--muted`/`--background` ordering that keeps the menu bar off the content area.
That palette's `:root[data-mode="dark"]` block becomes its `:root`.

```
themes/mixos-dark/
  theme.json        name "MixOS Dark", own description/tagline
  theme.css         one :root block
  assets/           copied wholesale from themes/mixos/
  plans/README.md   the co-located plan convention
```

`themes/_template/` — one `:root` block, and the commented-out dark block and
its "dark is all-or-nothing" guidance are replaced with a note that a dark look
is a second theme.

### Docs

`themes/AGENTS.md` (invariants 4, 7, 8, 21 and the anti-pattern list),
`docs/themes/architecture.md`, `authoring.md`, `tokens.md`, `contrast.md`,
`assets.md` (the `logoDark` entry), and `scripts/generate-token-docs.ts`, which
generates the header of `tokens.md` and currently instructs authors to declare
the set twice.

`docs/apps/ux.md` — the section rewritten one plan ago for two modes is rewritten
again for one palette. `eslint.config.mjs` keeps banning `dark:` variants, but
the reason changes: not "colours fork in the theme's dark block" but "there is
no dark variant to fork into — a dark look is a different theme".

## Verification

1. `npx tsx scripts/generate-project-registry.ts` — two themes compile, each
   reporting one palette's worth of pairs. `THEME_REPORT=1` to read both tables.
2. Deliberate regression: temporarily re-add a `:root[data-mode="dark"]` block
   to a theme and confirm the build rejects it with the new message rather than
   silently ignoring it.
3. `npm run typecheck` — proves no `ThemeMode`/`modes`/`activeMode` reference
   survives anywhere.
4. `npm run lint`, `npm run build`.
5. `rg 'data-mode|ThemeMode|logoDark|theme_mode' src scripts themes docs` returns
   only the intended mentions (this plan, and the historical plans).
6. Manual: `/admin/themes` shows two themes and no mode control; switching to
   `mixos-dark` repaints the install; the sign-in page while signed out and a
   public `/api/p/` link both follow. A fresh install with no settings row lands
   on `mixos`.
