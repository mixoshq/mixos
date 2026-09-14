# UX & Visual Quality

This guide is the baseline for how an app should *feel*. The other guides tell you how to wire up pages, widgets, and data; this one tells you what the result has to look and behave like before you can call it done. Treat every rule here as part of the definition of done for any UI change, not a "nice to have."

For **how a screen is organised** — where settings live, how pages relate, what survives a Back button — see [`app-shell.md`](app-shell.md). This file is the floor; that one is the pattern catalog.

The platform ships a design system (Tailwind + a fixed set of CSS variables in [`src/app/globals.css`](../../src/app/globals.css)). **Build with those tokens, not hardcoded colors.** That is what keeps every app coherent and what makes contrast work for free.

---

## Compose from the primitives

Most of this guide used to be rules a reviewer had to check. The ones that could
become components have:

| Instead of | Use | What it makes impossible |
| --- | --- | --- |
| `<button>` | [`Button`](../../src/components/ui/button.tsx) | Forgetting the pending state. `busy` disables, spins, and sets `aria-busy` as one fact. |
| An icon-only `<button>` | `IconButton` | Shipping without an accessible name — `label` is required by the type. |
| `<input>` / `<select>` / `<textarea>` | [`Input`](../../src/components/ui/input.tsx) inside [`Field`](../../src/components/ui/field.tsx) | A label pointing at nothing. `Field` owns the id and the `htmlFor` wiring. |
| `<table>` | [`DataTable`](../../src/components/ui/data-table.tsx) | A skeleton that drifts from the table, and a page that scrolls sideways. |
| A hand-rolled card shell | [`Card`](../../src/components/ui/card.tsx) / `SectionCard` | The 87th copy of `rounded-xl border border-border bg-card`. |
| A status colour picked by hand | [`Badge`](../../src/components/ui/badge.tsx) | A category chip rendered in `destructive` — tones split grading from distinguishing. |
| A `useEffect` fetch + three booleans | [`useAppQuery`](../../src/lib/apps/use-app-query.ts) + [`AsyncView`](../../src/components/ui/async-view.tsx) | Shipping a surface with no loading, empty, or error state. |

**All of these are lint-enforced for `apps/**`.** A raw `<button>`, `<input>`,
`<select>`, `<textarea>` or `<table>` in an app is a build error, as is a literal
copy of the card shell.

### The async pair

`AsyncView` is where "every state is designed" stops being advice:

```tsx
const query = useAppQuery<Result>(appSlug, "GET /items", { scope });

<AsyncView
  query={query}
  skeleton={<ItemsSkeleton />}
  empty={{ cause: "no-data", body: "Sync a source to populate this." }}
  refetchingLabel={`Loading ${scope}…`}
>
  {(data) => <DataTable rows={data.items} columns={COLUMNS} rowKey={(r) => r.id} />}
</AsyncView>
```

You cannot reach the data branch without a `skeleton` and an `empty` — the types
require both — and `empty` takes a `cause`, so a generic grey box is not
expressible. Loading, refetching and error are handled for you, including keeping
the previous data on screen during a user-triggered refetch.

`useAppQuery` models the four states as a discriminated union rather than three
booleans, because `loading && error` and `!loading && !data && !error` are states
the boolean version can represent and no UI ever handles.

---

## Non-negotiables (the things to get right every time)

1. **Every async surface has a loading state, and it mirrors the final layout.** Never show bare `Loading…` text or a lone centered spinner. Use `Skeleton` from [`@/components/ui/skeleton`](../../src/components/ui/skeleton.tsx) shaped like the content it's replacing — a chart skeleton is a big block, a table skeleton is repeated rows, a stat is a small block. (This is also app invariant #10.)
2. **Use semantic color tokens, never raw hex or palette Tailwind colors.** `text-emerald-600` and `#888` are not tokens. This is lint-enforced for `apps/**` — see [Color & contrast](#color--contrast).
3. **Every state is designed, and each names its cause.** Loading, empty, error, and "not connected" each get a deliberate UI — and the three *different* reasons a screen can be empty get three different messages. A blank card when there's no data is a bug. Use the components in [`@/components/ui/app-states`](../../src/components/ui/app-states.tsx).
4. **Never block the UI without feedback.** Buttons that trigger work show a pending state and disable to prevent double-submits. Don't freeze the page on a fetch.
5. **Don't shift layout after load.** The skeleton should occupy the same space the loaded content will, so nothing jumps when data arrives.

---

## Loading states

Match the skeleton to the shape of the real content. The goal is that the transition from skeleton → data is barely perceptible.

```tsx
"use client";
import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { createAppClient } from "@/lib/apps/sdk";
import type { WidgetProps } from "@/lib/hooks/types";

export default function RevenueStat({ appSlug }: WidgetProps) {
  const [data, setData] = useState<{ total: number } | null>(null);

  useEffect(() => {
    createAppClient(appSlug).get("/revenue").then(setData);
  }, [appSlug]);

  if (!data) {
    // Mirrors the loaded layout: a label line + a big number block.
    return (
      <div className="space-y-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-9 w-32" />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">Total revenue</p>
      <p className="text-3xl font-semibold text-foreground">
        ${data.total.toLocaleString()}
      </p>
    </div>
  );
}
```

Guidelines:

- **Skeleton for the first paint; `PendingState` for a refetch the user triggered.** On first load there's nothing to name yet, so a skeleton is right. Once the user changes a filter or scope, say what's loading — `<PendingState label="Loading customers for Jane Doe…" chips={["Kickoff", "Onboarding"]} />` echoes their choice back while it applies. An anonymous shimmer after a deliberate action leaves the user unsure the click registered.
- **For actions (save, submit, run)**, disable the trigger and show inline progress (`Saving…`, a spinner inside the button) rather than a full-screen overlay.
- **Don't show a skeleton for sub-100ms work.** Optimistic local state is better than a flash of skeleton.
- **Mirror the card's chrome, not just its content.** A skeleton that draws only grey blocks where the rows will be, inside no card, is a layout shift waiting to happen: when the data lands the border, header row, header rule, and padding all appear at once and push everything down. If the loaded state is a card with a title and a divider, the skeleton is the *same card* with a `Skeleton` where the title goes.

  ```tsx
  // The loaded state's chrome, with skeletons in the content slots.
  <div className={CARD_SHELL}>
    <div className={CARD_HEADER}>
      <Skeleton className="h-6 w-48" />
      <Skeleton className="ml-auto h-4 w-40" />
    </div>
    <div className={CARD_BODY}>
      <Skeleton className="h-24 w-full" />
    </div>
  </div>
  ```

  This is the practical reason to share card primitives rather than hand-roll the shell: a skeleton written against the same constants can't drift from the card it stands in for.

## Color & contrast

Pull from the tokens defined in [`src/app/globals.css`](../../src/app/globals.css). Every foreground below is designed to read clearly on its matching surface:

| Use | Surface | Text on it |
| --- | --- | --- |
| Page / widget body | `bg-background` | `text-foreground` |
| Card / panel | `bg-card` | `text-card-foreground` |
| Primary action | `bg-primary` | `text-primary-foreground` |
| Secondary / subtle | `bg-secondary` / `bg-muted` | `text-secondary-foreground` / `text-muted-foreground` |
| Success | `bg-success` | `text-success-foreground` — or `text-success` on a page |
| Warning | `bg-warning` | `text-warning-foreground` — or `text-warning` on a page |
| Destructive / error | `bg-destructive` | `text-destructive-foreground` — or `text-destructive` on a page |
| Borders & dividers | `border-border` | — |

**`bg-primary` and `bg-brand` are different intents, not the same pixels.** `bg-primary` means *the primary action* — a button, a link. `bg-brand` means *the brand surface* — the menu bar, the sign-in page — and carries `text-brand-foreground`. Both come from the active theme (`themes/<slug>/theme.css`), so a rebrand changes them together without touching an app. See [docs/themes/tokens.md](../themes/tokens.md).

### Verified pairs: two legal tokens can make an illegal element

The table above is the set of pairs that were **measured**. the theme build verifies each token twice — as text on the page background, and as a surface under its own foreground — and that is the whole guarantee. It says nothing about **token on token**.

So `text-muted-foreground` is legal, `bg-muted` is legal, and putting them on the same element is a WCAG failure. That combination alone appeared on **135 elements across 16 apps**, every one of them green in CI, because the colour lint rule matches token *names* and there is nothing wrong with either name.

Measured, light theme, tint composited over `bg-card`:

| Element | Ratio | AA (4.5:1) |
| --- | --- | --- |
| `text-muted-foreground` on `bg-muted` / `bg-secondary` / `bg-accent` | 4.34:1 | ✗ |
| `text-muted-foreground` on `bg-muted/50` | 4.55:1 | ✓ (barely) |
| `text-foreground` on `bg-muted` | 18.26:1 | ✓ |
| `text-destructive` on `bg-muted` | 4.41:1 | ✗ |
| `text-warning` on `bg-muted` | 4.58:1 | ✓ |
| `text-success` on `bg-success/10` | 4.78:1 | ✓ |
| `text-warning` on `bg-warning/10` | 4.39:1 | ✗ |
| `text-destructive` on `bg-destructive/10` | 4.13:1 | ✗ |
| `text-destructive` on `bg-destructive/5` | 4.47:1 | ✗ |
| `text-<status>` on `bg-<status>/20` | 3.53–4.11:1 | ✗ |

Read those last five together, because they are the argument for the rule over the convention: **the same construction passes in success and fails in warning and destructive.** Nobody eyeballs a 0.4 difference. The three status tokens are equally legible *on the page*, and equally illegible *on their own tint* — but not at the same alpha, so there is no threshold to memorise.

**This is lint-enforced, as an error.** `mos-design/no-low-contrast-token-pairs` parses the tokens out of `globals.css`, resolves the classes on each element per variant state, composites any alpha, and computes the ratio. It shipped as a warning while ~215 pre-existing elements across 16 apps were outstanding; that backlog is gone, and a floor that only warns is not a floor.

It earns its keep on new code too. Promoting it immediately caught two elements in the primitives above: `hover:bg-destructive/90` under `text-destructive-foreground` composites to **4.11:1** — while the identical treatment on `primary` and `secondary` passes, which is exactly the "no threshold to memorise" asymmetry this section describes. The destructive button signals hover with a ring instead. Its blind spots are documented in the rule file — runtime-assembled class names and imported constants are invisible to it, exactly as they are to the colour rule.

The three fixes, in order of preference:

1. **Drop the tint.** `text-destructive` on the page background is 4.85:1. The tint was rarely carrying meaning the label wasn't already carrying.
2. **Use the fill's own foreground.** `bg-destructive text-destructive-foreground` is verified. A solid status strip is both compliant and louder than a wash — which is usually what you wanted from the wash.
3. **Carry the meaning somewhere other than colour** — a `StatusDot`, a label — and let the text be `text-foreground`.

#### Never dim a token

```tsx
<p className="text-muted-foreground/70">      {/* 2.71:1 */}
<p className="text-muted-foreground/50">      {/* 1.96:1 */}
<span className="text-foreground opacity-50"> {/* 3.75:1 */}
```

`muted-foreground` **is** the quiet step on the ladder. Dimming it produces text that is quieter than the design system has a name for, which is the point at which it stops being readable — and the numbers above are all on white, the most forgiving ground there is.

If secondary isn't quiet enough, the answer is hierarchy — size, weight, position, whitespace — not opacity. `opacity-*` on a `disabled:` state is fine and is not flagged: WCAG 1.4.3 exempts inactive controls.

#### Legends: sample the fill, unless the fills don't differ

A legend swatch should be **the same colour as the thing it explains**. If the chart bands are `bg-cat-1/15`, the swatch is `bg-cat-1/15` — otherwise the key is describing a chart the user isn't looking at.

The exception is worth knowing because it looks like a bug either way: when the washes are deliberately faint, sampling them produces swatches that are *indistinguishable from each other*. In one app the amber and destructive band washes at 8% differed by **3 of 255 per channel — 1.01:1**. Three "different" chips, all reading as white. There, the swatch has to step up to the opaque dot (`bg-warning`, `bg-destructive`) that the same legend's *dots* use, and the wash stays unsampled.

The rule that resolves it: **sample the fill when the fills are distinguishable at swatch size; otherwise sample the token.** Compute it once rather than trusting the two hex values to look different in your editor.

### Categorical colour: `cat-1` … `cat-6`

The tokens above all carry a **judgement** — success, warning, destructive. A lot of colour in an app doesn't: chart series, category chips, column accents, lane markers. Colour there says *"this is a different one"*, not *"this one is bad"*.

For that, use the categorical ramp — six hues that each clear AA as text on the page background, and step to lighter values in dark mode so a series keeps its identity across themes:

```tsx
const TILE_TINTS = [
  "bg-cat-1/8 text-cat-1",
  "bg-cat-2/8 text-cat-2",
  // …assign by stable index, not by meaning
];
```

**Don't tint past 10% if the text on it is the same token.** This snippet said `/15` until the contrast rule was written and measured it: `text-cat-N` on `bg-cat-N/15` passes for `cat-1` through `cat-4` and **fails for `cat-5` (4.42:1) and `cat-6` (4.09:1)**. Which is the worst possible failure mode for a ramp meant to be assigned by index — the first four categories look fine and the fifth and sixth quietly don't, so a list that grows from four items to six breaks without anyone touching the styling.

The headroom, measured, is the maximum alpha at which `text-cat-N` still clears 4.5:1 on `bg-cat-N/alpha`:

| | cat-1 | cat-2 | cat-3 | cat-4 | cat-5 | cat-6 |
| --- | --- | --- | --- | --- | --- | --- |
| As text on the page | 6.70:1 | 6.98:1 | 5.93:1 | 6.04:1 | 5.47:1 | 4.99:1 |
| Max self-tint at AA | 24% | 25% | 18% | 17% | 14% | **8%** |

**`/8` is the strongest tint that clears AA for all six** (`cat-6` lands at 4.52:1; at `/10` it is already 4.39:1). Use `/8` whenever the ramp index is dynamic. Go higher only for a specific hue you have measured, and only where that index cannot shift.

This correction is itself the argument for the lint rule: the `/15` above stood in this guide, in a snippet recommending it, until something computed the number. The first draft of the fix said `/10` — also wrong, by 0.11:1, and also invisible to inspection.

**Do not borrow status tokens for decoration.** A category chip rendered in `bg-destructive/10` tells the user that category is an error. It's an easy slip to make — red, amber and green are the first three colours anyone reaches for when they need three distinguishable ones — and the result actively misinforms. If the colour isn't grading the thing, it belongs in the `cat-*` ramp.

Conversely, don't reach for `cat-*` when you *do* mean a grade. Health, status, and pass/fail belong in success/warning/destructive, where a colourblind user's icon-and-label fallback is expected.

Rules of thumb:

- **Body text must clear WCAG AA (4.5:1); large/bold text must clear 3:1.** The status tokens above are verified in both directions — as text on the page, and as a surface under their own foreground. If you go off-palette, compute the ratio; don't eyeball it.
- **`muted-foreground` is for secondary text only** (captions, labels, timestamps) — never for primary content or anything a user has to act on. Don't stack it with a tiny size: muted at `text-[10px]` is unreadable twice over.
- **Don't communicate state with color alone.** Use `StatusDot` / `StatusPill` from [`@/components/ui/status`](../../src/components/ui/status.tsx) — both require a `label`, so the text alternative isn't something a reviewer has to remember to ask for.
- **Never hardcode `#fff` / `#000`, `text-gray-*`, or any `text-<palette>-<n>`.** They dodge the contrast guarantees. `bg-white` and `bg-gray-50` as a *surface* are the same mistake — use `bg-card` / `bg-muted`.
  - The exception is **alpha over a known ground**: `bg-white/10` as a hover state on a navy panel, or `bg-black/70` as a modal scrim, are fine. The rule targets opaque fills that pretend to be a theme surface.
- **Don't restyle focus rings away.** Keyboard focus must stay visible (the `ring` token).

### A dark look is a different theme — and it is not your job either way

There is no light/dark switch. A theme declares **one** palette, an admin picks which theme the install runs, and the platform ships two: `mixos` (light, the default) and `mixos-dark`. Each is verified on its own — ~24 contrast pairs, build fails on any shortfall.

> **There is no `dark:` variant to write.** Colour lives in the active theme's tokens, and nowhere else.

This is what makes an app survive a repaint it never coded for. `bg-card` resolves to `#ffffff` under `mixos` and `#1e293b` under `mixos-dark` without the app knowing either value, so a page written once is correct under both — and under the next theme somebody authors. A `dark:` variant hard-codes a second answer in a place the contrast gate cannot see, and it would be wrong the moment a third theme appears.

It is lint-enforced for `apps/**` **and `src/**`**. The platform exempted itself from this rule while no dark palette was reachable, and by the time one was its own chrome had accumulated ~120 raw palette utilities and 13 `dark:` variants — a `<pre>` with a background but no ink, headings inheriting UA-default black at 1.05:1 on a near-black page. That cleanup is [`docs/plans/20260826_1959-dark-mode-legibility.md`](../plans/20260826_1959-dark-mode-legibility.md), and the fence now covers both trees.

**Two things you inherit for free, so don't re-implement them:**

- **The page ground and the default ink.** `body` carries `background-color: var(--background)` and `color: var(--foreground)`. Anything that just renders text is already correct in both modes; setting a colour is for when you mean something other than "body text".
- **The surface ladder.** `--background`, `--muted` (recessed: content areas, wells, stripes), `--card` (raised: panels, widgets) and `--accent` (hover) are four distinguishable rungs. Every theme is responsible for keeping them apart, which is what lets a form control on `bg-background` read as a control inside a `bg-card` panel without an app doing anything.

## Empty, error & not-connected states

Each of these is a real screen a user will hit. All four live in [`@/components/ui/app-states`](../../src/components/ui/app-states.tsx).

**Empty states must name their cause.** These are three different problems with three different fixes, and one generic "No results" box tells the user which one they're in: none.

| `cause` | When | What to say |
| --- | --- | --- |
| `no-filter` | The user's own filter selection excludes everything | Name the control and how to fix it. **Requires an `action`** — the compiler enforces this, because a filter the user emptied is always recoverable. |
| `no-match` | Filters are valid, matched nothing | Say what was searched, so they know the filter worked. |
| `no-data` | Genuinely nothing yet — new install, unsynced source | Say what will make records appear. |

```tsx
{selectedStages.size === 0 ? (
  <EmptyState
    cause="no-filter"
    title="No stages selected"
    body="Select at least one stage from the filter to see records."
    action={{ label: "Select all active", onClick: selectAllActive }}
  />
) : rows.length === 0 ? (
  <EmptyState cause="no-match" body={`No records match these filters.`} />
) : (
  <ListTable rows={rows} />
)}
```

- **Error:** a calm, human message. Never dump a raw error string (also a security rule — see invariant #9 and `safeErrorMessage`). Offer a retry where it makes sense.
- **Degraded, not broken:** if one of several sources is down but the page can still render, say so inline and keep going. A banner explaining that last-activity timing is monday.com-only right now beats failing the whole page over a partial outage.

## Spacing, type & motion

- **Lean on the type scale and spacing utilities** rather than custom pixel values — consistency reads as quality. Use the `font-sans` (Roboto) stack the platform sets; don't pull in a competing font without reason.
- **Respect the card radius** (widgets live in `rounded-xl` cards). Match it on inner surfaces so things nest cleanly.
- **Keep motion subtle and fast** (~150–300ms, ease-out). Animate to communicate (a value updating, a panel opening), never to decorate. Honor `prefers-reduced-motion` — gate non-essential animation behind it.
- **Touch/click targets are at least ~36–40px tall.** Don't ship tap targets only a few pixels high.

## Accessibility floor

- Every interactive element is reachable and operable by keyboard, with a visible focus state.
- Icon-only buttons have an `aria-label`; decorative icons inside labelled buttons get `aria-hidden`.
- Images have meaningful `alt` (or `alt=""` if decorative).
- Form inputs have associated `<label>`s.
- Decorative skeletons are `aria-hidden` (the shipped `Skeleton` already is).

### `title=` is not an affordance

A native `title` tooltip is **mouse-only, invisible until hover, un-stylable, and delayed by about a second.** It never appears on touch, and screen-reader support for it is inconsistent enough that you cannot rely on it either. So:

> If the information matters, it is on the page. If it doesn't matter, delete it.

The middle case — *"it matters to someone, sometimes"* — is the one that keeps producing `title=` attributes, and it has two real answers:

- **A definition or a caveat someone may want on demand** → `InfoTooltip` from [`@/components/ui/info-tooltip`](../../src/components/ui/info-tooltip.tsx). It's keyboard-reachable, dismissible with Escape, and styled like the rest of the app.
- **The full text of something you truncated** → don't truncate, or wrap. A `title` holding the rest of a ticket subject is a truncation you decided you couldn't live with, admitted in the least accessible place available.

`title` on a plain `<a>` that duplicates its own visible text is harmless and not worth removing. `title` carrying the *only* copy of something is a defect.

---

## Checklist before you call a UI change done

- [ ] Every fetch has a layout-matching `Skeleton`, not "Loading…" or a bare spinner.
- [ ] User-triggered refetches say what they're loading.
- [ ] Colors come from semantic tokens; no raw hex, no `text-<palette>-<n>`, no opaque `bg-white` / `bg-gray-*`.
- [ ] No `dark:` variants — colours fork in `globals.css`, not here.
- [ ] No same-element token pair below the floor, and no dimmed colour token — `mos-design/no-low-contrast-token-pairs` reports zero for the files you touched. See [Verified pairs](#verified-pairs-two-legal-tokens-can-make-an-illegal-element).
- [ ] Nothing meaningful lives only in a `title=` attribute.
- [ ] Skeletons reproduce the card chrome, not only the content blocks.
- [ ] Empty states name their cause; error and not-connected states are designed and were actually viewed.
- [ ] Status is never colour-only (`StatusDot` / `StatusPill` with a label).
- [ ] Buttons that do work show a pending/disabled state.
- [ ] Read-only users see controls **omitted**, not disabled — see [`app-shell.md`](app-shell.md#permission-aware-ui).
- [ ] No layout shift between skeleton and loaded content.
- [ ] Keyboard focus is visible; icon buttons have labels.
- [ ] `npm run lint` passes.
- [ ] Opened in a browser and exercised — per the Verify steps in [`apps/AGENTS.md`](../../apps/AGENTS.md), a UI change isn't done until you've seen it.
