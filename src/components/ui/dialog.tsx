/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

/**
 * A focus-trapped modal dialog.
 *
 * WHY THIS EXISTS. The design system shipped no dialog, so **13 files across the
 * apps hand-rolled one**, and the accessibility floor is the part that gets
 * dropped when you're writing your own for the third time. All four of these are
 * load-bearing and none of them are visible in a screenshot:
 *
 *   - **Focus moves in on open**, or a keyboard user is still on the page behind
 *     the scrim, tabbing through controls they can't see.
 *   - **Tab is trapped**, for the same reason.
 *   - **Escape closes**, because a dialog you can only leave with the mouse is a
 *     dialog a keyboard user is stuck in.
 *   - **Focus returns to the trigger on close**, or the user is dumped at the top
 *     of the document and has to walk back to where they were.
 *
 * `aria-modal` plus `role="dialog"` plus a labelled title is what makes a screen
 * reader announce it as a dialog rather than reading it as more page content.
 *
 * The scrim is `bg-black/70`, which the colour rule explicitly permits: alpha over
 * a known ground is fine, the rule targets opaque fills posing as theme surfaces.
 *
 * See docs/apps/ux.md#accessibility-floor.
 */
import { useCallback, useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { CARD_SURFACE } from "@/components/ui/card";

/**
 * Panel widths. `md` suits a form or a message; `lg` a table or a diff; `xl` a
 * record browser — several tabs of multi-column reference content, where `lg`
 * would reflow a four-column grid into a column of stubs.
 *
 * `xl` is 5xl rather than 6xl: two columns of facts and a rail-plus-table both
 * fit comfortably at 1024px, and the step beyond that stopped reading as a
 * dialog on a laptop — it filled the screen edge to edge, which loses the sense
 * of a panel over a page that a modal depends on.
 */
const WIDTHS = {
  sm: "max-w-md",
  md: "max-w-xl",
  lg: "max-w-3xl",
  xl: "max-w-5xl",
} as const;

/**
 * The height `fixedHeight` holds, per size.
 *
 * Tied to the width rather than exposed as its own prop: a panel's height only
 * needs to be stated because its tabs differ in length, and how long they run is
 * a function of how wide the panel is. A caller free to pair `sm` with `46rem`
 * would only ever be describing a mistake.
 */
const FIXED_HEIGHTS: Record<keyof typeof WIDTHS, string> = {
  sm: "h-[38rem]",
  md: "h-[38rem]",
  lg: "h-[38rem]",
  xl: "h-[46rem]",
};

export function Dialog({
  open,
  onClose,
  title,
  icon,
  subtitle,
  tabs,
  fixedHeight = false,
  size = "md",
  children,
  footer,
  footerAside,
}: {
  open: boolean;
  onClose: () => void;
  /** Announced as the dialog's accessible name. Required for that reason. */
  title: string;
  /**
   * Rendered before the title. Decorative only — `title` stays a plain string
   * so the accessible name can never become "image image Gmail", which is what
   * happens the moment a title is allowed to be arbitrary nodes.
   */
  icon?: ReactNode;
  /**
   * A line under the title, in the header bar. Becomes the dialog's
   * `aria-describedby`, which is what a screen reader reads after the title —
   * so this is for what the dialog is *about*, not for a control or a warning.
   */
  subtitle?: ReactNode;
  /**
   * A tab band directly beneath the title, outside the scrolling body — so the
   * tabs stay put while their panel scrolls, which is the whole reason a tab
   * bar is worth having.
   *
   * Passing this also merges the header into the band: they share one muted
   * ground with no rule between them, and the only rule is the one under the
   * tabs, running the full width of the panel. The active tab's `bg-card` fill
   * then punches through that rule and reads as continuous with the body.
   */
  tabs?: ReactNode;
  /**
   * Hold one height regardless of what is in the panel.
   *
   * For a dialog whose panels differ a lot in length — a tab set, a wizard —
   * height-to-content means the panel jumps and the tabs move under the cursor
   * on every switch. Opt-in, because a confirm dialog with two lines in it
   * should still be two lines tall.
   *
   * `max-h-[85vh]` still applies, so this shrinks on a short viewport rather
   * than overflowing it. Header, tab band and footer are all outside the scroll
   * area, so a fixed height means the panel edges hold still and only the
   * content beneath them moves.
   */
  fixedHeight?: boolean;
  size?: keyof typeof WIDTHS;
  children: ReactNode;
  /** Action row, pinned below the scrolling content. */
  footer?: ReactNode;
  /**
   * Right-aligned content in the footer band, opposite the centred `footer`.
   *
   * For the record's address — the path its source lives at — which is what
   * someone reads a footer to find when they are about to go and edit it. Only
   * meaningful alongside `tabs`, since that is the branch that renders a band
   * rather than an action row.
   */
  footerAside?: ReactNode;
}) {
  const titleId = useId();
  const subtitleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  /** Whatever had focus before we opened, so we can hand it back. */
  const restoreTo = useRef<HTMLElement | null>(null);

  const focusables = useCallback(() => {
    const root = panelRef.current;
    if (!root) return [] as HTMLElement[];
    return Array.from(
      root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.offsetParent !== null);
  }, []);

  // Open: remember the trigger, move focus in. Close: hand focus back.
  // A DOM side effect, not setState, so this doesn't trip
  // `react-hooks/set-state-in-effect`.
  useEffect(() => {
    if (!open) return;
    restoreTo.current = document.activeElement as HTMLElement | null;
    const first = focusables()[0] ?? panelRef.current;
    first?.focus();
    return () => restoreTo.current?.focus();
  }, [open, focusables]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      // Keep Tab inside the dialog — without this, Tab walks out into the page
      // behind the scrim, where nothing is clickable.
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, focusables]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="presentation"
      // Click the scrim to dismiss; clicks inside the panel stop here.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div aria-hidden className="absolute inset-0 bg-black/70" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle != null ? subtitleId : undefined}
        tabIndex={-1}
        className={`mix-modal ${CARD_SURFACE} relative flex w-full ${WIDTHS[size]} flex-col shadow-xl ${
          fixedHeight ? `${FIXED_HEIGHTS[size]} max-h-[85vh]` : "max-h-[85vh]"
        }`}
      >
        {/*
          Centred while the header is one line, top-aligned once a subtitle
          makes it two — so the 13 dialogs that pass no subtitle keep exactly
          the header they had.

          With tabs, the header gives up its own bottom rule and takes the
          band's ground instead: one surface from the title down to the tabs,
          and a single rule underneath the pair.
        */}
        <div
          className={`flex gap-2 px-4 py-3 ${
            subtitle != null ? "items-start" : "items-center"
          } ${
            tabs != null
              ? // rounded-t-xl matches the panel's own radius: the panel is not
                // overflow-hidden (that would clip focus rings and any tooltip
                // that escapes its row), so the first child carrying a fill has
                // to round its own top corners or it squares off the dialog's.
                "rounded-t-xl bg-muted/40"
              : "border-b border-border"
          }`}
        >
          {icon != null && (
            <span aria-hidden className="flex shrink-0 items-center">
              {icon}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-lg font-semibold text-foreground">
              {title}
            </h2>
            {subtitle != null && (
              <p
                id={subtitleId}
                className="mt-0.5 text-sm text-muted-foreground"
              >
                {subtitle}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-md p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden className="h-4 w-4" />
          </button>
        </div>
        {/* Full-bleed: the rule under the tabs spans the whole panel, and the
            horizontal padding sits inside it. */}
        {tabs != null && (
          <div className="border-b border-border bg-muted/40 px-4">{tabs}</div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {children}
        </div>
        {/*
          Two footers, chosen by whether this dialog has tabs.

          Without tabs it is an action row — right-aligned controls, the shape
          every existing caller passes a SaveRow into. With tabs the dialog has
          banded chrome (muted header, muted tab band), and the footer completes
          it: a full-width band carrying provenance rather than actions, pinned
          outside the scroll area so it stays put. `rounded-b-xl` for the same
          reason the header rounds its top — the panel is not overflow-hidden,
          so a filled last child has to round its own corners.
        */}
        {(footer || footerAside) && (
          <div
            className={
              tabs != null
                ? "shrink-0 rounded-b-xl border-t border-border bg-muted/40 px-4 py-2.5 text-xs text-foreground"
                : "flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3"
            }
          >
            {/*
              Provenance left, path right — the band reads as one line starting
              at the panel's edge, aligned with the header and the panels above
              it. This was a three-column grid holding the provenance centred on
              the PANEL; centring bought symmetry at the cost of a ragged left
              edge that shifted with the text's own width.
            */}
            {footerAside != null && tabs != null ? (
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0">{footer}</span>
                <span className="min-w-0 shrink-0">{footerAside}</span>
              </div>
            ) : (
              footer
            )}
          </div>
        )}
      </div>
    </div>
  );
}
