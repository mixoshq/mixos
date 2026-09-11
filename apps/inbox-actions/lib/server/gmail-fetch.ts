/**
 * The only module in this app that touches Gmail.
 *
 * It lives in `lib/server/` rather than beside the sync because that is the
 * tier eslint allowlists for connector imports — "the server-only data builders
 * [routes and jobs] delegate to". `apps/**\/sync/**` is not on that list today,
 * even though a declared sync is server-only by construction and is invoked with
 * the same user-less `SystemAppContext` a job gets. Delegating here is the
 * documented shape and needs no platform change.
 */

import type { SystemAppContext } from "@/lib/hooks/types";
import type GmailConnector from "@connectors/gmail";
import type { GmailMessage } from "@connectors/gmail";
import {
  DETECTOR_VERSION,
  detectActionItems,
  htmlToText,
  parseFrom,
  stripQuoted,
} from "../shared/detect";

/**
 * Messages listed per page. Each one then costs a `messages.get` to hydrate, so
 * a page is ~26 Gmail calls. Kept at the connector's own `MAX_HYDRATE` so a page
 * is a familiar unit of cost on both sides.
 */
const PAGE_SIZE = 25;

/** How much of the body to keep as the row's preview line. */
const PREVIEW_CHARS = 200;

/** Gmail's `after:`/`before:` take epoch **seconds** when given a bare number. */
const epochSeconds = (d: Date): number => Math.floor(d.getTime() / 1000);

/** One row, shaped and detected, ready for the table. */
export interface MessageRow {
  id: string;
  thread_id: string;
  internal_date: string | null;
  from_name: string | null;
  from_email: string | null;
  subject: string | null;
  snippet: string;
  is_unread: boolean;
  has_attachments: boolean;
  action_count: number;
  actions: unknown;
  has_deadline: boolean;
  detector_version: number;
  synced_at: string;
}

/**
 * Shape one Gmail message into a row, running the detector as it goes.
 *
 * Detection happens here rather than in a second enrichment phase because it is
 * pure local text work costing microseconds per message: there is no API call to
 * budget and no cadence to separate, so a second schedule would buy nothing and
 * add a coordination problem.
 */
/**
 * The preview line shown for a message with no detected actions.
 *
 * Built from the SAME unquoted text the detector read, not from Gmail's own
 * snippet. Gmail's snippet includes quoted history, so a "Thanks, done!" reply
 * on a thread full of requests previews as "> Could you review the draft?"
 * directly beside the words "No action items" — which reads as the detector
 * having missed something obvious, when in fact it was right to ignore a quote.
 * Aligning the preview with what was actually scanned keeps the two consistent.
 */
function previewOf(message: GmailMessage): string {
  const raw =
    message.text?.trim() || (message.html ? htmlToText(message.html).trim() : "");
  const cleaned = raw ? stripQuoted(raw).replace(/\s+/g, " ").trim() : "";
  // Fall back to Gmail's snippet when the message is quote-only or body-less —
  // a noisy preview still beats a blank one.
  const source = cleaned || message.snippet || "";
  return source.length > PREVIEW_CHARS
    ? `${source.slice(0, PREVIEW_CHARS).trimEnd()}\u2026`
    : source;
}

export function toRow(message: GmailMessage): MessageRow {
  const { name, email } = parseFrom(message.from);
  const detection = detectActionItems({
    text: message.text,
    html: message.html,
    snippet: previewOf(message),
  });

  // `internalDate` is epoch milliseconds as a string, exactly as Gmail sends it.
  const receivedMs = message.internalDate ? Number(message.internalDate) : NaN;

  return {
    id: message.id,
    thread_id: message.threadId,
    internal_date: Number.isFinite(receivedMs)
      ? new Date(receivedMs).toISOString()
      : null,
    from_name: name,
    from_email: email,
    subject: message.subject,
    snippet: previewOf(message),
    is_unread: message.labelIds.includes("UNREAD"),
    has_attachments: message.attachments.length > 0,
    action_count: detection.actionCount,
    actions: detection.actions,
    has_deadline: detection.hasDeadline,
    detector_version: DETECTOR_VERSION,
    synced_at: new Date().toISOString(),
  };
}

/**
 * One page of the window the platform asked for.
 *
 * `cursor` is the platform handing back the token from the previous page of THIS
 * run — it is discarded when the run ends and has nowhere to be persisted, which
 * is the property that makes an expired-cursor stall unrepresentable.
 */
export async function fetchMessagePage(
  ctx: SystemAppContext,
  args: { from: Date; to: Date; cursor?: string | null; signal: AbortSignal },
): Promise<{ items: MessageRow[]; nextCursor: string | null }> {
  const gmail = ctx.connectors.gmail as unknown as GmailConnector | undefined;

  // Every connector is tenant-scoped: `configured: false` means an admin has not
  // finished connecting the shared mailbox.
  //
  // THROW, do not return empty. Returning `{ items: [] }` would read to the
  // platform as "this window drained and genuinely had no mail", and the empty
  // guard in `runSync` is deliberately skipped on the very first tick (it keys on
  // `synced_through != null`, so a real cold start can advance rather than
  // wedging). The result is that one window of mail gets silently marked synced
  // on an install where Gmail was never authorized, and is never fetched again.
  //
  // Throwing writes no state at all — the watermark is untouched — and surfaces
  // an `error` on Administration → Scheduled Jobs naming the thing an admin has
  // to do. This app has exactly one data source, so "Gmail is not connected" is
  // not noise; it is the whole status of the app.
  if (!gmail?.configured) {
    throw new Error(
      "Gmail is not connected. An admin must finish the OAuth flow for the shared mailbox in Administration → Connectors.",
    );
  }

  const q = [
    `after:${epochSeconds(args.from)}`,
    `before:${epochSeconds(args.to)}`,
    // Hangouts/Chat records are not mail and have no body to scan.
    "-in:chats",
  ].join(" ");

  const page = await gmail.listMessages({
    q,
    limit: PAGE_SIZE,
    pageToken: args.cursor ?? undefined,
  });

  const items: MessageRow[] = [];
  for (const ref of page.messages) {
    // The connector's methods take no AbortSignal, so the budget is honoured
    // BETWEEN hydrations rather than inside one. Each `getMessage` is bounded by
    // the connector's own 20s deadline, so the worst-case overshoot past the
    // platform's budget is one message, not a whole page.
    if (args.signal.aborted) break;

    const message = await gmail.getMessage(ref.id, { format: "full" });
    if (message) items.push(toRow(message));
  }

  return { items, nextCursor: page.nextPageToken };
}
