/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SyncDefinition, SyncWindow } from "@/lib/apps/types";
import type { SystemAppContext, ScopedClient } from "@/lib/hooks/types";

/**
 * Declarative incremental sync.
 *
 * `docs/apps/data-freshness.md` is 400 lines of pattern that every app
 * re-implemented and one app got catastrophically wrong: it persisted a
 * provider's pagination cursor between scheduler ticks, the provider expired it
 * before the next tick arrived, and the job failed on the same dead cursor 278
 * times over 19 days without the watermark advancing once.
 *
 * Declaring the sync instead of hand-rolling it is what makes that
 * unrepresentable. **The cursor lives inside one run's loop and is never handed
 * to the app**, so there is nowhere to persist it. The app writes two functions:
 *
 *   fetchPage(ctx, { from, to, cursor }) → { items, nextCursor }
 *   upsert(ctx, items)                   → void
 *
 * and the platform owns everything the guide spent those 400 lines on:
 *
 *   - **The wall-clock budget**, checked at every page boundary — not by item
 *     count, which cannot predict runtime when per-item cost varies.
 *   - **The watermark**, advanced only on a window that actually drained. An
 *     interrupted run costs nothing because the writes are upserts.
 *   - **Window tuning**: halved when a window does not drain, relaxed back
 *     toward the default when it does, and the current size persisted so a
 *     shrink survives the tick boundary. Relaxing matters as much as shrinking —
 *     without it one dense stretch shrinks the window permanently.
 *   - **The empty-result guard**: an upstream outage returns zero rows, not an
 *     error, and writing that through blanks every card on the page. An empty
 *     window that reaches the present is held; one that ends in the past
 *     advances, because holding it would stall the sync for good.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** State the platform keeps per sync. Apps never read or write this table. */
interface SyncState {
  name: string;
  synced_through: string | null;
  window_days: number | null;
  last_status: string | null;
  last_run_at: string | null;
}

export interface SyncPage<Item> {
  items: Item[];
  /**
   * The provider's continuation token for the NEXT page of this same window.
   *
   * It is handed straight back to the next `fetchPage` call and then discarded —
   * it never leaves the run. That is the whole design: a cursor is valid inside
   * one run and expires long before the next tick.
   */
  nextCursor?: string | null;
}

export interface SyncFetchArgs {
  /** Inclusive start of the window being pulled. */
  from: Date;
  /** Exclusive end. */
  to: Date;
  /** `undefined` on the first page of a window. */
  cursor?: string | null;
  /** Aborted when the platform gives up on the run. Pass it to every fetch. */
  signal: AbortSignal;
}

export interface SyncHandler<Item> {
  fetchPage: (
    ctx: SystemAppContext,
    args: SyncFetchArgs,
  ) => Promise<SyncPage<Item>>;
  upsert: (ctx: SystemAppContext, items: Item[]) => Promise<void>;
  /**
   * Called once after a window drains, so a sync can invalidate anything it
   * materialized — "a job that refreshes data invalidates the caches built on
   * it" is half the work, and the half that gets forgotten.
   */
  onDrained?: (ctx: SystemAppContext) => Promise<void>;
}

const BRAND = Symbol.for("mos.sync.definition");

export interface DefinedSync<Item = unknown> extends SyncHandler<Item> {
  brand: typeof BRAND;
}

export function defineSync<Item>(handler: SyncHandler<Item>): DefinedSync<Item> {
  return { brand: BRAND, ...handler };
}

export function isDefinedSync(value: unknown): value is DefinedSync {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { brand?: unknown }).brand === BRAND
  );
}

export interface SyncResult {
  name: string;
  pages: number;
  items: number;
  drained: boolean;
  from: string;
  to: string;
  windowDays: number;
  note?: string;
}

function clampWindow(days: number, window: SyncWindow): number {
  return Math.max(window.minDays, Math.min(window.defaultDays, Math.round(days)));
}

async function readState(db: ScopedClient, name: string): Promise<SyncState | null> {
  const { data } = await db
    .table("_sync_state")
    .select("*")
    .eq("name", name)
    .maybeSingle();
  return (data as SyncState | null) ?? null;
}

/**
 * Patch by column. The scoped client's upsert leaves unlisted columns as stored,
 * and a read-modify-write of the whole row loses updates the moment a second job
 * touches it.
 */
async function writeState(
  db: ScopedClient,
  name: string,
  patch: Partial<SyncState>,
): Promise<void> {
  await db
    .table("_sync_state")
    .upsert({ name, ...patch }, { onConflict: "name" });
}

/**
 * Run one tick of a declared sync.
 *
 * Returns when the window drains, the budget runs out, or the run is aborted —
 * and the watermark moves ONLY in the first case. Stopping on a deadline is a
 * normal outcome, not a failure: what finished is committed and the summary says
 * the run was truncated, so a partial tick is distinguishable from a complete
 * one.
 */
export async function runSync<Item>(
  ctx: SystemAppContext,
  definition: SyncDefinition,
  handler: SyncHandler<Item>,
): Promise<SyncResult> {
  if (!ctx.db) {
    throw new Error(
      `sync "${definition.name}" needs a scoped database — set "database": true.`,
    );
  }
  const db = ctx.db;
  const state = await readState(db, definition.name);
  const now = Date.now();

  const windowDays = state?.window_days
    ? clampWindow(state.window_days, definition.window)
    : definition.window.defaultDays;

  // A date window, never a stored cursor. A range has no server-side TTL, so it
  // resumes across ticks for free.
  const startMs = state?.synced_through
    ? Date.parse(state.synced_through)
    : now - definition.window.coldStartDays * DAY_MS;
  const from = new Date(startMs);
  const to = new Date(Math.min(startMs + windowDays * DAY_MS, now));

  const deadline = now + definition.budgetMs;
  const outOfBudget = () => ctx.signal.aborted || Date.now() >= deadline;

  let cursor: string | null | undefined = undefined;
  let pages = 0;
  let items = 0;
  let drained = false;

  do {
    // Checked at EVERY page boundary, and against both the clock and the
    // signal: `signal.aborted` alone fires only once you have already overrun,
    // and the deadline alone misses an admin-triggered abort.
    if (outOfBudget()) break;

    const page = await handler.fetchPage(ctx, {
      from,
      to,
      cursor,
      signal: ctx.signal,
    });
    pages += 1;

    if (page.items.length > 0) {
      await handler.upsert(ctx, page.items);
      items += page.items.length;
    }

    cursor = page.nextCursor ?? null;
    if (!cursor) {
      drained = true;
      break;
    }
  } while (true);
  // `cursor` goes out of scope here and is never written anywhere. That is the
  // 19-day bug, made unrepresentable.

  // An upstream outage returns zero rows rather than an error. Writing that
  // through would blank every card built on this data, so a window that drained
  // with nothing at all does not advance the watermark — the next tick re-reads
  // the range, which costs nothing because the writes are upserts.
  //
  // Only while the window reaches the present, though. Such a window grows with
  // the clock, so the next tick reads it again with more time in it, and once
  // it is a full window wide it ends in the past. A window that ends in the past
  // never changes, so holding it would re-read the same empty range on every
  // tick and the sync would never move again. That one advances.
  const reachesNow = to.getTime() >= now;
  const suspiciouslyEmpty =
    drained && items === 0 && state?.synced_through != null && reachesNow;

  let note: string | undefined;
  if (drained && !suspiciouslyEmpty) {
    // Relaxing matters as much as shrinking: without it, one dense stretch
    // shrinks the window permanently.
    const relaxed = clampWindow(windowDays * 2, definition.window);
    await writeState(db, definition.name, {
      synced_through: to.toISOString(),
      window_days: relaxed,
      last_status: "ok",
      last_run_at: new Date().toISOString(),
    });
    if (handler.onDrained) await handler.onDrained(ctx);
  } else if (suspiciouslyEmpty) {
    note = "window drained with zero items; watermark held";
    await writeState(db, definition.name, {
      last_status: "empty",
      last_run_at: new Date().toISOString(),
    });
  } else {
    // Not drained. The watermark stays put and the window shrinks, so the next
    // tick attempts less. Rows already written are simply written again, which
    // is free because the write is an upsert — and that is what makes an
    // interrupted run cost nothing.
    const shrunk = clampWindow(windowDays / 2, definition.window);
    note = "stopped on time budget";
    await writeState(db, definition.name, {
      window_days: shrunk,
      last_status: "truncated",
      last_run_at: new Date().toISOString(),
    });
  }

  return {
    name: definition.name,
    pages,
    items,
    drained: drained && !suspiciouslyEmpty,
    from: from.toISOString(),
    to: to.toISOString(),
    windowDays,
    ...(note ? { note } : {}),
  };
}
