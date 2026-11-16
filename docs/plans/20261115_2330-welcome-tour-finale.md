# Welcome tour: a finale in place of the guide

**Scope:** platform — `src/components/onboarding/`, `src/app/globals.css`, and
the guide's hooks in the dashboard, the Apps menu and App Manager.

## Context

The welcome tour ([`20260921_2323-welcome-tour.md`](20260921_2323-welcome-tour.md))
ends its takeover by collapsing into the menu bar, then hands over to a guide:
step bubbles that point at the menu bar, wait for App Manager to open, then
wait for a widget to be added and editing finished. Only then does "MixOS is
yours." come up, with confetti from behind the card.

The guide asks for work before the tour can end. A newcomer who doesn't want
to install an app yet is left with a bubble waiting on them, and Skip tour is
the only way out of it.

## Decision

- **The screens before Let's begin are unchanged**, except that Let's begin
  comes up 740ms after the tagline rather than two seconds. It still
  collapses the overlay into the menu bar.
- **No guide.** `guide.tsx`, `steps.ts` and the `guide` phase are gone, along
  with every `data-tour` hook that only the guide pointed at, the dashboard's
  staging around the guide step (its hidden empty state and auto-opened
  catalog) and the `dashboard:widget-added` event. The takeover's own hooks
  (`menu-bar`, `menu-bar-logo`, `login-mark`, `login-wordmark`) stay.
- **The collapse ends the tour.** `revealed()` stamps completion and pops the
  "is yours" card in over the dashboard. Under the headline it names the
  three things there are to add — apps, connectors and themes, with
  Administration's icons for each and one line apiece. On a phone, where three
  one-line captions don't fit side by side, they stack as rows.
- **I'm ready is the celebration.** The card has one button, I'm ready, with
  no checkbox. Pressing it — or closing the card any other way, Enter, Escape
  or a click on the dim — fades the card and bursts the confetti from the
  button. The card drops under the confetti's layer as it fades, so the burst
  comes out over it.
- **The confetti spells the name.** 40% of the 1983 pieces fly to spots inside
  the brand name's letters, set in the headline's typeface across the whole
  width of the screen and centred in the page under the menu bar. They hang
  there about 470ms, then all let go together. The other 60% burst out
  evenly over the whole screen, the word included, and fall at once. The
  spots come from drawing the name on an offscreen canvas and sampling its
  ink on a grid, measured in the close handler so the confetti's render
  stays pure.
- **The fall is organic.** Each piece falls at its own speed, within 20% of
  the average, so the word crumbles rather than dropping as one; flutters
  side to side with its own swing once it lets go; and tumbles round its own
  tilted axis at its own rate. Each piece is two elements, so the four
  motions — out, fall, flutter, tumble — each have a transform property of
  their own (`translate`, `transform`, `translate`, `rotate`). The straggler
  still goes straight up, hangs, and is the last down, slowly.
- **Colours are the theme's**, its categorical ramp, primary and brand accent,
  and each piece's is picked at random. The MixOS mark's own colours are no
  longer used.
- **The Enter keycap no longer blinks.**

## Verify

Replay the tour from Preferences, at desktop width and at 375px. Check that
the screens are unchanged, the overlay collapses into the bar, and the card
pops in with three columns (rows on a phone) and one-line captions. Then
check that I'm ready, and Escape, each fade the card and spell the name in
confetti from the button.
