/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A "Tech talk" pill: the technical detail behind a plain-language point,
 * closed until someone asks for it. The same pill mixos.org's docs use
 * (mixos-org's src/components/TechTalk.astro), in this app's tokens.
 *
 * It sits at the right end of the sentence it explains, and the detail opens
 * beneath it. Put it last inside that sentence's `<p>`, and give the `<p>`
 * `flow-root`, so the paragraph contains the floated pill instead of letting
 * it hang over what follows.
 *
 * NOT A <details>. That's block content, and inside a <p> the HTML parser
 * closes the paragraph before it, putting the pill on a line of its own —
 * what this layout exists to avoid. Everything here is phrasing content
 * (spans and a button), so it can live inside the paragraph; the detail
 * itself has to be phrasing content too (text, `<code>`, links).
 *
 * OPEN, THE PILL BECOMES A FOLDER TAB on the box's top-right corner: the
 * box's border, square bottom corners and no bottom edge, laid 1px over the
 * box's top border so the two read as one shape.
 */
export default function TechTalk({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "float-right ml-3 mt-1 inline-flex items-center gap-1 whitespace-nowrap border bg-card px-2 py-px font-mono text-[11px] font-semibold uppercase leading-normal tracking-wider text-primary transition-colors motion-reduce:transition-none",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
          open
            ? "relative z-[1] -mb-px rounded-t-sm border-border border-b-transparent pb-1"
            : "rounded-full border-muted-foreground/40 hover:border-primary",
        )}
      >
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.25}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-3.5 w-3.5 flex-none"
        >
          <path d="M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 4l-3 16" />
        </svg>
        Tech talk
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          className={cn(
            "h-3 w-3 flex-none transition-transform motion-reduce:transition-none",
            open && "rotate-180",
          )}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      <span
        id={id}
        className={cn(
          "clear-both rounded-sm rounded-tr-none border border-l-[3px] border-border border-l-primary bg-card px-4 py-3 text-sm leading-relaxed text-muted-foreground",
          open ? "block" : "hidden",
        )}
      >
        {children}
      </span>
    </span>
  );
}
