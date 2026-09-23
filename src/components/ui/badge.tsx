/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A small label.
 *
 * The tones split along the line `docs/apps/ux.md` draws between colour that
 * GRADES and colour that DISTINGUISHES. `success`/`warning`/`danger` grade —
 * they say something is good or bad. `cat-1`…`cat-6` distinguish — they say
 * "this is a different one". Borrowing a status tone for a category chip tells
 * the user that category is an error, which is the slip the guide calls out.
 *
 * Every tone here is a **solid fill with its own foreground**, never a token on
 * its own tint. That is the second measured rule: `text-warning` on
 * `bg-warning/10` is 4.39:1 and fails, while `bg-warning text-warning-foreground`
 * is verified. A solid chip is also louder, which is usually what the wash was
 * reaching for.
 */
export type BadgeTone =
  | "neutral"
  | "success"
  | "warning"
  | "danger"
  | "cat-1"
  | "cat-2"
  | "cat-3"
  | "cat-4"
  | "cat-5"
  | "cat-6";

const TONES: Record<BadgeTone, string> = {
  neutral: "bg-muted text-foreground",
  success: "bg-success text-success-foreground",
  warning: "bg-warning text-warning-foreground",
  danger: "bg-destructive text-destructive-foreground",
  "cat-1": "bg-cat-1 text-background",
  "cat-2": "bg-cat-2 text-background",
  "cat-3": "bg-cat-3 text-background",
  "cat-4": "bg-cat-4 text-background",
  "cat-5": "bg-cat-5 text-background",
  "cat-6": "bg-cat-6 text-background",
};

/**
 * Assign a categorical tone by stable index — never by meaning.
 *
 * Deriving a colour from a value's identity is what keeps a category the same
 * colour across renders; deriving it from whether the value is "bad" is how a
 * category chip ends up red.
 */
export function categoricalTone(index: number): BadgeTone {
  const ramp: BadgeTone[] = ["cat-1", "cat-2", "cat-3", "cat-4", "cat-5", "cat-6"];
  return ramp[Math.abs(index) % ramp.length];
}

export function Badge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
