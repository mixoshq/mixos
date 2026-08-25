"use client";

/**
 * Status indicators that cannot be built colour-only.
 *
 * Both components take a required `label`, which is rendered into `aria-label`
 * and `title`. That's deliberate: "don't communicate state with colour alone"
 * is the kind of rule that gets nodded at in review and then quietly skipped,
 * so here the type signature refuses to compile without the text alternative
 * rather than a reviewer having to catch it.
 *
 * Colours come from the semantic tokens in globals.css, which are verified to
 * clear WCAG AA in both themes. Never pass a hex.
 */

/** Semantic status. `null` means "not known yet" — a distinct state from every
 *  other, and NOT the same as "fine". */
export type StatusTone = "success" | "warning" | "danger" | "neutral";

const DOT_TONE: Record<StatusTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
  neutral: "bg-muted-foreground",
};

const PILL_TONE: Record<StatusTone, string> = {
  success: "bg-success text-success-foreground",
  warning: "bg-warning text-warning-foreground",
  danger: "bg-destructive text-destructive-foreground",
  neutral: "bg-muted text-foreground",
};

/**
 * Small filled dot for table rows and list items.
 *
 * A `null` tone renders a hollow ring rather than nothing at all, so a column of
 * these stays aligned and "not yet analysed" reads as its own state instead of
 * looking like a rendering bug.
 */
export function StatusDot({
  tone,
  label,
  className = "",
}: {
  tone: StatusTone | null;
  /** Required. Becomes the accessible name, e.g. "Health: at risk". */
  label: string;
  className?: string;
}) {
  const base = "inline-block h-2.5 w-2.5 shrink-0 rounded-full";
  if (tone === null) {
    return (
      <span
        className={`${base} border border-muted-foreground/40 ${className}`}
        title={label}
        aria-label={label}
        role="img"
      />
    );
  }
  return (
    <span
      className={`${base} ${DOT_TONE[tone]} ${className}`}
      title={label}
      aria-label={label}
      role="img"
    />
  );
}

/**
 * A legend swatch: a small block of the status colour with its meaning **beside
 * it as visible text**.
 *
 * This is the third shape, and the distinction from its siblings matters:
 * `StatusDot` marks one row and keeps its label for assistive tech; `StatusPill`
 * puts the text *inside* the fill; `StatusSwatch` is what a key is made of —
 * colour next to words, explaining a chart or a column elsewhere on the page.
 *
 * It takes a **token**, not a fill. Sampling a chart's actual wash sounds more
 * correct and often isn't: three band washes at 8% alpha once differed by 3 of
 * 255 per channel — 1.01:1 — so the "key" was three identical white chips. Where
 * the washes are that faint, the swatch steps up to the opaque token and the
 * chart keeps its wash. See docs/apps/ux.md#legends-sample-the-fill-unless-the-fills-dont-differ.
 */
export function StatusSwatch({
  tone,
  children,
  className = "",
}: {
  tone: StatusTone;
  /** The meaning, as visible text. Not optional — a bare chip is a colour-only status. */
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <span
        aria-hidden
        className={`inline-block h-2.5 w-2.5 shrink-0 rounded-sm ${DOT_TONE[tone]}`}
      />
      <span>{children}</span>
    </span>
  );
}

/**
 * Filled pill for a status that needs to be readable at a glance without
 * hovering. Prefer this over `StatusDot` when there's room — visible text beats
 * an accessible name nobody hears.
 */
export function StatusPill({
  tone,
  children,
  className = "",
}: {
  tone: StatusTone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${PILL_TONE[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
