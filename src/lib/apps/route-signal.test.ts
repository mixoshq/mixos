/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { AppError } from "./errors";
import { defineRoute, runRouteData, type ResolvedContext } from "./route";

// ── fixtures ────────────────────────────────────────────────────────────────

// Route telemetry is written through the lazy pool in src/lib/db/client.ts,
// which reads `globalThis.__pg` first. A no-op there keeps it off any database.
(globalThis as { __pg?: unknown }).__pg = Object.assign(async () => [], {
  json: (value: unknown) => value,
});

const run = {
  context: { auth: "session", user: null, connectors: {} } as unknown as ResolvedContext,
  appSlug: "acme",
  routePattern: "items",
  method: "GET",
};

const request = (signal?: AbortSignal) =>
  new Request("http://mixos.test/api/apps/acme/items", { signal });

/** Resolves once `signal` aborts. */
const aborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });

// ── ctx.signal ──────────────────────────────────────────────────────────────

test("a JSON handler's signal aborts when the route's time budget runs out", async () => {
  let seen: AbortSignal | undefined;
  const route = defineRoute({
    output: z.object({ ok: z.boolean() }),
    budget: { ms: 20 },
    handler: async (ctx) => {
      seen = ctx.signal;
      await aborted(ctx.signal);
      return { ok: true };
    },
  });

  await assert.rejects(
    runRouteData(route, request(), run),
    (err: Error) => err instanceof AppError && err.code === "TIMEOUT",
  );
  assert.equal(seen?.aborted, true);
  assert.equal((seen?.reason as AppError).code, "TIMEOUT");
});

test("a JSON handler's signal aborts when the caller goes away", async () => {
  const caller = new AbortController();
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  const route = defineRoute({
    output: z.object({ aborted: z.boolean() }),
    budget: { ms: 5_000 },
    handler: async (ctx) => {
      started();
      await aborted(ctx.signal);
      return { aborted: ctx.signal.aborted };
    },
  });

  const pending = runRouteData(route, request(caller.signal), run);
  await running;
  caller.abort();
  assert.deepEqual(await pending, { aborted: true });
});

test("a handler that finishes in time is never aborted", async () => {
  let seen: AbortSignal | undefined;
  const route = defineRoute({
    output: z.object({ ok: z.boolean() }),
    budget: { ms: 50 },
    handler: async (ctx) => {
      seen = ctx.signal;
      return { ok: true };
    },
  });

  assert.deepEqual(await runRouteData(route, request(), run), { ok: true });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(seen?.aborted, false);
});
