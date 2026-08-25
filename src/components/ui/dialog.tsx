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
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type ReactNode,
} from "react";
import { X } from "lucide-react";

/** Panel widths. `md` suits a form or a message; `lg` a table or a diff. */
const WIDTHS = {
  sm: "max-w-md",
  md: "max-w-xl",
  lg: "max-w-3xl",
} as const;

export function Dialog({
  open,
  onClose,
  title,
  size = "md",
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  /** Announced as the dialog's accessible name. Required for that reason. */
  title: string;
  size?: keyof typeof WIDTHS;
  children: ReactNode;
  /** Action row, pinned below the scrolling content. */
  footer?: ReactNode;
}) {
  const titleId = useId();
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
        tabIndex={-1}
        className={`relative flex max-h-[85vh] w-full ${WIDTHS[size]} flex-col rounded-xl border border-border bg-card shadow-xl`}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <h2 id={titleId} className="text-lg font-semibold text-foreground">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto rounded-md p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
