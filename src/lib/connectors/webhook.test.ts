/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { ConnectorWebhookPolicy } from "./types";
import { pruneWebhookEvents, verifyWebhookSignature } from "./webhook";

// ── fixtures ────────────────────────────────────────────────────────────────

const SECRET = "whsec_test";
const BODY = JSON.stringify({ event: "thing.created", id: 7 });
const NOW = 1_760_000_000_000;

const POLICY: ConnectorWebhookPolicy = {
  algorithm: "hmac-sha256",
  signatureHeader: "x-signature",
  secretKey: "hookSecret",
};
const TIMED: ConnectorWebhookPolicy = { ...POLICY, timestampHeader: "x-timestamp" };

const mac = (payload: string) => createHmac("sha256", SECRET).update(payload, "utf8").digest();

/** The replay key a delivery claims, asserting that it verified. */
function claimKey(
  headers: Record<string, string>,
  policy: ConnectorWebhookPolicy = POLICY,
  body = BODY,
): string {
  const verified = verifyWebhookSignature({
    policy,
    secret: SECRET,
    rawBody: body,
    headers: new Headers(headers),
    now: NOW,
  });
  assert.ok(verified.ok, JSON.stringify(headers));
  return verified.eventKey;
}

// ── the replay key ──────────────────────────────────────────────────────────

test("every accepted spelling of one signature claims the same delivery", () => {
  const digest = mac(BODY);
  const spellings = [
    digest.toString("hex"),
    digest.toString("base64"),
    `sha256=${digest.toString("hex")}`,
    `sha256=${digest.toString("base64")}`,
    `x=${digest.toString("hex")}`,
    `v1=${digest.toString("base64")}`,
  ];
  const keys = new Set(spellings.map((s) => claimKey({ "x-signature": s })));
  assert.equal(keys.size, 1, "a re-spelled signature must not be a new delivery");
});

test("a different body, or a different signed timestamp, is a different delivery", () => {
  const other = JSON.stringify({ event: "thing.created", id: 8 });
  assert.notEqual(
    claimKey({ "x-signature": mac(BODY).toString("hex") }),
    claimKey({ "x-signature": mac(other).toString("hex") }, POLICY, other),
  );

  const at = (sec: number) =>
    claimKey(
      { "x-timestamp": String(sec), "x-signature": mac(`${sec}.${BODY}`).toString("hex") },
      TIMED,
    );
  const sec = NOW / 1000;
  assert.equal(at(sec), at(sec));
  assert.notEqual(at(sec), at(sec - 30));
});

// ── the sweep ───────────────────────────────────────────────────────────────

test("a timestamped policy's markers go after a day, every other marker after 90", async () => {
  const statements: { text: string; values: unknown[] }[] = [];
  // Stands in for the pool behind the lazy `sql` proxy (src/lib/db/client.ts):
  // a tagged-template call is a statement, a plain call an IN-list fragment.
  (globalThis as { __pg?: unknown }).__pg = (first: unknown, ...rest: unknown[]) => {
    if (Array.isArray(first) && "raw" in first) {
      statements.push({ text: first.join("?"), values: rest });
      return Promise.resolve([{ event_key: "a" }, { event_key: "b" }]);
    }
    return { inList: first };
  };

  // With no timestamped policy, only the 90-day sweep runs — over everything.
  assert.equal(await pruneWebhookEvents([]), 2);
  assert.equal(statements.length, 1);
  assert.match(statements[0].text, /where received_at < now\(\) - \? \* interval '1 day'\s+returning/);
  assert.deepEqual(statements[0].values, [90]);

  // With some, their markers also go after one day.
  statements.length = 0;
  assert.equal(await pruneWebhookEvents(["timed-a", "timed-b"]), 4);
  assert.equal(statements.length, 2);
  assert.deepEqual(statements[0].values, [90]);
  assert.match(
    statements[1].text,
    /where received_at < now\(\) - \? \* interval '1 day'\s+and connector_name in \?/,
  );
  assert.deepEqual(statements[1].values, [1, { inList: ["timed-a", "timed-b"] }]);
});
