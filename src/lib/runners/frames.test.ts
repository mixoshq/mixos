/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The runner protocol's frames (runner/frames.mjs). */

import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFrame, FrameError, FrameReader, MAX_FRAME_BYTES } from "../../../runner/frames.mjs";

function roundTrip(message: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  new FrameReader((m) => out.push(m)).push(encodeFrame(message));
  return out;
}

test("a message survives the trip, with the values JSON would lose", () => {
  const when = new Date("2026-11-28T10:00:00.000Z");
  const [back] = roundTrip({
    t: "done",
    value: { when, bytes: new Uint8Array([0, 1, 255]), big: BigInt("12345678901234567890"), list: [when], none: null },
  });
  const value = back!.value as Record<string, unknown>;
  assert.ok(value.when instanceof Date);
  assert.equal((value.when as Date).toISOString(), when.toISOString());
  assert.deepEqual(value.bytes, new Uint8Array([0, 1, 255]));
  assert.equal(value.big, BigInt("12345678901234567890"));
  assert.ok((value.list as unknown[])[0] instanceof Date);
  assert.equal(value.none, null);
});

test("an error crosses as its name, message and named fields, never its stack", () => {
  const err = Object.assign(new Error("Rate limited"), {
    name: "ConnectorError",
    category: "rate-limited",
    retryAfter: 30,
    userMessage: "Try again shortly",
    internal: { password: "hunter2" },
  });
  const [back] = roundTrip({ t: "done", error: err });
  const e = back!.error as Error & Record<string, unknown>;
  assert.ok(e instanceof Error);
  assert.equal(e.name, "ConnectorError");
  assert.equal(e.message, "Rate limited");
  assert.equal(e.category, "rate-limited");
  assert.equal(e.retryAfter, 30);
  assert.equal(e.userMessage, "Try again shortly");
  assert.equal(e.internal, undefined);
  const wire = encodeFrame({ error: err }).toString("utf8");
  assert.doesNotMatch(wire, /stack|hunter2|frames\.test/);
});

test("frames split across chunks, or several in one chunk, come out whole and in order", () => {
  const out: unknown[] = [];
  const reader = new FrameReader((m) => out.push(m.n));
  const bytes = Buffer.concat([1, 2, 3].map((n) => encodeFrame({ n })));
  for (let i = 0; i < bytes.length; i += 3) reader.push(bytes.subarray(i, i + 3));
  assert.deepEqual(out, [1, 2, 3]);
});

test("a frame claiming to be over the limit is refused before it is read", () => {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
  assert.throws(() => new FrameReader(() => {}).push(head), FrameError);
});

test("a frame that isn't a JSON object is refused", () => {
  const frame = (body: string) => {
    const b = Buffer.from(body);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(b.length, 0);
    return Buffer.concat([head, b]);
  };
  assert.throws(() => new FrameReader(() => {}).push(frame("{nope")), FrameError);
  assert.throws(() => new FrameReader(() => {}).push(frame("[1,2]")), FrameError);
  assert.throws(() => new FrameReader(() => {}).push(frame("null")), FrameError);
});

test("a message too large to frame throws as it is encoded", () => {
  assert.throws(() => encodeFrame({ v: "x".repeat(MAX_FRAME_BYTES) }), FrameError);
});

test("a tag that doesn't fit its shape is left as data", () => {
  const [back] = roundTrip({ v: { $mixos: "date", v: 5 }, w: { $mixos: "bigint", v: "1e9" }, x: { $mixos: "other", v: 1 } });
  assert.deepEqual(back!.v, { $mixos: "date", v: 5 });
  assert.deepEqual(back!.w, { $mixos: "bigint", v: "1e9" });
  assert.deepEqual(back!.x, { $mixos: "other", v: 1 });
});
