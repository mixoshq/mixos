/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { cn } from "@/lib/utils";

/**
 * An on/off switch that acts the moment it is clicked: a pill track with a
 * sliding knob, and the state in words beside it.
 *
 * WHY A PRIMITIVE. It was drawn inline in the App Manager, and the next screen
 * to need one (the MCP tool switches in an app's admin dialog) reached for the
 * form `Switch` instead, which has no knob, so the same idea looked like two
 * different controls. One component is what keeps them the same.
 *
 * NOT A FORM FIELD. `Switch` (in ./input) is a checkbox: it sits in a form and
 * its value is submitted with it. This is a button that changes something
 * immediately, so it is `role="switch"` with `aria-checked`, and the caller
 * does the work in `onCheckedChange`.
 *
 * THE STATE WORD IS VISIBLE, NOT ONLY ANNOUNCED. "Enabled" in the brand ink
 * beside a filled track, "Disabled" in muted ink beside an empty one: colour
 * alone does not say which way round a switch reads, and the word does.
 */
export interface ToggleProps {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  /**
   * What the switch turns on and off, for assistive tech: "Wall·E", "the count
   * tool". Required — a switch announced only as "Enable" does not say what it
   * enables.
   */
  label: string;
  /** Cannot be used right now. Say why with `title`. */
  disabled?: boolean;
  /** A change is being saved: dimmed and inert until it lands. */
  busy?: boolean;
  /** A tooltip, typically the reason it is disabled. */
  title?: string;
  /** The visible state words. Default "Enabled" / "Disabled". */
  onText?: string;
  offText?: string;
}

export function Toggle({
  checked,
  onCheckedChange,
  label,
  disabled = false,
  busy = false,
  title,
  onText = "Enabled",
  offText = "Disabled",
}: ToggleProps) {
  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden
        className={cn(
          "text-xs font-medium",
          checked ? "text-brand" : "text-muted-foreground",
        )}
      >
        {checked ? onText : offText}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        aria-busy={busy || undefined}
        disabled={disabled || busy}
        title={title}
        onClick={() => onCheckedChange(!checked)}
        className={cn(
          "relative h-6 w-11 shrink-0 rounded-full transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          checked ? "bg-primary" : "bg-muted",
          (disabled || busy) && "opacity-50",
          disabled && "cursor-not-allowed",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "absolute top-0.5 block h-5 w-5 rounded-full border border-border bg-background shadow transition-transform",
            checked ? "translate-x-5" : "translate-x-0.5",
          )}
        />
      </button>
    </div>
  );
}
