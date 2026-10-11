/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { ConnectorWebhookPolicy } from "./types";
import { pruneWebhookEvents, readCappedBody, verifyWebhookSignature } from "./webhook";

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

// ── the body cap ────────────────────────────────────────────────────────────

const KIB = 1024;

/** A body of `count` chunks of `size` bytes that records how many were pulled. */
function countedBody(count: number, size: number) {
  const pulled = { chunks: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled.chunks === count) return controller.close();
      pulled.chunks += 1;
      controller.enqueue(new Uint8Array(size).fill(0x61));
    },
  });
  return { pulled, stream };
}

function post(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request("https://mos.test/api/webhooks/x", {
    method: "POST",
    body,
    headers,
    duplex: "half",
  } as RequestInit);
}

test("a body with no length stops being read at the cap", async () => {
  const { pulled, stream } = countedBody(1000, 64 * KIB);
  assert.equal(await readCappedBody(post(stream), 256 * KIB), null);
  // Five chunks pass 256 KiB; the stream reads one ahead of its reader.
  assert.ok(pulled.chunks <= 6, `pulled ${pulled.chunks} of 1000 chunks`);
});

test("a declared length over the cap is refused before a byte is read", async () => {
  const { pulled, stream } = countedBody(1000, 64 * KIB);
  const declared = post(stream, { "content-length": String(64 * KIB * 1000) });
  assert.equal(await readCappedBody(declared, 256 * KIB), null);
  assert.equal(declared.bodyUsed, false);
  assert.ok(pulled.chunks <= 1, `pulled ${pulled.chunks} chunks`);
});

test("a body that understates its length is still stopped at the cap", async () => {
  const { pulled, stream } = countedBody(1000, 64 * KIB);
  const lying = post(stream, { "content-length": "10" });
  assert.equal(await readCappedBody(lying, 256 * KIB), null);
  assert.ok(pulled.chunks <= 6, `pulled ${pulled.chunks} of 1000 chunks`);
});

test("a body up to the cap is read whole; one byte more is not", async () => {
  const cap = 256 * KIB;
  assert.equal((await readCappedBody(post("a".repeat(cap)), cap))?.length, cap);
  assert.equal(await readCappedBody(post("a".repeat(cap + 1)), cap), null);
  assert.equal(await readCappedBody(post(null), cap), "");
});

test("a body under the cap reads exactly as request.text() does, so signatures still match", async () => {
  // A leading BOM, which text() drops, and characters split across chunks.
  const bytes = Buffer.from("﻿" + JSON.stringify({ name: "Zoë", note: "€ 😀" }), "utf8");
  const chunked = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.subarray(i, i + 3));
        controller.close();
      },
    });
  const text = await post(chunked()).text();
  const capped = await readCappedBody(post(chunked()), 64 * KIB);
  assert.equal(capped, text);

  const sec = String(NOW / 1000);
  const verified = verifyWebhookSignature({
    policy: TIMED,
    secret: SECRET,
    rawBody: capped!,
    headers: new Headers({
      "x-timestamp": sec,
      "x-signature": mac(`${sec}.${text}`).toString("hex"),
    }),
    now: NOW,
  });
  assert.equal(verified.ok, true);
});

