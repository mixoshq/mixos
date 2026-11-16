/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Loading an app route through the generated map (./route-loader.ts), and
 * the two callers that do it: the gateway (./dispatch.ts) and callAppRoute
 * (./call.ts).
 *
 * The map replaced a template import that Turbopack resolved once, when the
 * gateway compiled, so a route added under `next dev` was a 404 until a
 * restart. What has to hold, for both callers:
 *
 *   - they load from the map, under the key the generator writes;
 *   - a route with no loader and a route that throws at load are still told
 *     apart in the log, though the caller sees the same 404 / NOT_FOUND.
 *
 * No database: what runs before the import and reaches one (the maintenance
 * state, the app gate, the rate limiters) is stubbed by a resolve hook, and so
 * is the directory walk that turns URL segments into a route path, so no
 * fixture goes under apps/. The loaders are entries put into the generated
 * map for the test and taken out after it.
 */

import { after, before, beforeEach, describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AppManifest } from "@/lib/apps/types";

const SLUG = "probe-3f9a2c1b";
const key = (modulePath: string) => `${SLUG}/api/${modulePath}/route`;

let work: string;
let resolver: ReturnType<typeof registerHooks> | undefined;
let platform: {
  loader: typeof import("./route-loader");
  dispatch: typeof import("./dispatch");
  call: typeof import("./call");
  errors: typeof import("./errors");
  registry: typeof import("../../generated/app-registry");
  routeLoaders: typeof import("../../generated/app-route-loaders");
};

/** Each stubbed specifier → the module text standing in for it. */
const STUBS: Record<string, string> = {
  "@/lib/platform/maintenance": `export function maintenanceState() {
  return Promise.resolve({ platformBehind: false, appsBehind: new Set() });
}
`,
  "@/lib/apps/app-gate": `export async function checkAppGate() { return { open: true }; }
export function isUpdatingAppPage() { return false; }
`,
  "@/lib/rate-limit": `const allowed = { allowed: true, remaining: 1, retryAfterMs: 0 };
export function createRateLimiter() {
  return { consume: async () => allowed, check: async () => allowed, peek: () => allowed };
}
export async function pruneRateBuckets() {}
`,
  "@/lib/apps/api-router": `export async function resolveRoutePath(slug, segments) {
  return segments.length > 0 ? segments.join("/") : null;
}
`,
};

/** The registry entry: GET on the root route and on `items`, as the generator hoists them. */
const manifest = {
  slug: SLUG,
  name: "Probe",
  routes: [
    { path: "", methods: [{ method: "GET", auth: ["session"], roles: [] }] },
    { path: "items", methods: [{ method: "GET", auth: ["session"], roles: [] }] },
  ],
} as unknown as AppManifest;

before(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-route-loader-"));
  const files = new Map<string, string>();
  for (const [specifier, text] of Object.entries(STUBS)) {
    const file = path.join(work, `${specifier.replace(/[^a-z]+/gi, "-")}.mjs`);
    fs.writeFileSync(file, text);
    files.set(specifier, pathToFileURL(file).href);
  }
  resolver = registerHooks({
    resolve(specifier, context, nextResolve) {
      const stub = files.get(specifier);
      return nextResolve(stub ?? specifier, context);
    },
  });
  platform = {
    loader: await import("./route-loader"),
    dispatch: await import("./dispatch"),
    call: await import("./call"),
    errors: await import("./errors"),
    registry: await import("../../generated/app-registry"),
    routeLoaders: await import("../../generated/app-route-loaders"),
  };
  platform.registry.appRegistry.push(manifest);
});

after(() => {
  if (platform) {
    const at = platform.registry.appRegistry.indexOf(manifest);
    if (at >= 0) platform.registry.appRegistry.splice(at, 1);
  }
  resolver?.deregister();
  if (work) fs.rmSync(work, { recursive: true, force: true });
});

/** The fixture's loaders, cleared before each test so each one sets its own. */
function setLoader(modulePath: string, loader: () => Promise<Record<string, unknown>>) {
  platform.routeLoaders.routeLoaders[key(modulePath)] = loader;
}
beforeEach(() => {
  for (const modulePath of ["index", "items"]) delete platform.routeLoaders.routeLoaders[key(modulePath)];
});

/** What the console says while `run` runs. */
async function logged<T>(t: TestContext, run: () => Promise<T>) {
  const warn: string[] = [];
  const error: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => warn.push(args.map(String).join(" ")));
  t.mock.method(console, "error", (...args: unknown[]) => error.push(args));
  const result = await run();
  t.mock.restoreAll();
  return { result, warn, error };
}

const boom = new Error("boom at module scope");
const throwing = () => Promise.reject(boom);
/** Loaded, with a GET that is not a defineRoute() result. */
const bare = async () => ({ GET: () => new Response("bare") });

describe("loadRouteModule", () => {
  test("a route with no loader is missing", async () => {
    assert.deepEqual(await platform.loader.loadRouteModule(SLUG, "items"), {
      kind: "missing",
      key: key("items"),
    });
  });

  test("a loader that throws is a failure, carrying the error", async () => {
    setLoader("items", throwing);
    assert.deepEqual(await platform.loader.loadRouteModule(SLUG, "items"), {
      kind: "failed",
      key: key("items"),
      error: boom,
    });
  });

  test("a loader that resolves is the module", async () => {
    const mod = { GET: "declaration" };
    setLoader("items", async () => mod);
    const load = await platform.loader.loadRouteModule(SLUG, "items");
    assert.equal(load.kind, "loaded");
    assert.equal(load.kind === "loaded" && load.module, mod);
  });

  test("only the map's own keys: an inherited property is still missing", async (t) => {
    const proto = Object.prototype as Record<string, unknown>;
    proto[key("items")] = bare;
    t.after(() => delete proto[key("items")]);
    assert.equal((await platform.loader.loadRouteModule(SLUG, "items")).kind, "missing");
  });
});

describe("the gateway", () => {
  const get = (segments: string[]) =>
    platform.dispatch.dispatchAppRoute({
      request: new Request(`http://mixos.test/api/apps/${SLUG}/${segments.join("/")}`),
      method: "GET",
      appSlug: SLUG,
      segments,
      mount: "authenticated",
    });

  test("a route with no loader is a 404 that says to run the generator", async (t) => {
    const { result, warn, error } = await logged(t, () => get(["items"]));
    assert.equal(result.status, 404);
    assert.equal(warn.length, 1);
    assert.match(warn[0], new RegExp(`${SLUG}/api/items is on disk but not in the generated route map`));
    assert.match(warn[0], /npm run registry/);
    assert.deepEqual(error, []);
  });

  test("a route that throws at load is a 404 that logs the error, not 'missing'", async (t) => {
    setLoader("items", throwing);
    const { result, warn, error } = await logged(t, () => get(["items"]));
    assert.equal(result.status, 404);
    assert.deepEqual(warn, []);
    assert.equal(error.length, 1);
    assert.match(String(error[0][0]), new RegExp(`${SLUG}/api/items failed to load`));
    assert.equal(error[0][1], boom);
  });

  test("a loaded module is dispatched: 405 for a method it does not export", async (t) => {
    setLoader("items", async () => ({}));
    const { result } = await logged(t, () => get(["items"]));
    assert.equal(result.status, 405);
    assert.equal((await result.json()).code, "METHOD_NOT_ALLOWED");
  });

  test("a loaded module is dispatched: 500 for a GET that is not a declaration", async (t) => {
    setLoader("items", bare);
    const { result } = await logged(t, () => get(["items"]));
    assert.equal(result.status, 500);
    assert.equal((await result.json()).code, "HANDLER_ERROR");
  });

  test("the root route loads from the index key", async (t) => {
    setLoader("index", bare);
    const { result } = await logged(t, () => get([]));
    assert.equal(result.status, 500);
  });
});

describe("callAppRoute", () => {
  const code = (expected: string) => (err: unknown) => {
    assert.ok(err instanceof platform.errors.AppError, String(err));
    assert.equal(err.code, expected);
    return true;
  };

  test("a route with no loader is NOT_FOUND, and the log says to run the generator", async (t) => {
    const { result, warn, error } = await logged(t, () =>
      assert.rejects(platform.call.callAppRoute(SLUG, "GET /items"), code("NOT_FOUND")),
    );
    assert.equal(result, undefined);
    assert.equal(warn.length, 1);
    assert.match(warn[0], new RegExp(`${SLUG}/api/items is declared but not in the generated route map`));
    assert.match(warn[0], /npm run registry/);
    assert.deepEqual(error, []);
  });

  test("a route that throws at load is NOT_FOUND, and the log carries the error", async (t) => {
    setLoader("items", throwing);
    const { warn, error } = await logged(t, () =>
      assert.rejects(platform.call.callAppRoute(SLUG, "GET /items"), code("NOT_FOUND")),
    );
    assert.deepEqual(warn, []);
    assert.equal(error.length, 1);
    assert.match(String(error[0][0]), new RegExp(`${SLUG}/api/items failed to load`));
    assert.equal(error[0][1], boom);
  });

  test("a loaded module is read: HANDLER_ERROR for a GET that is not a declaration", async (t) => {
    setLoader("items", bare);
    await logged(t, () =>
      assert.rejects(platform.call.callAppRoute(SLUG, "GET /items"), code("HANDLER_ERROR")),
    );
  });

  test("the root route loads from the index key", async (t) => {
    setLoader("index", bare);
    await logged(t, () =>
      assert.rejects(platform.call.callAppRoute(SLUG, "GET /"), code("HANDLER_ERROR")),
    );
  });
});
