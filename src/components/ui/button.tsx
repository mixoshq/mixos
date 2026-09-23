/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The button.
 *
 * WHY IT EXISTS AT ALL. `docs/apps/ux.md` requires that "buttons that trigger
 * work show a pending state and disable to prevent double-submits". That was a
 * rule a reviewer had to remember, and every hand-rolled `<button>` was a fresh
 * chance to forget it. Here it is a prop: pass `busy` and the pending state, the
 * disabled state, the spinner, and `aria-busy` all happen together, because they
 * are the same fact.
 *
 * `busy` implies `disabled`. That is not a convenience — a busy button that can
 * still be clicked is the double-submit the rule exists to prevent, and making
 * them separate props would let them disagree.
 *
 * TONE, NOT COLOUR. Variants name intent (`primary`, `secondary`, `ghost`,
 * `destructive`) and resolve to verified token pairs. An app never picks the
 * colour, which is what keeps `docs/apps/ux.md#color--contrast` true without
 * anyone measuring anything.
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";
export type ButtonSize = "sm" | "md";

const VARIANTS: Record<ButtonVariant, string> = {
  // Every pair here is one of the measured combinations in ux.md — a solid fill
  // with its own foreground, never a token on a tint.
  primary:
    "bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring",
  secondary:
    "bg-secondary text-secondary-foreground hover:bg-secondary/80 focus-visible:ring-ring",
  ghost:
    "bg-transparent text-foreground hover:bg-muted focus-visible:ring-ring",
  // Destructive hover is a RING, not an alpha. `bg-destructive/90` composites
  // lighter, which drops `text-destructive-foreground` on it to 4.11:1 — the
  // contrast rule measured it. Primary and secondary survive the same treatment;
  // destructive does not, which is exactly the "no threshold to memorise"
  // asymmetry ux.md documents.
  destructive:
    "bg-destructive text-destructive-foreground hover:ring-2 hover:ring-destructive/40 hover:ring-offset-1 focus-visible:ring-destructive",
};

const SIZES: Record<ButtonSize, string> = {
  // Both clear the ~36-40px touch target floor ux.md sets.
  sm: "h-9 px-3 text-sm gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
};

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /**
   * The button is doing work. Shows a spinner, disables the control, and sets
   * `aria-busy` — one prop because they are one fact.
   */
  busy?: boolean;
  /** Replaces the label while `busy`. "Saving…" beats a silent spinner. */
  busyLabel?: string;
  icon?: ReactNode;
  /** Escape hatch for layout only (width, margin). Not for colour. */
  className?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "secondary",
      size = "md",
      busy = false,
      busyLabel,
      icon,
      disabled,
      children,
      className,
      type = "button",
      ...rest
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        // `busy` implies disabled: a pending button that still accepts clicks is
        // the double-submit this component exists to prevent.
        disabled={disabled || busy}
        aria-busy={busy || undefined}
        className={cn(
          "mix-button",
          "inline-flex items-center justify-center rounded-md font-medium transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          // WCAG 1.4.3 exempts inactive controls, which is why dimming is
          // allowed here and nowhere else — see ux.md#never-dim-a-token.
          "disabled:pointer-events-none disabled:opacity-50",
          VARIANTS[variant],
          SIZES[size],
          className,
        )}
        {...rest}
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : (
          icon
        )}
        {busy && busyLabel ? busyLabel : children}
      </button>
    );
  },
);

/**
 * An icon-only button. Separate from `Button` so the `label` cannot be omitted:
 * an icon button without an accessible name is invisible to a screen reader, and
 * `ux.md` lists it as a floor requirement. The type signature enforces it.
 */
export interface IconButtonProps extends Omit<ButtonProps, "children" | "icon"> {
  label: string;
  icon: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton({ label, icon, size = "md", className, ...rest }, ref) {
    return (
      <Button
        ref={ref}
        aria-label={label}
        title={undefined}
        size={size}
        className={cn(size === "sm" ? "w-9 px-0" : "w-10 px-0", className)}
        icon={icon}
        {...rest}
      />
    );
  },
);
