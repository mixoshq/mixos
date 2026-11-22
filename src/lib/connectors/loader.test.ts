/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Constructing a connector through the generated map (./loader.ts), on its
 * own and through Verify connection (`runConnectorTest`, ./test-connection.ts).
 *
 * The map replaced a template import that Turbopack resolved once, when the
 * importing module compiled. What has to hold:
 *
 *   - a connector with no loader and one whose module throws at load are told
 *     apart, by a `ConnectorLoadError`'s reason and message;
 *   - the class is picked as the callers always picked it: the default export,
 *     or else the first exported function;
 *   - Verify connection answers a connector missing from the map as it answers
 *     one missing from the registry, and one that throws at load as before.
 *
 * No database: the switch, the saved config and the user grant are stubbed by
 * a resolve hook. The loaders are entries put into the generated map for each
 * test.
 */

import { after, before, beforeEach, describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ConnectorManifest } from "./types";

const NAME = "probe-3f9a2c1b";
const KEY = `${NAME}/index`;

/** Each real module that is stubbed, by its path under src/lib/connectors/ → the module standing in for it. */
const STUBS: Record<string, string> = {
  "switch.ts": `export async function isConnectorDisabled() { return false; }
`,
  "config.ts": `export async function getDecryptedConfig() { return null; }
`,
  "user-grant.ts": `export async function initializeWithUserGrant() { return false; }
`,
};

let work: string;
let resolver: ReturnType<typeof registerHooks> | undefined;
let platform: {
  loader: typeof import("./loader");
  test: typeof import("./test-connection");
  registry: typeof import("../../generated/connector-registry");
  map: typeof import("../../generated/connector-loaders");
};

const manifest = { name: NAME, displayName: "Probe" } as unknown as ConnectorManifest;

before(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-connector-loader-"));
  const here = __dirname;
  const byPath = new Map<string, string>();
  for (const [real, text] of Object.entries(STUBS)) {
    const file = path.join(work, `${real.replace(/[^a-z]+/gi, "-")}.mjs`);
    fs.writeFileSync(file, text);
    byPath.set(path.join(here, real), pathToFileURL(file).href);
  }
  // By where a specifier lands, not how it is spelled.
  resolver = registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      if (!resolved.url.startsWith("file:")) return resolved;
      const stub = byPath.get(fileURLToPath(resolved.url.split("?")[0]));
      return stub ? { url: stub, format: "module", shortCircuit: true } : resolved;
    },
  });
  platform = {
    loader: await import("./loader"),
    test: await import("./test-connection"),
    registry: await import("../../generated/connector-registry"),
    map: await import("../../generated/connector-loaders"),
  };
  platform.registry.connectorRegistry.push(manifest);
});

after(() => {
  if (platform) {
    const at = platform.registry.connectorRegistry.indexOf(manifest);
    if (at >= 0) platform.registry.connectorRegistry.splice(at, 1);
    delete platform.map.connectorLoaders[KEY];
  }
  resolver?.deregister();
  if (work) fs.rmSync(work, { recursive: true, force: true });
});

type Loader = () => Promise<Record<string, unknown>>;
const setLoader = (loader: Loader) => {
  platform.map.connectorLoaders[KEY] = loader;
};

beforeEach(() => {
  delete platform.map.connectorLoaders[KEY];
});

/** What the console says while `run` runs. */
async function logged<T>(t: TestContext, run: () => Promise<T>) {
  const error: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => error.push(args));
  t.mock.method(console, "warn", () => {});
  try {
    return { result: await run(), error };
  } finally {
    t.mock.restoreAll();
  }
}

const boom = new Error("boom at module scope");
const throwing: Loader = () => Promise.reject(boom);

describe("constructConnector", () => {
  test("a connector with no loader is a ConnectorLoadError that says to run the generator", async () => {
    await assert.rejects(platform.loader.constructConnector(NAME), (err: unknown) => {
      assert.ok(err instanceof platform.loader.ConnectorLoadError, String(err));
      assert.equal(err.reason, "missing");
      assert.equal(err.connector, NAME);
      assert.equal(err.message, `${KEY} is not in the generated connector map. Run \`npm run registry\`.`);
      return true;
    });
  });

  test("a module that throws at load is a ConnectorLoadError carrying the module's error", async () => {
    setLoader(throwing);
    await assert.rejects(platform.loader.constructConnector(NAME), (err: unknown) => {
      assert.ok(err instanceof platform.loader.ConnectorLoadError, String(err));
      assert.equal(err.reason, "failed");
      assert.equal(err.message, `${KEY} failed to load`);
      assert.equal(err.cause, boom);
      return true;
    });
  });

  test("the default export is constructed", async () => {
    class Probe {
      readonly from = "default";
    }
    setLoader(async () => ({ default: Probe, helper: () => 1 }));
    const instance = await platform.loader.constructConnector(NAME);
    assert.ok(instance instanceof Probe);
  });

  test("without a default export, the first exported function is", async () => {
    class Named {
      readonly from = "named";
    }
    setLoader(async () => ({ VERSION: "1", Named }));
    const instance = await platform.loader.constructConnector(NAME);
    assert.ok(instance instanceof Named);
  });

  test("a module with nothing to construct still throws, and not as a load error", async () => {
    setLoader(async () => ({ VERSION: "1" }));
    await assert.rejects(platform.loader.constructConnector(NAME), (err: unknown) => {
      assert.ok(err instanceof TypeError, String(err));
      assert.ok(!(err instanceof platform.loader.ConnectorLoadError));
      return true;
    });
  });
});

describe("Verify connection", () => {
  test("a connector missing from the map gets the registry answer, and the log says why", async (t) => {
    const { result, error } = await logged(t, () => platform.test.runConnectorTest(NAME));
    assert.deepEqual(result, {
      ok: false,
      category: "unsupported",
      message: "Probe isn't in this server's connector map.",
      adminHint: "Regenerate the registry (npm run registry) and reload.",
      upstreamRequestId: null,
    });
    assert.equal(error.length, 1);
    assert.match(String(error[0][0]), new RegExp(`\\[connector-test\\] ${KEY} is not in the generated connector map`));
  });

  test("a module that throws at load keeps the general answer, and the log carries its error", async (t) => {
    setLoader(throwing);
    const { result, error } = await logged(t, () => platform.test.runConnectorTest(NAME));
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.category, "internal_error");
    const lines = error.map((args) => args.map(String).join(" "));
    assert.ok(
      error.some((args) => String(args[0]).includes(`${KEY} failed to load`) && args[1] === boom),
      lines.join("\n"),
    );
  });

  test("a loaded connector is tested, as before", async (t) => {
    setLoader(async () => ({
      default: class {
        async initialize() {}
        async testConnection() {
          return { detail: "reached the probe" };
        }
      },
    }));
    const { result } = await logged(t, () => platform.test.runConnectorTest(NAME));
    assert.deepEqual(result, { ok: true, detail: "reached the probe" });
  });
});
