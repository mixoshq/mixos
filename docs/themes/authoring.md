# Authoring a theme

Start to finish, including the case this abstraction was built for: turning a brand book into a working theme.

## 1. Scaffold

```bash
npm run new -- theme my-theme
```

It copies `themes/_template` to `themes/my-theme-<id>/`, minting the id, and sets `registryId` in `theme.json` to match: that is the theme's slug, and it ends up in a CSS attribute selector. Fill in `name` and `description` in `theme.json` — the description is what an admin reads in the picker, so write it for them, not for you.

## 2. Set the tokens

Work through `:root` in `theme.css` top to bottom. The template is ordered by how much each group matters, not alphabetically.

Two habits save the most rework:

**Pick the surfaces first, then the things that sit on them.** `--background`, `--card`, `--popover`, `--brand`. Every other decision is measured against one of these, so choosing them last means re-checking everything.

**Treat each status colour as two decisions.** `--destructive` has to work as `text-destructive` on the page *and* as a filled button under `--destructive-foreground`. Designers naturally pick for one. The build checks both.

## 3. Run the gate early and often

```bash
THEME_REPORT=1 npx tsx scripts/generate-project-registry.ts
```

Every pair with its ratio. Run this after each group of tokens, not at the end — a failure names the pair, the two values, and the required floor, so it is a two-minute fix in isolation and a bad afternoon in bulk.

## 4. Want a dark version? That's a second theme

There is no dark block. A theme declares one palette in `:root`; the dark look ships as its own folder — `themes/<slug>-dark/` — which an admin selects at `/admin/themes`. Copy the whole theme, including its `assets/` (a theme is self-contained and there is no cross-theme path), and re-tone the values.

Two things change more than authors expect:

**On a dark ground a status colour gets lighter and its foreground flips dark.** `--destructive: #dc2626` with a near-white label is correct on white and wrong on slate; there it is `#f87171` with a near-black label.

**The surface ladder needs real steps.** `--background`, `--muted`, `--card` and `--accent` are four rungs, and on a dark ground it is easy to land three of them on the same slate — at which point a card does not separate from the content area behind it and a form control does not separate from the card it sits in. [`themes/mixos-dark-d666638f/theme.css`](../../themes/mixos-dark-d666638f/theme.css) is a worked example of both, including why its `--muted` is *deeper* than its `--background`.

## 5. Style surfaces, if you need to

Most themes never need this — the token set covers recolouring completely. Reach for surfaces when the theme is a genuinely different *feel* rather than a different palette: flat vs. glassy, sharp vs. soft, hairline vs. shadow.

```css
.mix-card {
  box-shadow: none;
  border-width: 2px;
}
.mix-button:hover {
  transform: translateY(-1px);
}
```

Then list every surface you styled under `surfaces` in `theme.json`. The build checks both directions, so it rejects both an undeclared surface and a declared one you never styled.

## 6. Verify

Follow the checklist in [`themes/AGENTS.md`](../../themes/AGENTS.md#verify-run-these-before-reporting-done). The two steps people skip, and shouldn't:

- **Load the sign-in page signed out.** It has no menu bar, it sits directly on `--brand`, and it is the surface authors forget.
- **Hard-reload.** `data-theme` is resolved on the server and present in the first byte, so there is no flash to chase — but this is where you would notice if there were.

---

## Worked example: from a brand book to a theme

The MixOS theme was built from a brand guidelines document. The process generalises.

### Pull out the raw material

A brand book gives you three things and rarely labels them as such: a **palette with ramps**, a **type hierarchy by role**, and a set of **usage rules** (what may sit on what). The MixOS book gave:

- Slate `#0F172A`, Cyan `#0284C7`, Teal `#0D9488`, Violet `#7C3AED`, each with a five-step ramp
- Plus Jakarta Sans for the brand and headings, Inter for UI and body, JetBrains Mono for code
- Contextual usage: the logo is approved on white, on slate, and on a dark panel — **not** on violet

The ramps are the most valuable part, and the part most often ignored. They are where you go when a headline colour fails contrast.

### Measure before you assign

Compute every candidate as text on your intended background *before* deciding which token it becomes. Doing this first turns "this brand doesn't pass accessibility" into "these two roles use the next step down the ramp", which is a much smaller conversation.

For MixOS: slate and violet cleared AA; cyan (4.10:1) and teal (3.74:1) did not.

### Split literals from roles

Keep the published values in `--brand-*`, where they are legal for large text and non-text accents — every place the brand book actually uses them. Give the semantic roles a value from the brand's own ramp that clears AA:

```css
--brand-cyan: #0284c7;   /* as published; large text, rules, chart marks */
--primary:    #0369a1;   /* cyan-700, from the same published ramp, 5.93:1 */
```

This is the pattern to reach for whenever a brand colour fails. It is not a compromise on the brand — `#0369A1` is *in* the brand palette.

### The dark theme substitutes too

A dark ground moves the substitution to the other end of the ramp; it does not remove it. On MixOS Dark's slate, published cyan is 4.36:1 and violet 3.13:1, both short of AA. So `--primary` takes brand cyan-400 (8.33:1) and `--cat-2` a lighter violet, `#a78bfa`, just as MixOS steps `--primary` down to cyan-700 on white. Measure every candidate on the ground it will sit on.

### Map type by role, not by name

`--type-heading` is the brand face, `--type-sans` the UI face, `--type-mono` the code face. A brand book that names five weights of one family still only fills these three roles. Self-host the files (see [assets.md](assets.md)); variable fonts collapse a weight range into one request.

### Encode the usage rules you can

Some rules become tokens. "The logo never sits on violet" cannot be enforced by CSS, so it goes in a comment beside the asset — but "the accent must be legible on the brand surface" becomes the gated `brand-accent/brand` pair, which is why MixOS's `--brand-accent` is cyan-400 rather than the published cyan: the menu bar sits on `--brand`, a dark slate in both MixOS themes, so the accent has to be measured there rather than on the page.
