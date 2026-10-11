/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { AppError } from "./errors";
import { capRequestBody } from "./request-body";

const CAP = 1000;

/** A body that arrives in chunks, recording how much of it has been taken. */
function upload(bytes: Uint8Array, chunk = 64) {
  const seen = { taken: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (seen.taken >= bytes.length) return controller.close();
        controller.enqueue(bytes.subarray(seen.taken, seen.taken + chunk));
        seen.taken = Math.min(seen.taken + chunk, bytes.length);
      },
      cancel() {
        seen.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, seen };
}

function post(
  body: ReadableStream<Uint8Array>,
  { headers = {}, signal }: { headers?: Record<string, string>; signal?: AbortSignal } = {},
) {
  return new Request("http://mixos.test/api/apps/acme/upload?kind=photo", {
    method: "POST",
    body,
    headers,
    signal,
    duplex: "half",
  } as RequestInit);
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const isTooLarge = (err: unknown) =>
  err instanceof AppError && err.code === "INVALID_INPUT" && err.message === "Request body too large";

/** Let the background drain run until `done()`, or give up. */
async function until(done: () => boolean) {
  for (let i = 0; i < 1000 && !done(); i++) await new Promise((r) => setImmediate(r));
}

test("a body up to the cap arrives whole, with or without a declared length", async () => {
  for (const size of [0, 1, CAP - 1, CAP]) {
    for (const declared of [true, false]) {
      const bytes = randomBytes(size);
      const headers: Record<string, string> = declared ? { "content-length": String(size) } : {};
      const capped = capRequestBody(post(upload(bytes).stream, { headers }), CAP);
      const got = new Uint8Array(await capped.request.arrayBuffer());
      const label = `${size} bytes, ${declared ? "declared" : "chunked"}`;
      assert.equal(got.byteLength, size, label);
      assert.equal(sha(got), sha(bytes), label);
      assert.equal(capped.exceeded(), false, label);
    }
  }
});

test("past the cap the read fails, the gateway is told, and the rest is drained, not cancelled", async () => {
  const bytes = randomBytes(CAP * 5);
  const { stream, seen } = upload(bytes, 100);
  const capped = capRequestBody(post(stream), CAP);

  await assert.rejects(capped.request.arrayBuffer(), isTooLarge);
  assert.equal(capped.exceeded(), true);

  // Cancelling would end the connection before the 413 is written. The rest
  // is read and dropped instead.
  await until(() => seen.taken === bytes.length);
  assert.equal(seen.taken, bytes.length);
  assert.equal(seen.cancelled, false);
});

test("one byte over the cap is over it", async () => {
  const capped = capRequestBody(post(upload(randomBytes(CAP + 1)).stream), CAP);
  await assert.rejects(capped.request.text(), isTooLarge);
  assert.equal(capped.exceeded(), true);
});

test("nothing is read until the route reads", async () => {
  const { stream, seen } = upload(randomBytes(500));
  const capped = capRequestBody(post(stream), CAP);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(seen.taken, 0);
  assert.equal(capped.exceeded(), false);
});

test("a body that ends short of its declared length is refused, not handed on", async () => {
  // What Next does to a request its proxy ran for: the copy stops at its limit
  // and ends as if the body were complete.
  const capped = capRequestBody(
    post(upload(randomBytes(500)).stream, { headers: { "content-length": "800" } }),
    CAP,
  );
  await assert.rejects(
    capped.request.arrayBuffer(),
    (err: unknown) =>
      err instanceof AppError &&
      err.code === "INVALID_INPUT" &&
      err.message === "Request body ended before its declared length",
  );
  assert.equal(capped.exceeded(), false);
});

test("it is otherwise the same request", async () => {
  const caller = new AbortController();
  const original = post(upload(randomBytes(10)).stream, {
    headers: { "content-type": "application/octet-stream", "x-csrf-token": "t", cookie: "a=b" },
    signal: caller.signal,
  });
  const { request } = capRequestBody(original, CAP);

  assert.equal(request.method, "POST");
  assert.equal(request.url, "http://mixos.test/api/apps/acme/upload?kind=photo");
  assert.equal(request.headers.get("content-type"), "application/octet-stream");
  assert.equal(request.headers.get("x-csrf-token"), "t");
  assert.equal(request.headers.get("cookie"), "a=b");

  // The route's `ctx.signal` follows this one, so a caller hanging up still
  // reaches the handler.
  assert.equal(request.signal.aborted, false);
  caller.abort();
  assert.equal(request.signal.aborted, true);
});

test("a request Next has wrapped in a Proxy is read through it", async () => {
  // What a route handler is handed (proxyNextRequest in Next's app-route
  // module): every read goes to the real request, but the Request constructor
  // can't read the private state of a Proxy, so the copy is built from parts.
  const bytes = randomBytes(CAP);
  const real = post(upload(bytes).stream, { headers: { "content-type": "application/octet-stream" } });
  const wrapped = new Proxy(real, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  assert.throws(() => new Request(wrapped), TypeError);

  const capped = capRequestBody(wrapped, CAP);
  assert.equal(capped.request.headers.get("content-type"), "application/octet-stream");
  assert.equal(sha(new Uint8Array(await capped.request.arrayBuffer())), sha(bytes));
});

test("a request with no body is passed through as it is", () => {
  const original = new Request("http://mixos.test/api/apps/acme/items");
  const capped = capRequestBody(original, CAP);
  assert.equal(capped.request, original);
  assert.equal(capped.exceeded(), false);
});
