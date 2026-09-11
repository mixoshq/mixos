/**
 * Pull the mailbox forward, one date window at a time, detecting the action
 * items in each message as it lands.
 *
 * This is a DECLARED sync (`app.json` → `sync[]`), not a hand-rolled job, per
 * `apps/AGENTS.md` invariant 26. The platform owns the watermark, the wall-clock
 * budget checked at every page boundary, window halving and relaxing, and the
 * empty-result guard — and it owns the pagination cursor, which never leaves the
 * run. There is nowhere here to persist one, which is what makes the
 * expired-cursor outage unrepresentable rather than merely warned about.
 *
 * Everything with a dependency — the connector, the detector, the tables — lives
 * in `lib/server/`, so this file is the wiring and nothing else.
 */

import { defineSync } from "@/lib/apps/sync";
import { fetchMessagePage, type MessageRow } from "../lib/server/gmail-fetch";
import { pruneExpiredMessages, upsertMessages } from "../lib/server/messages";

export default defineSync<MessageRow>({
  fetchPage: async (ctx, { from, to, cursor, signal }) =>
    fetchMessagePage(ctx, { from, to, cursor, signal }),

  upsert: async (ctx, rows) => {
    if (!ctx.db) throw new Error("inbox-actions requires a scoped database.");
    await upsertMessages(ctx.db, rows);
  },

  onDrained: async (ctx) => {
    if (!ctx.db) return;
    await pruneExpiredMessages(ctx.db);
  },
});
