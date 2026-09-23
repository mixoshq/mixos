/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import {
  forwardRef,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "@/lib/utils";

/**
 * Text-entry controls.
 *
 * These exist so an app never writes a bare `<input>`: the focus ring, the
 * disabled treatment, the border token, and the invalid state are decided once.
 * `ux.md` forbids restyling focus rings away, and a hand-rolled input is how
 * that happens by accident.
 *
 * They carry no label. Wrap them in `Field`, which owns the id and the
 * `htmlFor` wiring — see field.tsx for why that is not optional.
 */
const CONTROL = cn(
  "mix-input",
  // `bg-background`, not `bg-card`: a control has to be distinguishable from
  // the surface it sits in, and most of them sit in a `bg-card` panel. The
  // ladder in themes/<slug>/theme.css keeps the two a step apart in both modes.
  //
  // `border-input`, not `border-border`: --border is the ungated decorative
  // hairline. A control's boundary is what tells a user where the control IS,
  // so it has its own token, verified at 3:1 against --card. Using the divider
  // token here was quietly opting the one border that carries information out
  // of the only check that covers it.
  "w-full rounded-md border border-input bg-background px-3 text-sm text-foreground",
  "placeholder:text-muted-foreground",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
  "disabled:cursor-not-allowed disabled:opacity-50",
  "aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:ring-destructive",
);

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(CONTROL, "h-10", className)} {...rest} />;
});

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, rows = 4, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(CONTROL, "py-2 leading-relaxed", className)}
      {...rest}
    />
  );
});

export interface SelectOption {
  label: string;
  value: string;
}

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "children"> {
  options: SelectOption[];
  /** Rendered as a disabled first option, so "nothing chosen" is explicit. */
  placeholder?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  function Select({ options, placeholder, className, ...rest }, ref) {
    return (
      <select ref={ref} className={cn(CONTROL, "h-10", className)} {...rest}>
        {placeholder && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  },
);

/**
 * A checkbox with its own label, because a checkbox's label is its hit target —
 * splitting them the way `Field` does would make the control harder to click,
 * not easier.
 */
export interface CheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: string;
  hint?: string;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  function Checkbox({ label, hint, className, ...rest }, ref) {
    return (
      <label
        className={cn(
          "flex cursor-pointer items-start gap-2.5 text-sm text-foreground",
          // The CONTROL dims (`disabled:opacity-50` below); the label text does
          // not. WCAG exempts inactive controls, not the words explaining them,
          // and a legible label on a disabled field is what tells someone why
          // they cannot edit it.
          rest.disabled && "cursor-not-allowed",
          className,
        )}
      >
        <input
          ref={ref}
          type="checkbox"
          className="mt-0.5 h-4 w-4 rounded border-border text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          {...rest}
        />
        <span>
          {label}
          {hint && (
            <span className="block text-xs text-muted-foreground">{hint}</span>
          )}
        </span>
      </label>
    );
  },
);

/** A checkbox styled as a switch. Same semantics, different affordance. */
export const Switch = forwardRef<HTMLInputElement, CheckboxProps>(
  function Switch({ label, hint, className, ...rest }, ref) {
    return (
      <label
        className={cn(
          "flex cursor-pointer items-center justify-between gap-4 text-sm text-foreground",
          rest.disabled && "cursor-not-allowed",
          className,
        )}
      >
        <span>
          {label}
          {hint && (
            <span className="block text-xs text-muted-foreground">{hint}</span>
          )}
        </span>
        <input
          ref={ref}
          type="checkbox"
          role="switch"
          className="h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full bg-muted transition-colors checked:bg-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          {...rest}
        />
      </label>
    );
  },
);
