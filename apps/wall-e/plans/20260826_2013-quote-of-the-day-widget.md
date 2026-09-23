# Wall·E — Quote of the Day widget

**Date:** 2026-08-26
**Slug:** `wall-e` (folder name is the slug)
**Status:** proposed → building

## Context

A deliberately tiny global app whose entire job is to contribute one dashboard
widget showing an inspirational line from *WALL·E*. It has no pages, no
database, no connectors, and no widget configuration. It exists to be pleasant.

Because it is `"global": true`, every user is implicitly granted it and it cannot
be revoked per-user; users still choose to install it from their App Manager and
add the widget to their dashboard.

## Decisions (locked with the user)

| Decision | Choice | Why |
| --- | --- | --- |
| Quote source | Hardcoded curated list in a TS module | ~30 quotes is not a database. No migration, no CRUD, no admin surface. Editing means a one-line code change. |
| Rotation | Quote of the day, deterministic from the date | Stable all day; refreshing the dashboard does not reshuffle it, and everyone in the tenant sees the same line. |
| Scope | Widget only — no `pages/` | The app has no home screen to justify. Smallest surface that delivers the idea. |
| Widget config | None — zero-config | Add it, it works. No config modal at all. |

### Decision: the quote is picked on the server, not in the browser

The obvious build is to import the quote list straight into the widget and index
it by `new Date()`. Rejected, for two reasons:

1. **Hydration.** Widgets are lazy-loaded inside a `"use client"` dashboard grid
   ([widget-wrapper.tsx:33](../../../src/components/dashboard/widget-wrapper.tsx#L33)).
   A client component still renders on the server, so a date computed in both
   places disagrees across the UTC midnight boundary and mismatches on hydrate.
2. **"Everyone sees the same quote"** is only true if one clock decides. Per-browser
   local dates would silently break the property that made quote-of-the-day the
   appealing option.

So a single `GET /quote` route computes the day index from UTC and returns the
quote. Cost is one round trip on a widget that then renders instantly; the
benefit is no hydration risk and a genuinely shared quote. It also means the
widget uses `useAppQuery` + `AsyncView`, which is the mandated pattern for
anything async (`apps/AGENTS.md` invariant 10) and gives us the layout-matching
skeleton, the caused empty state, and the calm error state for free.

**Known behaviour, accepted:** the day flips at 00:00 UTC, not in the viewer's
local timezone. For a quote widget this is explicable and not worth per-user
date negotiation.

### Selection function

`index = daysSinceEpoch(UTC) % quotes.length` — a plain rotation, not a hash.
With a prime-ish list length the cycle is long enough to feel unordered, it is
trivially testable, and adding a quote reshuffles the future rather than
corrupting a stored state (there is no stored state).

## Structure

```
apps/wall-e/
  app.json                       # global: true, one widget, no connectors/db
  lib/shared/quotes.ts           # the curated list + pickQuoteForDate()
  api/quote/route.ts             # defineRoute GET, auth ["session"], output schema
  widgets/quote-of-the-day.tsx   # "use client", useAppQuery + AsyncView
  plans/                         # this file
```

- **`lib/shared/quotes.ts`** — `lib/shared/` (not `lib/server/`) on purpose: it is
  pure data with no server imports, and `lib/server/**` is the tier a widget is
  forbidden to import. Nothing here reaches a connector or the DB. Exports
  `QUOTES` (readonly array of `{ text, character }`) and `pickQuoteForDate(date)`.
- **`api/quote/route.ts`** — `defineRoute({ auth: ["session"], output, handler })`.
  No `input` (the server owns the date, deliberately — a client-supplied date
  would let a caller pick its own quote and reintroduce the divergence above).
  Output is `{ text, character, date }`.
- **`widgets/quote-of-the-day.tsx`** — widget id is derived from this filename, so
  it must not be renamed after anyone saves a dashboard. Skeleton mirrors the
  loaded layout (two text lines + a short byline) so nothing shifts.

### Visual

Quote text in `text-foreground`, byline in `text-muted-foreground`, both on the
widget's own `bg-card` — no tinted surface, so we stay clear of the
`text-muted-foreground` on `bg-muted` pair that measures 4.34:1 and now fails
`mos-design/no-low-contrast-token-pairs` as an error. A decorative Lucide
`Quote` glyph is `aria-hidden`. No `dark:` variants anywhere; the theme handles
both modes.

`icon: "bot"`, `defaultSize: { w: 4, h: 2 }`, `minSize: { w: 2, h: 2 }` — quotes
need horizontal room more than vertical.

## Verification

1. `npx tsx scripts/generate-project-registry.ts` — app appears with the
   `quote-of-the-day` widget and the `GET /quote` route.
2. `npm run typecheck`.
3. `npx eslint apps/wall-e` — zero errors, including the contrast rule.
4. Load the dashboard in a browser, add the widget, confirm the golden path
   renders and that a reload returns the same quote (the day-stability property).
5. Edge case: confirm the skeleton does not shift the layout when data lands.

No smoke test (no connectors), no migrations (no database), no scheduler (no
jobs), no MCP tools.
