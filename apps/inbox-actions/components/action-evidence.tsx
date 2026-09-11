"use client";

/**
 * The bits of UI that render a detection, shared by the page and the widgets so
 * the two can never describe the same message differently.
 *
 * The design commitment here is that a detection is always shown WITH the
 * sentence that produced it. The badge alone would be a claim the reader has to
 * take on faith from a rule engine; the badge plus the line is a claim they can
 * check in the time it takes to read it. See `lib/shared/detect.ts` for why the
 * detector is rules rather than a model.
 */

import { CalendarClock } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { StatusDot, type StatusTone } from "@/components/ui/status";
import { KIND_LABEL, type ActionItem, type ActionKind } from "../lib/shared/messages";

/**
 * Kind chips DISTINGUISH — "this ask is shaped differently from that one" — so
 * they come from the categorical ramp. Borrowing `warning`/`destructive` here
 * would tell the reader a question is an error, which is the exact slip
 * `docs/apps/ux.md` calls out.
 */
const KIND_TONE: Record<ActionKind, BadgeTone> = {
  assignment: "cat-1",
  request: "cat-2",
  question: "cat-3",
};

/** How loudly a message reads at a glance. This one genuinely grades. */
export function messageTone(actionCount: number, hasDeadline: boolean): StatusTone {
  if (actionCount === 0) return "neutral";
  return hasDeadline ? "danger" : "warning";
}

export function messageStatusLabel(
  actionCount: number,
  hasDeadline: boolean,
): string {
  if (actionCount === 0) return "No action items detected";
  const plural = actionCount === 1 ? "action item" : "action items";
  return hasDeadline
    ? `${actionCount} ${plural}, one mentioning a deadline`
    : `${actionCount} ${plural}`;
}

/**
 * The status dot plus its text. Never colour alone — the count is spelled out
 * beside the dot, and the dot carries the same sentence as its accessible name.
 */
export function ActionStatus({
  actionCount,
  hasDeadline,
  className = "",
}: {
  actionCount: number;
  hasDeadline: boolean;
  className?: string;
}) {
  const label = messageStatusLabel(actionCount, hasDeadline);
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <StatusDot tone={messageTone(actionCount, hasDeadline)} label={label} />
      <span
        className={
          actionCount > 0
            ? "text-sm font-medium text-foreground"
            : "text-sm text-muted-foreground"
        }
      >
        {actionCount === 0
          ? "No action items"
          : `${actionCount} action item${actionCount === 1 ? "" : "s"}`}
      </span>
      {hasDeadline && (
        <Badge tone="danger" className="gap-1">
          <CalendarClock className="h-3 w-3" aria-hidden />
          Deadline
        </Badge>
      )}
    </span>
  );
}

/**
 * The matched sentences.
 *
 * A bordered group with **no fill of its own** — the second tier inside a card
 * sits on the card's ground (`docs/apps/app-shell.md`). Giving it `bg-muted`
 * would also put `text-muted-foreground` on `bg-muted`, which measures 4.34:1
 * and fails AA.
 */
export function ActionEvidence({
  actions,
  actionCount,
  className = "",
}: {
  actions: ActionItem[];
  /** May exceed `actions.length`; the detector caps what it stores. */
  actionCount: number;
  className?: string;
}) {
  if (actions.length === 0) return null;
  const notShown = actionCount - actions.length;

  return (
    <div className={`rounded-md border border-border p-4 ${className}`}>
      <ul className="space-y-2">
        {actions.map((action, i) => (
          <li key={`${action.kind}-${i}`} className="flex items-start gap-2">
            <Badge tone={KIND_TONE[action.kind]} className="mt-0.5 shrink-0">
              {KIND_LABEL[action.kind]}
            </Badge>
            <span className="min-w-0 text-sm text-foreground">
              {action.text}
              {action.hasDeadline && (
                // Inline, immediately after the sentence it qualifies. Pushed to
                // the row's far edge it reads as a property of the card rather
                // than of this line.
                <CalendarClock
                  className="ml-1.5 inline-block h-4 w-4 -translate-y-px text-destructive"
                  aria-label="Mentions a deadline"
                  role="img"
                />
              )}
            </span>
          </li>
        ))}
      </ul>
      {notShown > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {notShown} more match{notShown === 1 ? "" : "es"} not shown.
        </p>
      )}
    </div>
  );
}
