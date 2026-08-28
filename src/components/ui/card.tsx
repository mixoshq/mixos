/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Card chrome: one shell, one header row, one body.
 *
 * WHY THIS EXISTS. Before this file there were **86 hand-rolled
 * `rounded-xl border border-border bg-card` shells across 16 apps**, and they had
 * drifted the way copies do. Within a single app, four cards carried
 * `h2 text-lg`, `h2 text-sm` and `h3 text-sm` between them; some padded the whole
 * card with `p-4` while others padded header and body separately. Across apps the
 * heading tag for the same visual weight was h1, h2, h3 and h4.
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
 * NOT `SectionCard` in ./section-card.tsx, which predates this and stays. That one
 * is a **form section**: an `h3 text-sm` field-group label, a `hint` line, evenly
 * padded body, and a `SaveRow` footer whose absence is the read-only permission
 * model. This one is a **dashboard panel**: `text-lg` title, a right-hand status
 * slot, no footer. Settings screen → `SectionCard`. Panel of numbers or a chart →
 * `Card`. `SectionCard` borrows `CARD_SHELL` from here so the two can't drift on
 * radius, border or fill.
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
 */
export const CARD_SHELL = "mix-card rounded-xl border border-border bg-card";
/** Header row. The padding AND the type size live here, nowhere else. */
export const CARD_HEADER = "flex flex-wrap items-center gap-2 px-4 py-3";
export const CARD_TITLE = "text-lg font-semibold text-foreground";
/** Body padding, no separating rule. */
export const CARD_BODY = "px-4 pb-4 pt-3";
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
  /** Status shown at the right end of the row. */
  right?: ReactNode;
  className?: string;
  /** Chips, badges, tags — rendered between the title and `right`. */
  children?: ReactNode;
}) {
  const Tag = as;
  return (
    <div className={`${CARD_HEADER}${className ? ` ${className}` : ""}`}>
      <Tag className={CARD_TITLE}>{title}</Tag>
      {children}
      {right != null && <span className={CARD_HEADER_RIGHT}>{right}</span>}
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
