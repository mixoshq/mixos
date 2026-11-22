/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `loadFromMap` (./module-map.ts), which every generated map of app modules is
 * read through: routes, MCP tools, syncs, jobs and services. What has to hold
 * is the three outcomes kept apart, since a caller logs "run `npm run
 * registry`" for one and the module's own error for another.
 */

import { describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { loadFromMap, type ModuleLoaders } from "./module-map";

const KEY = "probe-3f9a2c1b/jobs/tick";

describe("loadFromMap", () => {
  test("a key with no loader is missing, and no loader runs", async () => {
    let ran = false;
    const loaders: ModuleLoaders = { "probe-3f9a2c1b/jobs/other": async () => ((ran = true), {}) };
    assert.deepEqual(await loadFromMap(loaders, KEY), { kind: "missing", key: KEY });
    assert.equal(ran, false);
  });

  test("a loader that throws is a failure, carrying the error", async () => {
    const boom = new Error("boom at module scope");
    assert.deepEqual(await loadFromMap({ [KEY]: () => Promise.reject(boom) }, KEY), {
      kind: "failed",
      key: KEY,
      error: boom,
    });
  });

  test("a loader that throws before its promise is a failure too", async () => {
    const boom = new Error("thrown synchronously");
    const load = await loadFromMap(
      {
        [KEY]: () => {
          throw boom;
        },
      },
      KEY,
    );
    assert.deepEqual(load, { kind: "failed", key: KEY, error: boom });
  });

  test("a loader that resolves is the module itself", async () => {
    const mod = { default: () => "tick" };
    const load = await loadFromMap({ [KEY]: async () => mod }, KEY);
    assert.equal(load.kind, "loaded");
    assert.equal(load.kind === "loaded" && load.module, mod);
  });

  test("only the map's own keys: an inherited property is still missing", async (t: TestContext) => {
    const proto = Object.prototype as Record<string, unknown>;
    proto[KEY] = async () => ({ default: "inherited" });
    t.after(() => delete proto[KEY]);
    assert.equal((await loadFromMap({}, KEY)).kind, "missing");
    assert.equal((await loadFromMap({}, "constructor")).kind, "missing");
    assert.equal((await loadFromMap({}, "__proto__")).kind, "missing");
  });
});
