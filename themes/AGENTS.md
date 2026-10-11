# How to Create or Modify a Theme

You are about to create or modify a theme under `themes/`. **Read the sections below in order before writing any code.** The linked guides under `docs/themes/` are the authoritative reference; do not guess based on training data.

A theme repaints every app in the install at once. That is why it is the most constrained of the three abstractions: it has the widest blast radius and the smallest legitimate surface area.

**A theme change is not an OS change.** `themes/` is on the authoring side of the boundary alongside `apps/` and `connectors/` — no `os-change` label, no admin review. Commit it as `theme:<slug>`, never `os`. What *is* an OS change is touching the theme **system**: the token contract in [`src/lib/themes/tokens.ts`](../src/lib/themes/tokens.ts), the allowlisted `.mix-*` surfaces, or the compiler in [`scripts/theme-css.ts`](../scripts/theme-css.ts). Because the blast radius is what it is, look at a theme change on every surface in [Verify](#verify-run-these-before-reporting-done) before merging, signed out included. See [`../OS-UPDATES.md`](../OS-UPDATES.md).

**Before you start: write a plan.** For anything beyond a token re-tone, write a build plan to `themes/<slug>/plans/YYYYMMDD_HHMM-<plan-name>.md` first — **beside the theme it describes**, so the design history travels with the tokens. Every theme has a `plans/` directory, [`_template`](_template/plans/) included, so a scaffolded theme inherits the convention. A change to the theme *system* (the token contract, the generator, `.mix-*` surfaces) is a *platform* plan and goes to `docs/plans/` instead. See [`../docs/plans/README.md`](../docs/plans/README.md).

---

## Hard invariants (the things agents most often get wrong)

1. **Folder name *is* the slug.** It ends up in a CSS attribute selector (`[data-theme="<slug>"]`), so use lowercase letters, digits and hyphens. Do not put a `slug` field in `theme.json` — the platform derives it from the folder name.
2. **Underscore-prefixed folders are templates** (`themes/_template/`). The registry skips them. Never ship a real theme with a leading underscore. It skips dot-prefixed folders too, such as `themes/.installing-<slug>/`, where a Registry install keeps its download while checking it, so never start a theme's folder name with a dot either.
3. **A theme sets values; it never adds a utility.** The utility → variable mapping (`@theme inline`) lives in [`src/app/globals.css`](../src/app/globals.css) and is not themeable. That asymmetry is the whole point: `bg-card` means the same thing under every theme, which is what lets an app be written once and survive a rebrand untouched.
4. **Tokens live in exactly one block: `:root`.** A theme is a single palette. A custom property anywhere else, or a non-custom-property inside that block, fails the build. `:root[data-mode="dark"]` is rejected with a message telling you to split it into its own theme — the light/dark mode axis was collapsed into the theme axis, so a dark look is a sibling theme an admin selects, never a second block. See [`../docs/plans/20260826_2041-single-palette-themes.md`](../docs/plans/20260826_2041-single-palette-themes.md).
5. **The token set is closed.** Every name is in [`src/lib/themes/tokens.ts`](../src/lib/themes/tokens.ts) and rendered in [`docs/themes/tokens.md`](../docs/themes/tokens.md). An unknown token is a build error, because a typo'd property is not a no-op — it is a token that keeps its old value while you believe you changed it.
6. **Every required token must be present.** An undefined custom property does not fall back to something sensible; it renders as `unset`, which is a transparent surface or invisible text.
7. **A dark counterpart is a separate theme, and a full one.** Copy the folder to `themes/<slug>-dark/`, including its `assets/` — a theme is self-contained and there is no cross-theme asset path. It gets its own manifest, its own contrast run, and no obligation to stay in step with its sibling.
8. **Contrast is verified at build time and failure aborts the build.** ~24 pairs per theme, computed not tabulated. Status colours are checked in *both* directions — as text on the page, and as a filled surface under their own foreground. Passing one and failing the other is the single most common way a palette ships unreadable.
9. **Every colour value must be evaluable at build time.** Hex, `rgb()`, `hsl()`, or a `var()` chain ending in one. `color-mix()` and `oklch()` are rejected *in token values* — not because they are bad CSS, but because a value the build cannot read is a token the contrast gate silently stops covering, and the build would still report success. This covers every colour token, gated or not (`--border`, `--muted`, `--brand-*`). A value must also be opaque, because a translucent one has no single colour to measure. The one exception is `--border`, which is ungated: it may be translucent, and the build composites it over `--background` wherever it evaluates it. A `var()` naming a token `:root` never sets fails the build.
10. **Escaping the gate is possible, declared, and visible.** Name the exact pair in `theme.json` under `escapes: [{ rule: "contrast-aa", pair, reason }]`. An escape for a pair that *passes* is also a build error — a stale escape reads as "reviewed and accepted" to the next person while protecting nothing.
11. **Beyond tokens, only the `.mix-*` surfaces may be styled.** `.mix-app-shell` `.mix-menubar` `.mix-card` `.mix-widget` `.mix-page-header` `.mix-button` `.mix-input` `.mix-modal` `.mix-popover` `.mix-table`. Their states and combinations between them are fine; an id, a bare element, or any other class is a build error. Otherwise app internals become an accidental public API that a refactor breaks with no way to notice.
12. **`surfaces` in `theme.json` must match `theme.css` exactly** — in both directions. The manifest is how a reviewer sees a theme's reach without reading its CSS; it has to be accurate to be worth anything.
13. **A theme is self-contained.** No `@import`, and no `url()` to another host. Ship fonts, images and icons under the theme's own `assets/`. This is not a style preference: an external `url()` is a third-party request on every page load and a channel for a theme to phone home.
14. **No colour is environment-conditional.** The theme renders identically on localhost and in production. `FORBIDDEN_TOKENS` (in `src/lib/themes/tokens.ts`) is the hook for a value that must survive a theme change; it is empty today.
15. **`--brand` is a surface, not an accent.** The menu bar and the sign-in page sit on it in every theme, so `--brand-foreground` and `--brand-accent` are measured against `--brand`, never against the page. A brand colour that only works on white does not belong in `--brand-accent`.
16. **`--border` is ungated; `--input` and `--ring` are not.** WCAG 1.4.11 covers components that convey information or state. A hairline between two rows is decoration; a control's boundary and a focus ring are not.
17. **Do not hand-edit `src/generated/theme-registry.ts`, `themes.css`, or `theme-tokens.json`.** All three are produced by [`scripts/generate-project-registry.ts`](../scripts/generate-project-registry.ts). Run the generator after changes.
18. **Do not hand-edit `lastUpdated` in `theme.json`.** It is stamped by `.githooks/pre-commit` (via `scripts/stamp-updated.ts`) on any commit touching the theme, and re-staged into that commit. A merge that only brings in another branch's change to the theme keeps that branch's date.
19. **One theme is active for the whole install.** An admin selects it at `/admin/themes`; there is no per-user override and no light/dark switch beside it — the theme slug is the whole appearance decision. It paints the signed-out sign-in page and the public `/p/` app pages too, and supplies the favicon — none of which has a current user whose preference could be read. A fresh install with no setting resolves to the alphabetically-first theme, which is `mixos`.
20. **Switching a theme is a database write, not a rebuild.** Every installed theme is bundled into `src/generated/themes.css` scoped to `[data-theme="<slug>"]`; the active slug is stamped on `<html>` by the root layout. Do not add build steps that assume a single theme.

21. **Listing screenshots live in `screenshots/`, not in `assets/`, and do not replace `preview`.** Declare them in `theme.json` as `screenshots: [{ file, alt?, caption? }]` with files under `themes/<slug>/screenshots/`. Keeping them out of `assets/` is load-bearing — `assets/` is copied wholesale to `/themes/<slug>/`, so a screenshot filed there gets two public URLs. `assets.preview` stays what it is: the admin picker's thumbnail, shown beside a live swatch row and a type specimen. `screenshots` is the catalogue gallery, seen by someone who has not installed the theme and for whom none of those swatches exist. Limits are the same as an app's: `.png`/`.jpg`/`.webp` (no SVG), max 8, max 2 MB, min 640px wide, all build-enforced; `url`, `width` and `height` are measured, never hand-written. See [`docs/themes/assets.md`](../docs/themes/assets.md#screenshots).

22. **`assets.logo` is a default; `branding` is a claim.** Apps may replace `assets.logo` through the brand hooks. A slot declared under `branding: { name?, menuBarLogo?, loginLogo? }` is final, and no app filter runs for it. Every logo is measured so it can be drawn at its own aspect ratio: an SVG needs a `viewBox` (or an absolute `width` and `height`) on its root, and anything else must be a `.png`, `.jpg` or `.webp`. Claim only what the theme owns: a claimed name follows every install that selects the theme. See [`docs/themes/assets.md`](../docs/themes/assets.md#claiming-the-brand).

Authoritative types: [`src/lib/themes/types.ts`](../src/lib/themes/types.ts). Token contract: [`src/lib/themes/tokens.ts`](../src/lib/themes/tokens.ts). Canonical template: [`themes/_template/`](_template/).

---

## Guides (read in order)

1. [Architecture](../docs/themes/architecture.md) — directory layout, `theme.json`, how a theme reaches the browser
2. [Authoring](../docs/themes/authoring.md) — building a theme start to finish, including from a brand book
3. [Tokens](../docs/themes/tokens.md) — the full contract, every token and what reads it
4. [Contrast](../docs/themes/contrast.md) — what is checked, why, and what to do when a brand colour fails
5. [Assets](../docs/themes/assets.md) — self-hosted fonts, logos, favicons, previews

Creating an **app** instead? See [`../apps/AGENTS.md`](../apps/AGENTS.md). A **connector**? See [`../connectors/AGENTS.md`](../connectors/AGENTS.md).

---

## Verify (run these before reporting done)

From the repo root:

1. `npx tsx scripts/generate-project-registry.ts` — schema-validates `theme.json`, validates and compiles `theme.css`, verifies every asset exists, and computes every contrast pair. Any violation aborts the whole build with a message pointing at the offending token or selector. A Registry install runs these same checks on its download before anything reaches `themes/`.
2. `THEME_REPORT=1 npx tsx scripts/generate-project-registry.ts` — prints the full ratio table. Read it; a pair that scrapes past at 4.51:1 is worth a second look even though it passes.
3. `npm run typecheck` and `npm run lint`. The lint rule `mos-design/no-low-contrast-token-pairs` reads your theme's tokens and re-derives per-element ratios — it catches the pairs the build cannot see, because whether `text-muted-foreground` lands on `bg-muted` is a property of the markup, not of the theme.
4. `npm run build` — proves the CSS actually compiles through Tailwind and Lightning CSS.
5. Activate the theme at `/admin/themes` and load: the dashboard, an app page, a form, a table, a modal, **the sign-in page while signed out**, and an app's public `/p/<app-slug>` page. Don't claim done on a theme you haven't looked at signed out — that page has no menu bar and is the one surface authors forget.
6. Hard-reload and confirm the first paint is already in the theme's colours, with no flash.
7. Check the network tab for requests to a font or asset host. There should be none.

---

## Anti-patterns (do not do these)

- Adding a `dark:` variant anywhere. There is nothing for it to fork into: a theme has one palette, and a dark look is a different theme.
- Selecting an app's internal class, an id, or a bare element from `theme.css`.
- Declaring a token the platform does not read, or misspelling one that it does.
- Shipping a `:root[data-mode="dark"]` block. The build rejects it; author a sibling theme instead.
- Using `color-mix()` or `oklch()` in a token value to work around the contrast gate.
- Declaring an escape without a reason a reviewer can act on, or leaving one behind after the pair was fixed.
- Reusing `--destructive` / `--warning` / `--success` in the categorical ramp.
- Reaching for an external font host instead of shipping the file.
- Hand-editing anything in `src/generated/`.
- Assuming there is only ever one installed theme.
