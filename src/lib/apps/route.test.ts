/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { ConnectorError } from "../connectors/errors";
import type { ConnectorErrorInit } from "../connectors/errors";
import { connectorErrorResponse } from "../connectors/response";
import { AppClientError, connectorErrorOf, createAppClient } from "./sdk";
import { defineRoute, runRoute, type RouteDefinition } from "./route";

// ── fixtures ────────────────────────────────────────────────────────────────

// Route telemetry is written through the lazy pool in src/lib/db/client.ts,
// which reads `globalThis.__pg` first. A no-op there keeps it off any database.
(globalThis as { __pg?: unknown }).__pg = Object.assign(async () => [], {
  json: (value: unknown) => value,
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A route whose connector call fails the way `init` describes. */
function failingRoute(init: Omit<ConnectorErrorInit, "connectorName">) {
  return defineRoute({
    output: z.object({ items: z.array(z.string()) }),
    handler: async () => {
      throw new ConnectorError({ connectorName: "acme", subject: "Acme", ...init });
    },
  });
}

/** Run a route as a signed-in caller, through the same pipeline the gateway uses. */
function call(route: RouteDefinition, opts: { isAdmin?: boolean } = {}) {
  return runRoute(route, new Request("https://mixos.test/api/apps/acme-app/items"), {
    context: {
      user: { id: "user-1", isAdmin: opts.isAdmin ?? false },
      connectors: {},
      auth: "session",
    } as never,
    appSlug: "acme-app",
    routePattern: "items",
    method: "GET",
  });
}

/** Silence the pipeline's own failure log for the length of `fn`. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

// ── the route pipeline ──────────────────────────────────────────────────────

test("a connector failure a handler lets propagate answers with the connector's envelope", async () => {
  const res = await quietly(() => call(failingRoute({ category: "unconfigured" })));

  // 503, not the 500 a generic throw gets: an unconfigured connector is an
  // unavailable dependency, and the widget needs the category to say so.
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.equal(body.code, "UNAVAILABLE");
  assert.equal(body.error.category, "unconfigured");
  assert.equal(body.error.connector, "Acme");
  assert.match(body.error.message, /^Acme isn't set up yet/);
  assert.equal(body.error.retryAfterMs, null);
});

test("only an admin gets the registry link, the hint and the upstream request id", async () => {
  const route = failingRoute({ category: "auth_failed", status: 401, upstreamRequestId: "req-9" });

  const user = await (await quietly(() => call(route))).json();
  for (const key of ["adminHint", "adminActionUrl", "upstreamRequestId", "status"]) {
    assert.equal(key in user.error, false, `${key} must not reach a non-admin`);
  }

  const admin = await (await quietly(() => call(route, { isAdmin: true }))).json();
  assert.equal(admin.error.adminActionUrl, "/admin/connectors?connector=acme");
  assert.equal(admin.error.upstreamRequestId, "req-9");
  assert.equal(typeof admin.error.adminHint, "string");
});

test("a throttle keeps its status and tells the caller how long to wait", async () => {
  const res = await quietly(() =>
    call(failingRoute({ category: "rate_limited", status: 429, retryAfterMs: 2_500 })),
  );
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "3");
  const body = await res.json();
  assert.equal(body.code, "RATE_LIMITED");
  assert.equal(body.error.retryAfterMs, 2_500);
});

test("anything else a handler throws is still a generic 500 with nothing forwarded", async () => {
  const route = defineRoute({
    output: z.object({ ok: z.boolean() }),
    handler: async () => {
      throw new Error("relation \"secret_table\" does not exist");
    },
  });
  const res = await quietly(() => call(route));
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.code, "HANDLER_ERROR");
  assert.doesNotMatch(JSON.stringify(body), /secret_table/);
});

// ── ctx.connectorErrorResponse, for a raw route ─────────────────────────────

type Tier = "session" | "signed-in" | "password" | "key" | "public";

/** A connector failure with every admin-only field set. */
const authFailed = () =>
  new ConnectorError({
    connectorName: "acme",
    subject: "Acme",
    category: "auth_failed",
    status: 401,
    upstreamRequestId: "req-9",
  });

/** A raw route that answers its own connector failure, after `before` has run. */
function rawRoute(before: (ctx: { user: unknown }) => void = () => {}) {
  return defineRoute({
    raw: true,
    auth: ["session", "signed-in", "password", "key", "public"],
    handler: async (ctx) => {
      before(ctx);
      return ctx.connectorErrorResponse(authFailed());
    },
  });
}

/** Run a route as a caller on `tier`, through the same pipeline the gateway uses. */
function callAs(route: RouteDefinition, tier: Tier, isAdmin = false) {
  const identity = tier === "session" || tier === "signed-in";
  return runRoute(route, new Request("https://mixos.test/api/apps/acme-app/items"), {
    context: {
      user: identity ? { id: "user-1", isAdmin } : null,
      connectors: {},
      auth: tier,
    } as never,
    appSlug: "acme-app",
    routePattern: "items",
    method: "GET",
  });
}

const ADMIN_ONLY = ["adminHint", "adminActionUrl", "upstreamRequestId", "status"];

test("ctx.connectorErrorResponse answers as connectorErrorResponse would, for the caller's own admin flag", async () => {
  for (const isAdmin of [false, true]) {
    const res = await callAs(rawRoute(), "session", isAdmin);
    const expected = connectorErrorResponse(authFailed(), { isAdmin });
    assert.equal(res.status, expected.status);
    assert.equal(res.headers.get("cache-control"), expected.headers.get("cache-control"));
    assert.deepEqual(await res.json(), await expected.json());
  }
});

test("ctx.connectorErrorResponse shows the admin-only fields to a signed-in admin and hides them from everyone else", async () => {
  for (const tier of ["session", "signed-in"] as const) {
    const admin = await (await callAs(rawRoute(), tier, true)).json();
    assert.equal(admin.error.adminActionUrl, "/admin/connectors?connector=acme", tier);
    assert.equal(admin.error.upstreamRequestId, "req-9", tier);
    assert.equal(typeof admin.error.adminHint, "string", tier);

    const user = await (await callAs(rawRoute(), tier, false)).json();
    for (const key of ADMIN_ONLY) assert.equal(key in user.error, false, `${tier}: ${key} must not reach a non-admin`);
  }
  for (const tier of ["password", "key", "public"] as const) {
    const body = await (await callAs(rawRoute(), tier)).json();
    assert.equal(body.error.category, "auth_failed");
    for (const key of ADMIN_ONLY) assert.equal(key in body.error, false, `${tier}: ${key} must not reach this caller`);
  }
});

test("a handler cannot make itself an admin to read the admin-only fields", async () => {
  const elevate = (ctx: { user: unknown }) => {
    (ctx.user as { isAdmin: boolean }).isAdmin = true;
  };

  const raw = await (await callAs(rawRoute(elevate), "session", false)).json();
  for (const key of ADMIN_ONLY) assert.equal(key in raw.error, false, `raw route: ${key}`);

  // The same holds for a failure a JSON route lets propagate.
  const route = defineRoute({
    output: z.object({ items: z.array(z.string()) }),
    handler: async (ctx) => {
      elevate(ctx);
      throw authFailed();
    },
  });
  const propagated = await (await quietly(() => callAs(route, "session", false))).json();
  for (const key of ADMIN_ONLY) assert.equal(key in propagated.error, false, `propagated: ${key}`);
});

// ── the client ──────────────────────────────────────────────────────────────

test("the client reads the envelope's message and hands the envelope to the widget", async () => {
  const res = await quietly(() => call(failingRoute({ category: "unconfigured" })));
  globalThis.fetch = async () => res;

  const err = await createAppClient("acme-app")
    .call("GET /items")
    .then(
      () => assert.fail("the call should have failed"),
      (e: unknown) => e,
    );

  assert.ok(err instanceof AppClientError);
  assert.equal(err.status, 503);
  // The envelope's sentence, not "[object Object]".
  assert.match(err.message, /^Acme isn't set up yet/);
  assert.equal(connectorErrorOf(err)?.error.category, "unconfigured");
});

test("a failure that is not a connector's carries no envelope", async () => {
  globalThis.fetch = async () =>
    Response.json({ error: "No such item.", code: "NOT_FOUND" }, { status: 404 });

  const err = await createAppClient("acme-app")
    .call("GET /items")
    .then(
      () => assert.fail("the call should have failed"),
      (e: unknown) => e,
    );

  assert.ok(err instanceof AppClientError);
  assert.equal(err.message, "No such item.");
  assert.equal(connectorErrorOf(err), null);
});
