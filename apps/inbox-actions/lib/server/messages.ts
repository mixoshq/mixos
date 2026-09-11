/**
 * The read layer over `messages` — the one place a stored row becomes a domain
 * object, and the one builder both routes share.
 *
 * Nothing here calls Gmail. Hydrating a page of messages costs one
 * `messages.get` per message, which is not a price a page load can pay, so the
 * connector is reached only from `sync/messages.ts` and every read is served
 * from our own table (docs/apps/data-freshness.md).
 *
 * The shapes live in `lib/shared/messages.ts` so the page and the widgets can
 * import them without reaching into this tier, which is a lint error.
 */

import type { ScopedClient } from "@/lib/apps/scoped-db";
import type { ActionItem, ActionKind } from "../shared/detect";
import {
  RETENTION_DAYS,
  type InboxMessage,
  type InboxSummary,
  type MessageFilter,
} from "../shared/messages";

const VALID_KINDS: ReadonlySet<string> = new Set([
  "assignment",
  "request",
  "question",
]);

/**
 * Read `actions` back out of JSONB.
 *
 * Validated rather than cast: the column is the only schema that data will ever
 * have, and a row written by an older detector must degrade to "no evidence"
 * instead of reaching the route's output schema as the wrong shape.
 */
function parseActions(value: unknown): ActionItem[] {
  if (!Array.isArray(value)) return [];
  const out: ActionItem[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { kind, text, hasDeadline } = entry as Record<string, unknown>;
    if (typeof kind !== "string" || !VALID_KINDS.has(kind)) continue;
    if (typeof text !== "string" || !text) continue;
    out.push({ kind: kind as ActionKind, text, hasDeadline: hasDeadline === true });
  }
  return out;
}

/**
 * `count` comes back from the driver as a `numeric`-ish value and
 * `internal_date` as whatever the column holds. Coerce at this boundary and
 * nowhere else — `Number("")` is 0 and `Number.isFinite("17")` is false, which
 * is how a perfectly good value ends up rendering blank
 * (docs/apps/database.md).
 */
function toInt(value: unknown): number {
  if (value == null || value === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function toIso(value: unknown): string | null {
  if (!value) return null;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toMessage(row: Record<string, unknown>): InboxMessage {
  return {
    id: String(row.id),
    threadId: String(row.thread_id ?? ""),
    receivedAt: toIso(row.internal_date),
    fromName: (row.from_name as string | null) ?? null,
    fromEmail: (row.from_email as string | null) ?? null,
    subject: (row.subject as string | null) ?? null,
    snippet: (row.snippet as string | null) ?? "",
    isUnread: row.is_unread === true,
    hasAttachments: row.has_attachments === true,
    actionCount: toInt(row.action_count),
    actions: parseActions(row.actions),
    hasDeadline: row.has_deadline === true,
  };
}

/**
 * The latest messages, newest first.
 *
 * `nulls last` on the index and `nullsFirst: false` here agree: a message whose
 * `internalDate` Gmail omitted sorts to the bottom rather than claiming to be
 * the oldest mail in the mailbox.
 */
export async function readMessages(
  db: ScopedClient,
  opts: { limit: number; filter: MessageFilter },
): Promise<InboxMessage[]> {
  let query = db
    .table("messages")
    .select(
      "id, thread_id, internal_date, from_name, from_email, subject, snippet, is_unread, has_attachments, action_count, actions, has_deadline",
    );

  if (opts.filter === "needs-action") query = query.gt("action_count", 0);
  if (opts.filter === "clear") query = query.eq("action_count", 0);

  const { data, error } = await query
    .order("internal_date", { ascending: false, nullsFirst: false })
    .limit(opts.limit);

  if (error) throw new Error(`Failed to read messages: ${error.message}`);
  return (data ?? []).map((row) => toMessage(row as Record<string, unknown>));
}

/**
 * Does the table hold anything at all, ignoring filters?
 *
 * Used only to disambiguate an empty *filtered* result from an empty *app*. A
 * `head: true` count reads no rows.
 */
export async function countAllMessages(db: ScopedClient): Promise<number> {
  const { count, error } = await db
    .table("messages")
    .select("id", { count: "exact", head: true });
  if (error) throw new Error(`Failed to count messages: ${error.message}`);
  return toInt(count);
}

/**
 * Counts over the retained window.
 *
 * Three `head: true` counts rather than one fetch-and-tally: the summary backs a
 * stat widget, and pulling every row's body to count them is exactly the
 * "fetch only what you render" mistake the widget guide warns about.
 */
export async function readSummary(db: ScopedClient): Promise<InboxSummary> {
  const [all, actionable, deadlines, latest] = await Promise.all([
    db.table("messages").select("id", { count: "exact", head: true }),
    db
      .table("messages")
      .select("id", { count: "exact", head: true })
      .gt("action_count", 0),
    db
      .table("messages")
      .select("id", { count: "exact", head: true })
      .eq("has_deadline", true),
    db
      .table("messages")
      .select("synced_at")
      .order("synced_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const firstError = all.error ?? actionable.error ?? deadlines.error;
  if (firstError) throw new Error(`Failed to count messages: ${firstError.message}`);

  return {
    total: toInt(all.count),
    needingAction: toInt(actionable.count),
    withDeadline: toInt(deadlines.count),
    syncedAt: toIso((latest.data as { synced_at?: unknown } | null)?.synced_at),
  };
}

// -- Writes (the sync's persistence half) -----------------------------------

/**
 * Upsert a page of rows.
 *
 * There is no multi-row upsert on the scoped client, so this is one statement
 * per row. At a page of 25 that is a rounding error next to the ~26 Gmail calls
 * that produced them. The write is idempotent by `id`, which is what makes an
 * interrupted run free: the platform leaves the watermark alone and the same
 * rows are simply written again next tick.
 */
export async function upsertMessages(
  db: ScopedClient,
  rows: { id: string }[],
): Promise<void> {
  for (const row of rows) {
    await db.table("messages").upsert(row, { onConflict: "id" });
  }
}

/**
 * Drop mail past the retention horizon.
 *
 * A retention prune, NOT a cache replace, and the bound is what makes it safe:
 * it deletes only rows older than `RETENTION_DAYS`, which is strictly outside
 * any window this sync pulls, so it can never erase rows a run just wrote. An
 * unbounded `delete()` here is the mistake that lets a shallow sync wipe a deep
 * backfill (docs/apps/data-freshness.md).
 */
export async function pruneExpiredMessages(db: ScopedClient): Promise<void> {
  const cutoff = new Date(
    Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { error } = await db.table("messages").delete().lt("internal_date", cutoff);
  if (error) throw new Error(`Failed to prune messages: ${error.message}`);
}
