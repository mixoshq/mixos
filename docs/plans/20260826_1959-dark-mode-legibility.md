# Dark mode legibility

## Context

`feat/theme-abstraction` made dark mode **reachable** for the first time. The
`.dark` block that shipped before it was never applied — which is the same reason
the old `--destructive: #7f1d1d` sat at 2.00:1 for the life of the file without
anyone noticing. Now that `:root[data-mode="dark"]` actually paints, every
light-only assumption in the platform's own chrome surfaced at once.

The reported symptom was the connector guide at `/connectors/guide`: headings,
`<pre>` blocks and inline `<code>` rendering near-black on the dark slate ground,
and a light-blue "Build with Claude Code" callout sitting unchanged on a dark
page.

The theme is not the cause. All 48 gated token pairs pass
(`THEME_REPORT=1 npx tsx scripts/generate-project-registry.ts`), dark
`foreground/background` among them at 17.06:1. Three separate platform-side
faults produce the symptom:

**1. Nothing consumes `--foreground` / `--background` at the root.**
`src/app/globals.css` styles `body` with `font-family` only. `<body>` carries
`mix-app-shell`, but that is an *optional* theme surface — `themes/mixos` declares
`"surfaces": []`, as does `_template`. So `color` is never set, and every element
that relies on inheritance falls back to the UA default black. In light mode
black-on-white is indistinguishable from correct, which is why it survived. In
dark mode it is black on `#0f172a` — roughly **1.05:1**.

Affected in the reported page alone: `h1`/`h2`/`h3`, `pre`, inline `code`, `th`
(see `src/components/guide-tabs-shell.tsx`, where each of those sets a background
or a size but no text colour). `background-color` is missing for the same reason
— the dark ground on `(main)` pages comes from `bg-muted` on the `<main>`
element, so any route outside that segment renders on a transparent (white) body.

**2. ~120 raw palette utilities in `src/`.** `bg-blue-50 text-blue-900`,
`bg-emerald-100 text-emerald-800`, `text-gray-900` and friends across 17 files.
These are mode-blind by construction. The lint rule that bans exactly this
pattern is scoped `files: ["apps/**/*.{ts,tsx}"]` in `eslint.config.mjs`, so
`apps/` is clean and the platform that wrote the rule was never held to it. Its
own comment — *"The platform is light-only today — nothing applies the `.dark`
class"* — is the stale assumption this plan retires.

**3. Two dark tokens with no headroom, and one that fails off-gate.**
`input/card` passes at 3.07:1 against a 3:1 floor. `--border: #334155` is 1.72:1
on the page ground and 1.41:1 on a card, which is why panel edges and table rules
disappear. And `--destructive: #ef4444` clears the gate at 4.74:1 against
`--background` while landing at **3.89:1 on `--card`** — error text lives inside
cards far more often than on the bare page, and `destructive/card` is not a pair
the build checks.

## Decisions

- **This is an OS change**, confirmed with the user before starting. It carries
  the `os-change` label and needs admin review. A theme-only fix was offered and
  declined: styling `.mix-app-shell` in `themes/mixos` would repair one theme
  while leaving `_template` — and every theme cloned from it — shipping black
  text on a dark ground.
- **Base ground and ink belong to the platform, not to a theme.** `--background`
  is specified as "The page ground" and `--foreground` as "Default body text" in
  `src/lib/themes/tokens.ts`. If the platform never consumes them at the root,
  two required tokens are inert. `.mix-app-shell` stays what the docs describe —
  an optional expressive surface — and gains no new obligation.
- **No `dark:` variants.** The 13 already in `src/` are removed rather than
  extended. Colour forks in the theme's dark block; that rule does not get a
  platform exemption.
- **The lint rule is extended to `src/`, not just the violations fixed.**
  Fixing 120 call sites without moving the fence leaves the next 120 free to
  land. Extending the fence is what makes this a one-time repair.
- **Semantic mapping for the raw colours**: blue/sky → `primary`, emerald/green →
  `success`, amber/yellow → `warning`, red/rose → `destructive`, gray/slate →
  `muted` / `muted-foreground` / `border`, purple/violet → `cat-2` (a
  categorical badge, deliberately not a status colour).
- **Dark token re-tone is minimal and stays on the brand's own ramp** — Tailwind
  slate/sky steps already present in the palette, no new hues.
- **Reuse the house patterns, don't invent.** `docs/apps/ux.md` already measured
  this ground: a status token on its own tint fails in warning and destructive
  while passing in success, so tinted banners take `text-foreground` and let the
  border and tint carry the meaning, and chips use the solid-fill treatment
  `src/components/ui/badge.tsx` documents.
- **Added mid-flight, on the user's note that a form control should not be the
  same colour as the surface it sits in.** This turned out to be the same fault
  as the rest: the dark block had `--muted`, `--card`, `--secondary` and
  `--popover` all at slate-800, so the depth ladder was one flat field — a card
  did not separate from the content area, and a control did not separate from
  the card. Fixed in the ladder rather than per-component. See *Surface ladder*
  below.
- **The light page ground stays `#ffffff`.** Moving it to slate-50 to give a
  light control its own fill was tried and reverted: it bought a 3% luminance
  step nobody can perceive and cost 0.21 off six light pairs, taking
  `muted-foreground/background` from 4.76:1 to 4.55:1. In light the control is
  distinguished by `--input`, a gated 4.76:1 border against the card, which is
  the standard light-mode idiom. Dark is the half that needed the extra rung.

## Structure

### `src/app/globals.css` — the root fix

```css
body {
  background-color: var(--background);
  color: var(--foreground);
  font-family: var(--type-sans);
}
```

Two declarations. Everything inheriting its colour becomes theme-correct in both
modes, which resolves the headings, `<pre>`, `<code>` and `<th>` in the report
without touching those components.

### `eslint.config.mjs` — move the fence

Add `src/**/*.{ts,tsx}` to the `files` glob of the design-system block, and
rewrite the stale "platform is light-only" comment to say where colour forks
(the theme's dark block) and why `src/` is now in scope.

Also widen the leading character class of all six selectors from
``(?:^|[\s"'`])`` to ``(?:^|[\s"'`:])``. The rule required a class to start
after whitespace or a quote, so a **variant-prefixed** class was invisible to
it: the character before `text-` in `hover:text-red-300` is a colon. Two of
those survived the first sweep in `widget-wrapper.tsx` on exactly that
technicality.

### `docs/apps/ux.md` — retire the stale section

§"The platform is light-only today" asserts that nothing applies the dark class
and that dark mode is unreachable. Both were true when written and neither is
now, and it is the page app authors are pointed at. It becomes §"Dark mode is
live — and it is not your job", stating what an app inherits for free (the body
ground and ink, the surface ladder) so nobody re-implements either.

### `themes/mixos/theme.css` — dark block only

| token | from | to | why |
|---|---|---|---|
| `--border` | `#334155` | `#475569` | 1.72:1 → 2.36:1 on the ground. Ungated decoration, but panel edges have to be *visible*. |
| `--input` | `#64748b` | `#94a3b8` | 3.07:1 → 5.71:1 on card. Was scraping a 3:1 floor by 0.07. |
| `--destructive` | `#ef4444` | `#f87171` | 3.89:1 → 5.29:1 on `--card`, the ground error text actually sits on. Both gated directions improve too (4.74 → 6.45). |
| `--success` | `#14b8a6` | `#34d399` | 5.88:1 → 7.61:1 on card. `#2dd4bf` was rejected: it is already `--cat-3`, and a status colour must not collide with the categorical ramp. |

**Surface ladder (dark).** The four surface rungs were three-quarters
degenerate: `--muted`, `--card`, `--secondary` and `--popover` were all
`#1e293b`. Dropping the ground one slate step restores four distinct rungs
without inventing a colour — 950 ground, 900 recessed, 800 raised, 700 hover:

| token | from | to | role |
|---|---|---|---|
| `--background` | `#0f172a` | `#020617` | the page ground, and the fill of a form control |
| `--muted` | `#1e293b` | `#0f172a` | recessed: the content area (`<main>`), wells, table stripes |
| `--card` / `--popover` / `--secondary` | `#1e293b` | unchanged | raised: panels, widgets, menus |
| `--accent` | `#334155` | unchanged | hover |

This is what makes a card separate from the content area behind it, and a
control separate from the card it sits in. Every gated dark pair improves as a
side effect — the weakest dark pair goes from 3.07:1 to 5.71:1.

**Judge surface separation by ΔL*, not by WCAG ratio.** The ratio formula adds
0.05 to both luminances, which compresses everything near black: two clearly
distinct dark surfaces land around 1.1:1 and read as "flat" by a number designed
to measure text legibility, not surface discrimination. The honest reference is
the light theme's own card-on-content-area step, which nobody calls ambiguous —
ΔL* 3.65. Every rung in the dark ladder clears it.

Light block unchanged — every light pair already has headroom, `--card` is
`#ffffff` there so the on-card cases are the on-background cases, and the
attempt to give light its own fourth rung is recorded under *Decisions*.

`theme.json` needs no edit: no surface is added, so `"surfaces": []` stays
accurate.

### `src/components/ui/input.tsx` — the control primitive

Two token swaps in `CONTROL`, both of which every app inherits:

- `bg-card` → **`bg-background`**. Most controls sit *in* a `bg-card` panel, so
  the fill was the same colour as the panel. With the ladder above they are a
  step apart in both modes.
- `border-border` → **`border-input`**. `--border` is the ungated decorative
  hairline; `--input` exists for a control's boundary and is verified at 3:1
  against `--card`. Using the divider token here quietly opted the one border
  that carries information out of the only check that covers it.

Seven ad-hoc controls in `src/` that bypass the primitive get the same
`border-input` treatment, and `account-form.tsx` loses `focus:border-brand` —
`--brand` is `#0f172a` in *both* modes, so that focus edge was invisible on a
dark page. `--ring` is the token that is gated against the background.

### Component sweep — 17 files

Replace raw palette utilities with semantic tokens and delete the `dark:`
variants. Notable non-mechanical cases:

- `src/components/guide-tabs-shell.tsx` — `border-brand` marks the active tab.
  `--brand` is `#0f172a` in *both* modes, so on the dark ground the indicator is
  invisible. → `border-primary`.
- `src/app/(main)/connectors/guide/page.tsx`, `src/app/(main)/apps/guide/page.tsx`
  — the blue "Build with Claude Code" callout → `border-primary/30 bg-primary/10
  text-foreground`, with the usage line on `text-muted-foreground`.
- `src/components/apps/password-gate.tsx`, `src/app/(public)/p/…/page.tsx`,
  `src/app/(auth)/login/credentials-form.tsx` — signed-out surfaces, the ones
  with no menu bar. These are exactly the pages that had no themed body colour
  and no themed ground.
- `src/components/admin/scheduled-jobs-list.tsx` — the only file carrying a full
  light/dark pair per badge; both halves collapse to one token expression.

## Verification

1. `THEME_REPORT=1 npx tsx scripts/generate-project-registry.ts` — read the
   table, not the exit code. Confirm the four re-toned pairs moved in the
   expected direction and nothing regressed.
2. `npm run typecheck`, `npm run lint` — lint now covers `src/`, so a surviving
   raw palette colour fails the run.
3. `npm run build`.
4. `rg` sweep for the palette pattern across `src/` returns nothing, and
   `rg 'dark:' src` returns nothing.
5. Manual, both modes: dashboard, `/connectors/guide` (the reported page), a
   form, a table, a modal, **the sign-in page while signed out**, and a public
   `/api/p/` link.
6. Hard-reload with the OS in dark mode — no flash of a light page.
