/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A labelled form control.
 *
 * `docs/apps/ux.md` requires that "form inputs have associated `<label>`s". A
 * hand-rolled `<input>` satisfies that only if the author remembers to write a
 * label AND to wire `htmlFor` to a matching `id`. Two chances to get it wrong,
 * both invisible until someone opens a screen reader.
 *
 * `Field` owns the id. `label` is required by the type, the `htmlFor`/`id` pair
 * is generated, and `aria-describedby` is wired to the hint and the error when
 * they exist. The control is a render prop receiving the ids it must use, so
 * there is no way to render a field whose label points at nothing.
 *
 * An `error` is announced (`role="alert"`) and marks the control invalid; a
 * `hint` is not. They are different things and the component keeps them apart.
 */
export interface FieldRenderArgs {
  id: string;
  "aria-describedby": string | undefined;
  "aria-invalid": boolean | undefined;
}

export interface FieldProps {
  /** Required. A field without a name is a field nobody can operate. */
  label: string;
  /** A definition or caveat. Never the only copy of something that matters. */
  hint?: string;
  /** Announced to assistive tech and marks the control invalid. */
  error?: string;
  required?: boolean;
  className?: string;
  children: (args: FieldRenderArgs) => ReactNode;
}

export function Field({
  label,
  hint,
  error,
  required,
  className,
  children,
}: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={id} className="block text-sm font-medium text-foreground">
        {label}
        {required && (
          <span className="ml-1 text-destructive" aria-hidden>
            *
          </span>
        )}
        {required && <span className="sr-only"> (required)</span>}
      </label>

      {children({
        id,
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : undefined,
      })}

      {hint && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
