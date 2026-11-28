/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runSync, type SyncFetchArgs, type SyncHandler } from "./sync";
import type { SyncDefinition } from "./types";
import type { ScopedClient, SystemAppContext } from "../hooks/types";

// ── fixtures ────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

const definition: SyncDefinition = {
  name: "calls",
  schedule: { everyMinutes: 60 },
  source: "mixos",
  window: { coldStartDays: 30, defaultDays: 7, minDays: 1 },
  budgetMs: 10_000,
};

type Row = Record<string, unknown>;

/**
 * Just enough of the scoped client for the two calls runSync makes against its
 * state table: one read by name, and a patch that keeps unlisted columns. It is
 * the platform's handle the scheduler passes in, not the app's `ctx.db`, which
 * throws here if runSync reaches for it.
 */
function stateTable(initial: Row | null) {
  let row = initial;
  const state = {
    table(name: string) {
      assert.equal(name, "_sync_state");
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: row && { ...row }, error: null }),
          }),
        }),
        upsert: async (patch: Row) => {
          row = { ...row, ...patch };
          return { data: null, error: null };
        },
      };
    },
  };
  const appDb = {
    table() {
      throw new Error("runSync used the app's ctx.db for its state");
    },
  };
  const ctx = {
    db: appDb,
    signal: new AbortController().signal,
  } as unknown as SystemAppContext;
  return { ctx, state: state as unknown as ScopedClient, row: () => row };
}

/** A source with nothing in it, recording the windows it was asked for. */
function emptySource() {
  const asked: SyncFetchArgs[] = [];
  const handler: SyncHandler<never> = {
    fetchPage: async (_ctx, args) => {
      asked.push(args);
      return { items: [] };
    },
    upsert: async () => {},
  };
  return { asked, handler };
}

const iso = (ms: number) => new Date(ms).toISOString();

// ── the empty guard ─────────────────────────────────────────────────────────

test("an empty window that ends in the past advances the watermark", async () => {
  const start = Date.now() - 30 * DAY_MS;
  const { ctx, state, row } = stateTable({ name: "calls", synced_through: iso(start), window_days: 7 });
  const { asked, handler } = emptySource();

  const result = await runSync(ctx, definition, handler, state);

  assert.equal(asked[0].from.getTime(), start);
  assert.equal(asked[0].to.getTime(), start + 7 * DAY_MS);
  assert.equal(result.drained, true);
  assert.equal(result.note, undefined);
  assert.equal(row()?.synced_through, iso(start + 7 * DAY_MS));
  assert.equal(row()?.last_status, "ok");
});

test("an empty stretch is crossed one window per tick, then held at the present", async () => {
  const start = Date.now() - 20 * DAY_MS;
  const { ctx, state, row } = stateTable({ name: "calls", synced_through: iso(start), window_days: 7 });
  const { asked, handler } = emptySource();

  await runSync(ctx, definition, handler, state);
  await runSync(ctx, definition, handler, state);
  assert.equal(row()?.synced_through, iso(start + 14 * DAY_MS));

  // Six days left: this window reaches now, so an empty answer is held.
  const held = await runSync(ctx, definition, handler, state);
  assert.deepEqual(
    asked.map((a) => a.from.getTime()),
    [start, start + 7 * DAY_MS, start + 14 * DAY_MS],
  );
  assert.equal(held.drained, false);
  assert.equal(row()?.synced_through, iso(start + 14 * DAY_MS));
  assert.equal(row()?.last_status, "empty");
});

test("an empty window that reaches the present holds the watermark", async () => {
  const start = Date.now() - DAY_MS;
  const { ctx, state, row } = stateTable({ name: "calls", synced_through: iso(start), window_days: 7 });
  const { handler } = emptySource();

  const result = await runSync(ctx, definition, handler, state);

  assert.equal(result.drained, false);
  assert.equal(result.note, "window drained with zero items; watermark held");
  assert.equal(row()?.synced_through, iso(start));
  assert.equal(row()?.last_status, "empty");
});

test("a window with items advances, including one that reaches the present", async () => {
  const start = Date.now() - DAY_MS;
  const { ctx, state, row } = stateTable({ name: "calls", synced_through: iso(start), window_days: 7 });
  const written: number[][] = [];
  const handler: SyncHandler<number> = {
    fetchPage: async () => ({ items: [1, 2] }),
    upsert: async (_ctx, items) => {
      written.push(items);
    },
  };

  const result = await runSync(ctx, definition, handler, state);

  assert.deepEqual(written, [[1, 2]]);
  assert.equal(result.drained, true);
  assert.equal(row()?.synced_through, result.to);
  assert.ok(Date.parse(result.to) > start);
});
