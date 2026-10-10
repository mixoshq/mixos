/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

/**
 * An on-demand explanation, on hover **and** on focus.
 *
 * WHY THIS EXISTS. `title=` was carrying meaning in **84 files**. A native title
 * tooltip is mouse-only, invisible until hover, delayed about a second,
 * un-stylable, never shown on touch, and inconsistently surfaced by screen
 * readers. It is where information goes to be technically present.
 *
 * This is the replacement for the one case that genuinely wants a tooltip: a
 * definition or a caveat that some readers want and most don't. Everything else
 * belongs on the page — see docs/apps/ux.md#title-is-not-an-affordance.
 *
 * Not the same thing as a chart tooltip, which positions itself from a hovered
 * data index inside an SVG plot. This one anchors to its own trigger.
 */
import { useEffect, useId, useState, type ReactNode } from "react";

export function InfoTooltip({
  tip,
  children,
  align = "left",
  className,
}: {
  tip: ReactNode;
  /** The trigger. An icon, a word, a badge — whatever the tip explains. */
  children: ReactNode;
  /** Which edge the bubble aligns to. Use `right` for triggers near the right edge. */
  align?: "left" | "right";
  className?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);

  // Escape closes the bubble wherever focus is: it may have opened on hover,
  // with focus somewhere else on the page. Listened for in the capture phase
  // and stopped there, so the same key press does not also close a dialog the
  // tooltip sits in. It stays closed until the trigger is hovered or focused
  // again.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);

  return (
    <span
      className={`relative inline-flex${className ? ` ${className}` : ""}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      // React's onFocus/onBlur have focusin/focusout semantics — they bubble — so
      // focusing the trigger inside opens the bubble without the trigger needing
      // to know about it.
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {/* tabIndex is what makes this not mouse-only. Without it a keyboard user
          has no way to reach the explanation at all. */}
      <span
        tabIndex={0}
        aria-describedby={open ? id : undefined}
        className="inline-flex rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {children}
      </span>
      {open && (
        <span
          id={id}
          role="tooltip"
          // Left-aligned text: a definition is prose, and centred prose in a
          // narrow bubble is measurably harder to scan.
          className={`absolute top-full z-30 mt-1.5 w-64 rounded-lg border border-border bg-popover px-3 py-2 text-left text-xs font-normal leading-snug text-popover-foreground shadow-md ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {tip}
        </span>
      )}
    </span>
  );
}
