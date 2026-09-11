/**
 * The wire shapes the routes return, plus the display helpers the page and the
 * widgets share.
 *
 * Client-safe by construction: this module imports nothing but types from
 * `detect.ts`, which itself imports nothing. That is what lets a widget and the
 * server read layer agree on a shape without a widget reaching for
 * `lib/server/**`, which is a lint error precisely because it would skip the
 * gateway.
 */

import type { ActionItem, ActionKind } from "./detect";

export type { ActionItem, ActionKind };

/** How much mail the table keeps. Also the period the summary describes. */
export const RETENTION_DAYS = 30;

/** Which slice of the mailbox the caller wants. */
export type MessageFilter = "all" | "needs-action" | "clear";

export interface InboxMessage {
  id: string;
  threadId: string;
  /** ISO 8601, or null when Gmail omitted `internalDate`. */
  receivedAt: string | null;
  fromName: string | null;
  fromEmail: string | null;
  subject: string | null;
  snippet: string;
  isUnread: boolean;
  hasAttachments: boolean;
  /** Every match found — may exceed `actions.length`, which is capped. */
  actionCount: number;
  /** The sentences that matched. The evidence behind `actionCount`. */
  actions: ActionItem[];
  hasDeadline: boolean;
}

export interface InboxSummary {
  total: number;
  needingAction: number;
  withDeadline: number;
  /** When the sync last wrote a row, ISO 8601. Null when the table is cold. */
  syncedAt: string | null;
}

/** The filter control's options, in the order they read as a narrowing. */
export const FILTERS: { key: MessageFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "needs-action", label: "Needs action" },
  { key: "clear", label: "No actions" },
];

export function isMessageFilter(value: unknown): value is MessageFilter {
  return FILTERS.some((f) => f.key === value);
}

/**
 * What each detected kind is called on screen.
 *
 * Deliberately plain nouns. The reader is being shown a sentence and told how it
 * was classified; a label like "high-confidence imperative" would be describing
 * the detector rather than the mail.
 */
export const KIND_LABEL: Record<ActionKind, string> = {
  assignment: "Assigned",
  request: "Request",
  question: "Question",
};

/**
 * A compact received-at, relative for recent mail and absolute past a week.
 *
 * "3d ago" stops being useful somewhere around the point where the reader would
 * have to count backwards to place it, so it switches to a date rather than
 * growing to "23d ago".
 */
export function formatReceived(iso: string | null): string {
  if (!iso) return "Unknown";

  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "Unknown";

  const minutes = Math.floor((Date.now() - then.getTime()) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "Jo Smith", or the address when there is no display name. */
export function senderLabel(message: InboxMessage): string {
  return message.fromName ?? message.fromEmail ?? "Unknown sender";
}
