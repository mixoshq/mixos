# Theme abstraction

## Context

MixOS has a token system but no theme system. [`src/app/globals.css`](../../src/app/globals.css)
maps Tailwind v4 utilities to CSS custom properties via `@theme inline`, and
invariant 22 in [`apps/AGENTS.md`](../../apps/AGENTS.md) makes "no raw hex, no
`dark:` variants" a lint error for `apps/**`. So every app in the install
already renders entirely through tokens — the values are simply hardcoded in one
file, and the `.dark` block has never been reachable (nothing sets the class;
`<html>` in `layout.tsx` is bare).

This adds `themes/` as a third first-class abstraction alongside `apps/` and
`connectors/`, and rebrands the platform onto the MixOS brand guidelines
(slate + cyan, Plus Jakarta Sans / Inter / JetBrains Mono) as the first theme.

## Decisions (locked with the user)

| Decision | Choice |
|---|---|
| Layout | `themes/<slug>/theme.json` + `theme.css` + `assets/`, mirroring `apps/` and `connectors/` |
| Manifest name | `theme.json` (singular, matching `app.json` / `connector.json`) |
| Slug | Folder name is the slug; `_`-prefixed folders are templates and are skipped |
| Power | Token allowlist + an allowlisted set of `.mix-*` surface classes. Any other selector or custom property is a build error |
| Authoring | Plain modern CSS. Lightning CSS already runs via Tailwind v4 — nesting, `color-mix()`, relative color. No Sass, no PostCSS mixin plugins, no new deps |
| Modes | One theme ships a light block and an optional dark block. `light` / `dark` / `system` is a separate axis |
| Selection | **One active theme for the whole install**, admin-selected. No per-user override |
| Signed-out surfaces | Themed — login page and `/api/p/` public app pages included |
| Distribution | In-repo, build-time. A new theme is authored in the repo and ships on deploy |
| Assets | Self-hosted fonts, logo/wordmark, favicon + PWA icons, preview thumbnail |
| Contrast | Generator computes WCAG ratios for every declared pair; AA failure aborts the build |
| Default | The brand-guidelines theme **replaces** today's navy/coral entirely |
| Tooling | `/mix-theme` command + `themes/AGENTS.md` + `docs/themes/*` |

The one active theme means no cookie, no per-user preference table, and no
favicon ambiguity — the favicon is simply the active theme's.

## Non-negotiables

- `@theme inline` (the utility → variable mapping) stays in `globals.css`. Only
  the *values* move into themes. A theme can never add or remove a utility.
- No external `@import` and no `url()` outside the theme's own `assets/`.
  Today's `@import url('https://fonts.googleapis.com/...')` is deleted; fonts
  are self-hosted, which also removes a third-party request from every page load.

## Structure

### 1. `themes/`

```
themes/
  AGENTS.md                 authoritative guide (mirrors apps/ and connectors/)
  _template/
    theme.json
    theme.css
    assets/
  mixos/                    the new default
    theme.json
    theme.css
    assets/
      fonts/*.woff2         Plus Jakarta Sans, Inter, JetBrains Mono
      logo.svg  logo-dark.svg
      favicon.svg  icon-192.png  icon-512.png
      preview.png
```

### 2. `theme.json`

Validated by a new `RawThemeManifestSchema` in
[`scripts/manifest-schemas.ts`](../../scripts/manifest-schemas.ts), `strictObject`
like the other two, so an unknown field aborts the build.

```jsonc
{
  "name": "MixOS",
  "description": "…",                  // shown in the admin picker
  "tagline": "Where Apps and Connectors Flow Together.",
  "authors": [{ "name": "…", "email": "…" }],
  "modes": ["light", "dark"],
  "fonts": [ { "family": "Plus Jakarta Sans", "files": [{ "weight": 500, "style": "normal", "file": "fonts/…woff2" }] } ],
  "assets": { "logo": "logo.svg", "logoDark": "logo-dark.svg", "favicon": "favicon.svg",
              "appIcon192": "icon-192.png", "appIcon512": "icon-512.png", "preview": "preview.png" },
  "surfaces": [".mix-menubar", ".mix-card"],   // declared, cross-checked against theme.css
  "escapes": [{ "rule": "contrast-aa", "pair": "…", "reason": "…" }],
  "lastUpdated": "…"                   // stamped by .githooks/pre-commit, never by hand
}
```

`slug` is **not** a field — it is the folder name, exactly as for apps.

### 3. Token contract — `src/lib/themes/tokens.ts`

Single source of truth: the required token list, each token's role, and the
contrast pairs to verify. The pairs are the ones already annotated by hand in
`globals.css` (foreground-on-background, `*-foreground`-on-`*`, each `cat-n`
as text on background). This file is what the generator, the docs page, and the
`/mix-theme` command all read, so the token list can never drift between them.

### 4. Surface classes (`.mix-*`)

The allowlist a theme may style beyond tokens:

`.mix-app-shell` · `.mix-menubar` · `.mix-card` · `.mix-widget` ·
`.mix-page-header` · `.mix-button` · `.mix-input` · `.mix-modal` ·
`.mix-popover` · `.mix-table`

These hooks get added to the primitives in [`src/components/ui/`](../../src/components/ui/)
and the shell components. A theme may also target `:hover` / `:focus-visible` /
`[data-state]` on an allowlisted class and its own descendants; anything else
(an app's internal class, a bare element, `*`) is a build error, so app
internals never become an accidental public API.

### 5. Generator — `scripts/generate-project-registry.ts`

New `collectThemes()` pass, run alongside apps and connectors:

1. Read `themes/*/theme.json`, skip `_`-prefixed, schema-validate.
2. Parse `theme.css` with **postcss** (already in `node_modules` via
   `@tailwindcss/postcss` — no new dependency).
3. Enforce the selector allowlist and the custom-property allowlist.
4. Assert every required token is present in the light block, and in the dark
   block if `modes` includes `dark`.
5. Compute WCAG ratios for every pair in the token contract. Anything under
   4.5:1 aborts unless `escapes` names that exact pair with a reason.
6. Assert every asset named in the manifest exists on disk.
7. Rewrite `:root` → `[data-theme="<slug>"]` and the dark block →
   `[data-theme="<slug>"][data-mode="dark"]`, rewrite `url()` to
   `/themes/<slug>/…`, and emit `src/generated/themes.css`. Every installed
   theme is bundled, so switching the active theme is a DB write, not a rebuild.
8. Copy `themes/<slug>/assets/**` → `public/themes/<slug>/**`.
9. Emit `src/generated/theme-registry.ts` (name, description, slug, modes,
   fonts, assets, swatches for the admin picker).

### 6. Storage — no migration needed

`public.platform_settings (key, value, updated_at)` has existed since
`0001_initial.sql`, where it already holds `scheduler_enabled`, and 0001's RLS
do-block already covers it. Keys added: `theme` (slug) and `theme_mode`
(`system` | `light` | `dark`). Not `app_settings` — that is app-scoped
(`primary key (app_slug, key)`).

### 7. Runtime

- `src/lib/themes/active.ts` — `getActiveTheme()`, request-cached, falling back
  to the registry's default if the DB row is missing or names a theme that is no
  longer installed.
- `src/app/layout.tsx` — stamps `<html data-theme={slug} data-mode={mode}>` on
  the server, so there is no flash. When mode is `system`, a tiny inline script
  resolves `prefers-color-scheme` before first paint.
- `src/app/globals.css` — keeps `@theme inline`, the localhost band, the
  keyframes and the react-grid rules; imports `src/generated/themes.css`.
- `layout.tsx` metadata icons and the header wordmark read from the registry.

### 8. Admin UI

`src/app/(main)/admin/themes/page.tsx` + `src/components/admin/theme-registry-list.tsx`,
matching the Connector Registry: preview thumbnail, swatch row, font list, an
Activate button, and the light/dark/system selector. Server action guarded by
`requireAdmin()`.

### 9. Brand-utility rename

`bg-mixnavy` / `bg-mixcoral` name a *colour*, which is incoherent once colours
come from a theme — the new brand has no navy. They become `bg-brand` /
`bg-brand-accent` reading from `--brand` / `--brand-accent`. 47 call sites
across 23 files; mechanical. `mixlocal` keeps its name — it is deliberately
not themeable.

### 10. Docs & tooling

- `themes/AGENTS.md` — hard invariants, mirroring the other two guides.
- `docs/themes/architecture.md`, `authoring.md`, `tokens.md` (generated token
  reference), `assets.md`, `contrast.md`.
- `.claude/commands/mix-theme.md` — create / modify / review a theme.
- Pointers added to root [`AGENTS.md`](../../AGENTS.md) and the two sibling guides.

## The MixOS theme (from the brand guidelines)

Palette: Slate `#0F172A` · Cyan `#0284C7` · Teal `#0D9488` · Violet `#7C3AED`.
Fonts: Plus Jakarta Sans (brand/headings), Inter (UI/body), JetBrains Mono (code).

**Measured against the AA rule this plan adopts** (ratios computed, not assumed):

| Brand colour | as text on white | verdict |
|---|---|---|
| Slate `#0F172A` | 17.85:1 | passes |
| Violet `#7C3AED` | 5.70:1 | passes |
| Cyan `#0284C7` | 4.10:1 | **fails AA text** (passes 3:1 large-text) |
| Teal `#0D9488` | 3.74:1 | **fails AA text** |
| Emerald `#10B981` | 2.54:1 | fails — cannot be `--success` in light mode |
| Red `#EF4444` | 3.76:1 | fails — cannot be `--destructive` in light mode |

Resolution, following the precedent already in `globals.css` (literal brand
tokens separate from semantic role tokens):

- `--brand: #0F172A`, `--brand-cyan: #0284C7`, `--brand-teal: #0D9488`,
  `--brand-violet: #7C3AED` — the literal brand values, legal for large text
  (≥24px/18.66px bold), section numerals, and non-text accents such as rules
  and chart marks.
- `--primary: #0369A1` in light mode — cyan-700, **on the brand's own cyan
  ramp**, 5.93:1 both as text and as a surface under white.
- `--primary: #38BDF8` in dark mode — cyan-400 on slate, 8.33:1. The brand is
  materially stronger in dark mode; every accent clears AA there at its
  published value.
- `--success` / `--destructive` / `--warning` take AA-clearing values in light
  mode and the brand's own light ramp values in dark mode, exactly as the
  existing `.dark` block already does.

## Verification

1. `npx tsx scripts/generate-project-registry.ts` — theme appears; assets copied.
2. Negative tests: temporarily set a failing token pair and confirm the build
   aborts naming the pair and ratio; add a disallowed selector to `theme.css`
   and confirm the build aborts naming the selector.
3. `npm run typecheck` and `npm run lint`.
4. `npm run db:push`, then set the active theme at `/admin/themes`.
5. Load `/`, an app page, `/admin/themes`, the login page, and a public
   `/api/p/` app page. Toggle light / dark / system. Confirm no flash of the
   wrong theme on hard reload, and confirm the localhost band is unchanged.
6. Confirm no request to `fonts.googleapis.com` remains in the network tab.

## Outcome

Built and verified against a running local stack (`npm run dev:docker`):
all migrations applied, admin seeded, credentials login returning a session,
and `/admin/themes` rendering and persisting. Generator, `typecheck`, `lint` and `build` are green; the
emitted CSS carries `[data-theme=mixos]` and `[data-theme=mixos][data-mode=dark]`
scoped blocks, `url()` rewritten to `/themes/mixos/…`, and `.bg-primary` compiled
to `background-color: var(--primary)` — which is what makes switching a theme an
attribute change rather than a rebuild. 48 contrast pairs pass across the two
modes. Five negative tests confirmed the gate bites: a sub-AA brand colour, a
typo'd token, a selector reaching an app internal, a theme repainting the
localhost band, and an external font host.

### Decisions that changed during the build

1. **`--border` is ungated.** The contract originally held every non-text token
   to 3:1, which the platform's own `#E2E8F0` divider fails at 1.23:1 — as does
   every design system's. WCAG 1.4.11 covers components conveying information or
   state; a hairline between rows is decoration. `--input` and `--ring` stay
   gated, and `--input` moved to `#64748b` to actually clear 3:1.
2. **`--brand-foreground` added; `--brand-accent` is measured against `--brand`.**
   The menu bar and the sign-in page sit on the brand surface in every theme, so
   an accent that only works on white is the wrong value there. This is why the
   MixOS `--brand-accent` is cyan-400 rather than the published cyan.
3. **Font tokens are `--type-*`, not `--font-*`.** `--font-*` is Tailwind v4's
   own theme namespace: a theme setting `--font-sans` would collide with the key
   that *defines* the utility rather than feed it.
4. **The eslint contrast rule was repointed.** It parsed tokens out of
   `globals.css`, which no longer holds any — it would have silently no-opped.
   It now reads the generated `theme-tokens.json`, and learned that
   `--brand-foreground` / `--brand-accent` composite over `--brand` rather than
   over the page (without which `text-brand-foreground/70` on the menu bar
   reports a false 1.03:1).
5. **`/themes/` is exempt from the proxy's auth redirect.** Theme fonts were
   returning 307 to `/login` — leaving the sign-in page, the one page every user
   sees before having a session, as the one page rendering unstyled.

### Bugs found and fixed en route

`bg-mixcharcoal` and `bg-mixgrey` — 26 uses across the codebase, including the
**sign-in page background and the menu bar band** — were never defined in
`@theme`. Tailwind generated no rule for either, so both surfaces were rendering
transparent. They were folded into `bg-brand` / `bg-primary` by the utility
migration (89 references across 30 files). Three element-level contrast failures
surfaced by the re-pointed lint rule were fixed at the same time.

A hydration mismatch on `<html data-mode>`: the blocking mode script rewrites
the attribute before React hydrates, which is the point of it being blocking.
Resolved with `suppressHydrationWarning` on that element only.

### Later change: no environment-conditional colour

The localhost menu-bar band (`--brand-local` / `--brand-local-mark`, an
off-brand purple with a yellow mark) was removed at the user's direction, along
with the "LOCAL" caption and `src/lib/env/local-host.ts`. The theme now renders
identically in every environment. `FORBIDDEN_TOKENS` is kept but empty — it is
the hook for any future value that must survive a theme change.

The tradeoff was raised and overridden: that band was the only at-a-glance
signal separating a local tab from production.

Removing it broke the build in a way worth recording. `isLocalRequest()` read
`headers()`, which had been opting the entire `(main)` segment into dynamic
rendering **as a side effect**. With it gone, `/apps/guide` tried to prerender
at build time and failed reaching Supabase. `(main)/layout.tsx` now declares
`export const dynamic = "force-dynamic"` directly, and `/login` — which reads
the active theme from the database — declares it too, having lost its previous
`force-dynamic` when `isSsoEnabled()` was removed. A statically prerendered
login page would have frozen the theme and logo at build time.

### Icons

The menu bar and sign-in page carry the theme's logo, and the favicon, Apple
touch icon and PWA icons are generated from that same mark onto the brand
ground. `src/app/icon.svg`, `apple-icon.png` and the static
`manifest.webmanifest` were deleted: Next's file-convention icons take
precedence over `metadata.icons`, so leaving them would have pinned the tab icon
to the old placeholder forever. `manifest.webmanifest` became `manifest.ts`,
generated from the active theme.

Maskable icons are full-bleed with the mark inset to ~60% for the safe zone;
`any` and `maskable` are declared as separate entries rather than the spec's
`"any maskable"`, both because Next's type accepts one purpose per entry and
because a maskable source rendered unmasked looks over-padded.

### A mistake of mine, and what it cost

The first version of this work added `0007_platform_settings.sql` creating
`public.platform_settings` — **a table that had existed since 0001**. Because it
was written `create table if not exists`, it applied as a silent no-op, and the
generator, typecheck, lint, build and a live read-path check all passed.

What it hid: `setActiveTheme()` wrote an `updated_by` column that the real
table does not have, so the "Apply to everyone" button would have failed on its
first click with `column "updated_by" of relation "platform_settings" does not
exist`. Every check that passed had exercised the READ path only.

Two lessons worth keeping:

- `create table if not exists` in a new migration deserves suspicion. If the
  table is genuinely new the guard is decoration; if it is not, the guard is
  what turns a loud collision into a silent one.
- A feature that reads and writes is not verified until the write has run
  against the real schema. Booting the stack is what caught this; no amount of
  static checking would have.

The migration was deleted (nothing about the theme feature needs a schema
change), `0008_remove_sso.sql` was renumbered to `0007_remove_sso.sql`, and
`updated_by` was dropped from the write — matching `scheduler.ts`, which has
always written this table with the three columns it actually has.

## Open

- **The logo is a 256px PNG.** `themes/mixos/assets/logo.png` renders on the
  sign-in page and is served optimized at ~10 KB. An SVG would be better — the
  same mark is also the favicon source — but no vector was available.
- **`favicon` / `appIcon192` / `appIcon512` are unset.** The plumbing is
  validated and wired into the root layout's metadata; `public/` keeps serving
  the existing icons until a theme names its own.
- Brand book marks the logo on violet `#7C3AED` as a disallowed backdrop.
  Recorded in `docs/themes/assets.md` as a rule CSS cannot enforce.
