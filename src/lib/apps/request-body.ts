/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The app gateway's body cap, held on the body itself.
 *
 * A declared `content-length` over the cap is refused before anything reads
 * the body (step 1 in ./dispatch.ts). A body sent in chunks has no length to
 * check, so it is counted as it is read instead: the route gets the same
 * request with a body that fails once more than the cap has arrived, and the
 * gateway answers 413 whatever the route made of the failed read.
 *
 * Three details carry the weight:
 *
 *   - Nothing is read until the route reads. A route that never touches its
 *     body leaves the request untouched, and Node discards the body after the
 *     response, as it does for any route.
 *   - Past the cap, the rest of the body is read and dropped, not cancelled.
 *     Cancelling a request body in Next destroys the connection, and the 413
 *     with it, so the caller would see a reset instead of the answer.
 *   - A body that ends cleanly short of its declared `content-length` is
 *     refused rather than handed on. Node fails a body the client stops sending,
 *     so a clean short ending means something in between cut it, as Next does
 *     to a request its proxy runs for (src/proxy.ts, `config.matcher`).
 */

import { NextRequest } from "next/server";
import { AppError } from "./errors";

export interface CappedRequest {
  /** The same request, with a body that fails past `maxBytes`. */
  request: Request;
  /** Whether more than `maxBytes` arrived. */
  exceeded(): boolean;
}

export function capRequestBody(request: Request, maxBytes: number): CappedRequest {
  const source = request.body;
  if (!source) return { request, exceeded: () => false };

  const declared = Number(request.headers.get("content-length") ?? Number.NaN);
  const reader = source.getReader();
  let received = 0;
  let exceeded = false;

  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          if (Number.isFinite(declared) && received < declared) {
            controller.error(
              AppError.invalidInput("Request body ended before its declared length"),
            );
          } else {
            controller.close();
          }
          return;
        }
        received += value.byteLength;
        if (received > maxBytes) {
          exceeded = true;
          controller.error(AppError.invalidInput("Request body too large"));
          void drain(reader);
          return;
        }
        controller.enqueue(value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    },
    // Pull nothing ahead of the reader. The default would read one chunk as
    // soon as the stream exists, which marks the request as being read and
    // stops Node discarding it for a route that never asks for it.
    { highWaterMark: 0 },
  );

  return {
    // From its parts, not `new Request(request)`: Next hands a route handler its
    // request inside a Proxy, and the Request constructor can't read one.
    request: new NextRequest(request.url, {
      method: request.method,
      headers: request.headers,
      signal: request.signal,
      body,
      duplex: "half",
    }),
    exceeded: () => exceeded,
  };
}

/** Read the rest of the body and drop it, so the connection lives to carry the 413. */
async function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    while (!(await reader.read()).done) {
      // Dropped.
    }
  } catch {
    // The caller went away. Nothing is waiting for the rest.
  }
}
