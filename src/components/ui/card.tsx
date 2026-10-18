/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Card chrome: one shell, one header row, one body.
 *
 * WHY THIS EXISTS. Hand-rolled `rounded-lg border border-border bg-card` shells
 * drift the way copies do: the same visual weight ends up as `h2 text-lg`,
 * `h2 text-sm` or `h3 text-sm`, and as h1 to h4 across apps, and some pad the
 * whole card with `p-4` while others pad header and body separately.
 *
 * WHAT THE CALL SITES DICTATED. This API is smaller than the version it was
 * generalized from, because sampling all 86 first showed the bigger one wouldn't
 * fit:
 *
 *   - **47 of 86 shells have no heading at all.** So `Card` is a bare shell and
 *     `CardHeader` is a separate, optional component. A card component that
 *     required a title would have fit fewer than half its call sites.
 *   - **Only 1 of 86 drew a rule under its header.** So the rule is opt-in
 *     (`<CardBody divided>`), not the default — shipping it on would have
 *     restyled 16 apps as a side effect of a refactor.
 *   - **26 of 86 have a right-hand slot** (a count, an age, a status), so `right`
 *     is here — but optional.
 *   - Heading levels genuinely vary, so `as` is a prop. See its note.
 *
 * The source version also had a `lens` prop, which encoded one app's
 * two-lens framing. That stays in that app: a shared primitive shouldn't carry
 * one team's vocabulary. Anything of that kind goes in as `children`.
 *
 * NOT `SectionCard` in ./section-card.tsx. That one
 * is a **form section**: an `h3 text-sm` field-group label, a `hint` line, evenly
 * padded body, and a `SaveRow` footer whose absence is the read-only permission
 * model. This one is a **dashboard panel**: `text-lg` title, a right-hand status
 * slot, no footer. Settings screen → `SectionCard`. Panel of numbers or a chart →
 * `Card`. `SectionCard` borrows `CARD_SHELL` **and the `5` padding scale** from
 * here so the two can't drift on radius, border, fill or inset.
 *
 * FLOATING SURFACES take `CARD_SHELL` and nothing else. `Dialog` and `Menu` share
 * this radius, border and fill so every surface in the product has one edge
 * treatment, but they keep their own insets and their own `shadow-*`: a modal
 * over a scrim needs elevation to read as lifted, and a menu's rows pad
 * themselves, so `p-5` around them would be wrong. Inline cards are flat.
 *
 * See docs/apps/app-shell.md#cards-one-shell-per-thing-and-every-card-says-who-owns-it.
 */
import type { ReactNode } from "react";

/** The shell. No padding of its own — header and body pad themselves. */
/**
 * `mix-card` is a THEME HOOK, not a style. It carries no rules of its own — it
 * exists so a theme can reach this surface (see themes/AGENTS.md) without
 * selecting a utility class that a refactor is free to change. Every hook in
 * src/components/ui/ works the same way, and the allowlist of legal hooks lives
 * in src/lib/themes/tokens.ts.
 *
 * WHICH ONE TO IMPORT. `CARD_SURFACE` is the chrome alone — radius, border,
 * fill. `CARD_SHELL` is that chrome plus the `.mix-card` hook, and it is what an
 * ordinary card wants.
 *
 * A surface that owns a **different** hook takes `CARD_SURFACE` and adds its own:
 * a widget is `.mix-widget`, a modal `.mix-modal`, a dropdown `.mix-popover`, and
 * those are separate entries in `SURFACE_ALLOWLIST` precisely so a theme can
 * restyle dashboard widgets without also restyling every panel on the settings
 * page. Handing them `CARD_SHELL` would quietly merge four themeable surfaces
 * into one and there would be no way for a theme to tell them apart again.
 */
export const CARD_SURFACE = "rounded-lg border border-border bg-card";
export const CARD_SHELL = `mix-card ${CARD_SURFACE}`;
/**
 * THE PADDING SCALE IS ONE NUMBER: 5.
 *
 * Header, body and divided body all inset by `5` on every side they own, so a
 * headerless card is exactly `p-5` and a card with a header reads as one evenly
 * inset block. Before this there were two scales — `px-4 py-3` on the header and
 * `px-4 pb-4 pt-3` on the body — which is why a card's top inset (12px) never
 * matched its sides (16px), and why the analytics panels had been hand-rolled at
 * `p-5` instead of using this file at all.
 *
 * The header carries `pb-0` and lets the body's own `p-5` open the gap beneath
 * the title, rather than both sides contributing padding into the same seam. Two
 * components padding one gap is how the old numbers drifted apart.
 *
 * **No elevation here on purpose.** Inline cards are flat — the border is the
 * edge. Elevation belongs only to surfaces that genuinely float above the page
 * (`Dialog`, `Menu`), and those add their own `shadow-*` on top of this shell.
 */
export const CARD_HEADER = "px-5 pt-5 pb-0";
/** The title row inside the header. A `description` line sits under it, not in it. */
export const CARD_HEADER_ROW = "flex flex-wrap items-center gap-2";
export const CARD_TITLE = "text-lg font-semibold text-foreground";
/** Sub-line under a card title. `text-sm`, one step down from `CARD_TITLE`. */
export const CARD_DESCRIPTION = "mt-0.5 text-sm text-muted-foreground";
/** Body padding, no separating rule. Also the whole inset of a headerless card. */
export const CARD_BODY = "p-5";
/** Body padding plus the rule that separates it from the header. */
export const CARD_BODY_DIVIDED = `border-t border-border ${CARD_BODY}`;
/** Right-aligned header slot — a count, an age, a status. */
export const CARD_HEADER_RIGHT =
  "ml-auto flex items-center gap-2 text-right text-xs text-muted-foreground";

/**
 * A card shell.
 *
 * Renders a `<section>` when given an `id` — an anchor target that jump links
 * scroll to should be a landmark, not a `div` — and a `<div>` otherwise. Pass
 * `as` to override.
 */
export function Card({
  id,
  as,
  className,
  children,
}: {
  /** Anchor target for jump links. Also adds `scroll-mt-*` so a sticky header can't cover it. */
  id?: string;
  as?: "div" | "section" | "article" | "aside";
  className?: string;
  children: ReactNode;
}) {
  const Tag = as ?? (id ? "section" : "div");
  return (
    <Tag
      id={id}
      className={`${CARD_SHELL}${id ? " scroll-mt-28" : ""}${className ? ` ${className}` : ""}`}
    >
      {children}
    </Tag>
  );
}

/**
 * A card header: title, then anything you pass as `children`, then an optional
 * right-aligned slot.
 *
 * `right` is for **status, not actions** — "updated 4m ago", a count, a band. A
 * refresh button or a filter belongs in the body next to what it affects, where
 * the user is looking when they want it.
 */
export function CardHeader({
  title,
  as = "h2",
  description,
  right,
  className,
  children,
}: {
  title: ReactNode;
  /**
   * The heading level. **Not cosmetic** — the visual size comes from
   * `CARD_TITLE`, but this is the document outline a screen-reader user navigates
   * by. A card inside a section that already has an `<h2>` takes `as="h3"`. It
   * defaults to `h2` because a card directly under a page `<h1>` is the common
   * case, not because h2 is the safe answer.
   */
  as?: "h2" | "h3" | "h4" | "p";
  /**
   * A sentence under the title saying what the panel is showing. Rendered
   * **below** the title row, not inside it — it is prose, and prose in a flex row
   * that also holds chips and a status slot wraps into a mess at narrow widths.
   */
  description?: ReactNode;
  /** Status shown at the right end of the row. */
  right?: ReactNode;
  className?: string;
  /** Chips, badges, tags — rendered between the title and `right`. */
  children?: ReactNode;
}) {
  const Tag = as;
  return (
    <div className={`${CARD_HEADER}${className ? ` ${className}` : ""}`}>
      <div className={CARD_HEADER_ROW}>
        <Tag className={CARD_TITLE}>{title}</Tag>
        {children}
        {right != null && <span className={CARD_HEADER_RIGHT}>{right}</span>}
      </div>
      {description != null && <p className={CARD_DESCRIPTION}>{description}</p>}
    </div>
  );
}

/**
 * The card's content region.
 *
 * `divided` draws the rule under the header. Opt in per app and then be
 * consistent: a page where some cards rule their header and some don't reads as
 * unfinished. The rule lives here rather than on `CardHeader` so there is exactly
 * one class that can draw it — a `border-b` header plus a `border-t` body is a
 * double line, and that is the mistake this API is shaped to prevent.
 */
export function CardBody({
  divided = false,
  className,
  children,
}: {
  divided?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`${divided ? CARD_BODY_DIVIDED : CARD_BODY}${className ? ` ${className}` : ""}`}
    >
      {children}
    </div>
  );
}
