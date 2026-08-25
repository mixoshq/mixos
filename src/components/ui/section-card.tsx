"use client";

/**
 * Building blocks for settings and detail screens: a stack of section cards
 * that each save independently.
 *
 * Two conventions are baked in and worth stating, because both are easy to get
 * backwards:
 *
 *  - **`footer` is optional, and that IS the permission model.** A viewer sees
 *    the same card with no save row, not a greyed-out one. A disabled button
 *    advertises a capability the user doesn't have and invites them to go
 *    hunting for why it's off; an absent one just reads as "this is
 *    reference material". Pass `footer={canEdit ? <SaveRow …/> : undefined}`.
 *    This is UX only — the route still enforces the role server-side.
 *
 *  - **Sections save independently.** One page-level Save across eight
 *    sections means a user who edited one field can't tell what else they're
 *    about to commit. Per-card `SaveRow` keeps the blast radius of a save equal
 *    to what the user was looking at.
 */

import { CARD_SHELL } from "./card";

/** Parse a numeric text input to a non-negative integer, or null when blank. */
export function toNum(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

export const numStr = (n: number | null): string => (n == null ? "" : String(n));

const FIELD_CLASS =
  "mt-1 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground disabled:opacity-70";

/** Label + optional right-aligned hint, shared by the field components. */
function FieldLabel({ label, hint }: { label: string; hint?: string }) {
  return (
    <span className="flex items-baseline justify-between gap-2 text-xs font-medium text-muted-foreground">
      {label}
      {hint && <span className="text-xs font-normal">{hint}</span>}
    </span>
  );
}

export function NumberField({
  label,
  hint,
  value,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number | null;
  disabled?: boolean;
  onChange: (n: number | null) => void;
}) {
  return (
    <label className="block">
      <FieldLabel label={label} hint={hint} />
      <input
        type="number"
        min={0}
        inputMode="numeric"
        value={numStr(value)}
        disabled={disabled}
        onChange={(e) => onChange(toNum(e.target.value))}
        className={FIELD_CLASS}
      />
    </label>
  );
}

export function TextField({
  label,
  hint,
  value,
  disabled,
  placeholder,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  disabled?: boolean;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <FieldLabel label={label} hint={hint} />
      <input
        type="text"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={FIELD_CLASS}
      />
    </label>
  );
}

/**
 * One section on a settings or detail page: title, optional hint, body, and a
 * footer that only appears when the caller passes one.
 *
 * NOT the same thing as `Card` / `CardHeader` in [`./card.tsx`](./card.tsx), and
 * the difference is worth keeping straight before you reach for either:
 *
 *  - **`SectionCard` is a form section.** Its title is deliberately `text-sm` and
 *    `h3` — it's a field-group label, not a heading you'd scan a dashboard by — it
 *    carries a `hint` line, its body is evenly padded for inputs, and its footer
 *    is a `SaveRow`. Use it on Configure pages and settings screens.
 *  - **`Card` is a dashboard panel.** `text-lg` title, a right-hand status slot,
 *    no footer, no save semantics.
 *
 * It borrows `CARD_SHELL` so the two can't drift on radius, border or fill, but
 * keeps its own header and body padding on purpose: those are tuned for stacked
 * form rows, and adopting the dashboard paddings would restyle every settings page
 * in the product.
 */
export function SectionCard({
  title,
  hint,
  children,
  footer,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  /** Omit for read-only viewers — see the note at the top of this file. */
  footer?: React.ReactNode;
}) {
  return (
    <section className={CARD_SHELL}>
      <div className="border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {hint && (
          <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
            {hint}
          </p>
        )}
      </div>
      <div className="px-4 py-4">{children}</div>
      {footer && (
        <div className="flex items-center gap-3 border-t border-border px-4 py-3">
          {footer}
        </div>
      )}
    </section>
  );
}

/**
 * Save button + confirmation, for a `SectionCard` footer.
 *
 * Disabled until there's something to save, so the button's enabled state is
 * itself the "you have unsaved changes" signal. The confirmation clears as soon
 * as the user edits again — a stale "Saved." next to a dirty form is a lie.
 */
export function SaveRow({
  onSave,
  saving,
  dirty,
  saved,
  label = "Save",
}: {
  onSave: () => void;
  saving: boolean;
  dirty: boolean;
  saved: boolean;
  label?: string;
}) {
  return (
    <>
      <button
        type="button"
        onClick={onSave}
        disabled={saving || !dirty}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
      >
        {saving ? "Saving…" : label}
      </button>
      {saved && !dirty && (
        <span role="status" className="text-xs text-success">
          Saved.
        </span>
      )}
    </>
  );
}

/** Right-aligned "Add" row, between a list page's summary text and the list. */
export function AddRow({
  onAdd,
  disabled,
  title,
  label = "Add",
}: {
  onAdd: () => void;
  disabled?: boolean;
  title?: string;
  label?: string;
}) {
  return (
    <div className="flex justify-end">
      <button
        type="button"
        onClick={onAdd}
        disabled={disabled}
        title={title}
        className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
      >
        <span aria-hidden className="text-base leading-none">
          +
        </span>{" "}
        {label}
      </button>
    </div>
  );
}
