# Contrast

The build computes WCAG contrast for every declared token pair and **fails** if one is short. Ratios are computed, never tabulated, so a theme and its documentation cannot disagree.

A theme has one palette, so this runs once per theme. There is no second mode to get wrong — a dark look is a separate theme, verified on its own terms.

## Why this is a build error and not a warning

The platform's previous palette carried a dark `--destructive` of `#7f1d1d` — 2.00:1 against its own background, effectively unreadable. It went unnoticed for the entire life of the file, because the block it lived in was never applied. A warning would have been ignored the same way. A build that fails is the only kind of check that survives contact with a deadline.

That failure mode is also the argument for one palette per theme: a block nobody looks at is a block nobody fixes. Every palette that ships now is a theme somebody can select, and every pair in it is measured.

## What is checked

Roughly 24 pairs. The full list is [`CONTRAST_PAIRS` in `src/lib/themes/tokens.ts`](../../src/lib/themes/tokens.ts); the shape of it matters more than the enumeration:

- **Text on its surface** — `foreground/background`, `card-foreground/card`, `popover-foreground/popover`, `primary-foreground/primary`, and so on. 4.5:1.
- **Status colours in *both* directions** — `destructive/background` (as `text-destructive` on the page) *and* `destructive-foreground/destructive` (as a filled button). Same for success and warning. Passing one direction and failing the other is the single most common way a palette ships unreadable, because authors check the one they happened to design first.
- **The categorical ramp** — each of `cat-1` … `cat-6` as text on the page ground. 4.5:1.
- **The brand surface** — `brand-foreground/brand` at 4.5:1, and `brand-accent/brand` at 3:1. Measured against `--brand`, not against the page, because the menu bar and the sign-in page sit on the brand surface in every theme.
- **Focus and controls** — `ring/background` and `input/card` at 3:1.

## What is deliberately not checked

**`--border`.** WCAG 1.4.11 covers non-text contrast for components that convey information or state. A hairline between two table rows is decoration. Gating it at 3:1 would force every divider in the product to a mid-slate that no design system actually ships, which is how a well-meant rule ends up disabled.

**`muted-foreground` on `muted`.** Two legal tokens can still make an illegal element — that pair is 4.34:1 in most palettes. Whether it *occurs* is a property of the markup, not of the theme, so it is caught per-element by [`eslint-rules/no-low-contrast-token-pairs.mjs`](../../eslint-rules/no-low-contrast-token-pairs.mjs), which reads your theme's tokens and re-derives. The two checks are complementary: the build verifies the palette, the lint rule verifies the combinations.

## Why token values must be literals

A colour token must be a hex, `rgb()` or `hsl()` literal, or a `var()` chain ending in one. `color-mix()` and `oklch()` are rejected **in token values**.

This is not a judgement about the CSS. It is that a value the build cannot evaluate is a token the contrast gate silently stops covering — and the build would still print success. Rejecting is the honest failure mode. Use whatever you like in a `.mix-*` surface rule, where nothing is being verified.

## When a brand colour fails

This is common, and the MixOS theme is a worked example of it. Of the four published brand colours, measured as body text on white:

| | ratio | |
|---|---|---|
| Slate `#0F172A` | 17.85:1 | passes |
| Violet `#7C3AED` | 5.70:1 | passes |
| Cyan `#0284C7` | 4.10:1 | **fails** (passes large-text 3:1) |
| Teal `#0D9488` | 3.74:1 | **fails** |

Three responses, in order of preference.

**1. Split the literal from the role.** Keep the published value in a `--brand-*` token, where it is legal for large text, numerals, rules and chart marks — every place a brand book actually uses it — and give the semantic role the next step down the brand's own ramp. MixOS keeps `--brand-cyan: #0284c7` and sets `--primary: #0369a1` (cyan-700, 5.93:1), a colour already in the published palette. Nobody perceives this as off-brand, because it is not.

**2. Check the dark counterpart.** A brand drawn for dark spreads often clears AA at its published value on a dark ground while failing on white — so a colour you had to step down in the light theme may need no substitution at all in the dark one. `mixos` steps `--primary` down to cyan-700; `mixos-dark` uses brand cyan-400 at 8.33:1 untouched. Each theme is measured on its own ground, which is the point.

**3. Escape it, visibly.** If the value genuinely cannot move — a legal requirement, a locked-down brand — name the exact pair in `theme.json`:

```jsonc
"escapes": [{
  "rule": "contrast-aa",
  "pair": "primary-foreground/primary",
  "reason": "Legal requires the exact registered mark colour on primary CTAs; large-text only, tracked in DES-441."
}]
```

The escape is scoped to one pair, so it never widens into "contrast checking is off for this theme". An escape for a pair that *passes* is itself a build error — a stale escape reads as "reviewed and accepted" to the next person while protecting nothing.

## Reading the report

```
THEME_REPORT=1 npx tsx scripts/generate-project-registry.ts
```

prints every pair with its ratio. Read it rather than trusting the exit code: a pair scraping past at 4.51:1 has no headroom, and the next small re-tone will break it.
