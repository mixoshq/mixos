/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { deleteUserSubscription, saveSubscription } from "./subscriptions";

// ── fixtures ────────────────────────────────────────────────────────────────

interface Call {
  text: string;
  params: unknown[];
}

const calls: Call[] = [];

// The pool is a lazy proxy that reads `globalThis.__pg` on first use
// (src/lib/db/client.ts). A recorder there sees every statement the query
// builder sends, with no database.
(globalThis as { __pg?: unknown }).__pg = {
  async unsafe(text: string, params: unknown[] = []) {
    calls.push({ text, params });
    return [];
  },
};

beforeEach(() => {
  calls.length = 0;
});

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bHPRgkF3JUikC4ENAH";

// ── tests ───────────────────────────────────────────────────────────────────

test("unsubscribing deletes the row only when it is the signed-in user's", async () => {
  await deleteUserSubscription("user-a", ENDPOINT);

  assert.equal(calls.length, 1);
  assert.match(
    calls[0].text,
    /^delete from "public"\."push_subscriptions" as _t where _t\."user_id" = .* and _t\."endpoint" = /,
  );
  assert.deepEqual(calls[0].params, [{ user_id: "user-a" }, { endpoint: ENDPOINT }]);
});

test("a subscription pointing anywhere but a push service is never stored", async () => {
  await assert.rejects(
    saveSubscription(
      "user-a",
      { endpoint: "https://169.254.169.254/latest/meta-data/", keys: { p256dh: "p", auth: "a" } },
      null,
    ),
    /not a push service endpoint/,
  );
  assert.equal(calls.length, 0);

  await saveSubscription("user-a", { endpoint: ENDPOINT, keys: { p256dh: "p", auth: "a" } }, null);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /^insert into "public"\."push_subscriptions"/);
});
