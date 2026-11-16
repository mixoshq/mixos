/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Loading an app's MCP tools, syncs, jobs and services through the generated
 * maps (scripts/handler-loaders.ts), through the real callers: `loadTool` and
 * `describeTool` (src/lib/mcp/tools.ts), `runJobNow` (./scheduler.ts) and the
 * services broker (./services.ts).
 *
 * The maps replaced template imports that Turbopack resolved once, when the
 * importing module compiled, so a handler added under `next dev` did not load
 * until a restart. What has to hold, for each caller:
 *
 *   - it loads from its kind's map, under the key the generator writes;
 *   - a handler with no loader and one that throws at load are told apart in
 *     the log (or, for a job, in the error its run records);
 *   - what the caller answers in each case is what it answered before.
 *
 * No database: `@/lib/db/client` is a fake `sql` that records each statement,
 * and the app gate and the app context are stubbed, all by a resolve hook. The
 * loaders are entries put into the generated maps for each test.
 */

import { after, before, beforeEach, describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import type { AppManifest } from "@/lib/apps/types";

const SLUG = "probe-3f9a2c1b";
const CALLER = "caller-5d6e7f80";

/** One statement the fake `sql` was handed. */
interface Statement {
  text: string;
  values: unknown[];
}
const statements = (): Statement[] =>
  ((globalThis as { __handlerSql?: Statement[] }).__handlerSql ??= []);

/** Each real module that is stubbed, by its path under src/lib/ → the module standing in for it. */
const STUBS: Record<string, string> = {
  // A claim's `returning id` wins; everything else returns no rows.
  "db/client.ts": `const statements = (globalThis.__handlerSql ??= []);
export const sql = (strings, ...values) => {
  const text = strings.join("$");
  statements.push({ text, values });
  return Promise.resolve(/returning id/.test(text) ? [{ id: "1" }] : []);
};
`,
  "apps/app-gate.ts": `export async function checkAppGate() { return { open: true }; }
export function isUpdatingAppPage() { return false; }
`,
  "apps/context.ts": `const ctx = () => ({ user: null, connectors: {}, db: null, telemetry: {}, manifest: {} });
export async function buildAppContext() { return ctx(); }
export async function buildSystemAppContext() { return ctx(); }
export async function buildPublicAppContext() { return ctx(); }
`,
};

let work: string;
let resolver: ReturnType<typeof registerHooks> | undefined;
let platform: {
  tools: typeof import("../mcp/tools");
  scheduler: typeof import("./scheduler");
  services: typeof import("./services");
  registry: typeof import("../../generated/app-registry");
  mcp: typeof import("../../generated/app-mcp-tool-loaders");
  syncs: typeof import("../../generated/app-sync-loaders");
  jobs: typeof import("../../generated/app-job-loaders");
  serviceMap: typeof import("../../generated/app-service-loaders");
};

/** The fixtures' registry entries, as the generator hoists what these callers read. */
const TOOL = { name: "peek", description: "Peeks.", sources: ["mixos"] };
const provider = {
  slug: SLUG,
  name: "Probe",
  mcp: [TOOL],
  schedules: [{ name: "tick", everyMinutes: 5 }],
  sync: [
    {
      name: "feed",
      schedule: { everyMinutes: 15 },
      source: "mixos",
      window: { coldStartDays: 7, defaultDays: 1, minDays: 1 },
      budgetMs: 10000,
    },
  ],
  provides: [{ name: "lookup", audience: "app", consumers: "*" }],
  consumes: [],
} as unknown as AppManifest;
const caller = {
  slug: CALLER,
  name: "Caller",
  mcp: [],
  schedules: [],
  sync: [],
  provides: [],
  consumes: [{ app: SLUG, service: "lookup" }],
} as unknown as AppManifest;

before(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-handler-loader-"));
  const lib = path.resolve(__dirname, "..");
  const byPath = new Map<string, string>();
  for (const [real, text] of Object.entries(STUBS)) {
    const file = path.join(work, `${real.replace(/[^a-z]+/gi, "-")}.mjs`);
    fs.writeFileSync(file, text);
    byPath.set(path.join(lib, real), pathToFileURL(file).href);
  }
  // By where a specifier lands, not how it is spelled: the scheduler imports
  // "./context" and the broker imports it dynamically, the rest by `@/`.
  resolver = registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      if (!resolved.url.startsWith("file:")) return resolved;
      const stub = byPath.get(fileURLToPath(resolved.url.split("?")[0]));
      return stub ? { url: stub, format: "module", shortCircuit: true } : resolved;
    },
  });
  platform = {
    tools: await import("../mcp/tools"),
    scheduler: await import("./scheduler"),
    services: await import("./services"),
    registry: await import("../../generated/app-registry"),
    mcp: await import("../../generated/app-mcp-tool-loaders"),
    syncs: await import("../../generated/app-sync-loaders"),
    jobs: await import("../../generated/app-job-loaders"),
    serviceMap: await import("../../generated/app-service-loaders"),
  };
  platform.registry.appRegistry.push(provider, caller);
});

after(() => {
  if (platform) {
    for (const app of [provider, caller]) {
      const at = platform.registry.appRegistry.indexOf(app);
      if (at >= 0) platform.registry.appRegistry.splice(at, 1);
    }
  }
  resolver?.deregister();
  if (work) fs.rmSync(work, { recursive: true, force: true });
});

type Loader = () => Promise<Record<string, unknown>>;

/** Each map the fixtures' handlers live in, under the keys the generator writes. */
const maps = () => ({
  [`${SLUG}/mcp/peek`]: platform.mcp.mcpToolLoaders,
  [`${SLUG}/sync/feed`]: platform.syncs.syncLoaders,
  [`${SLUG}/jobs/tick`]: platform.jobs.jobLoaders,
  [`${SLUG}/services/lookup`]: platform.serviceMap.serviceLoaders,
});

function setLoader(key: keyof ReturnType<typeof maps>, loader: Loader) {
  maps()[key][key] = loader;
}

beforeEach(() => {
  for (const [key, map] of Object.entries(maps())) delete map[key];
  statements().length = 0;
});

/** What the console says while `run` runs. */
async function logged<T>(t: TestContext, run: () => Promise<T>) {
  const warn: string[] = [];
  const error: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => warn.push(args.map(String).join(" ")));
  t.mock.method(console, "error", (...args: unknown[]) => error.push(args));
  t.mock.method(console, "log", () => {});
  try {
    return { result: await run(), warn, error };
  } finally {
    t.mock.restoreAll();
  }
}

const boom = new Error("boom at module scope");
const throwing: Loader = () => Promise.reject(boom);
const REGISTRY = /Run `npm run registry`\./;

describe("MCP tools", () => {
  const inputSchema = z.object({ limit: z.number().optional() });
  const peek = async () => ({ peeked: true });

  test("a tool with no loader is null, and the log says to run the generator", async (t) => {
    const { result, warn, error } = await logged(t, () => platform.tools.loadTool(SLUG, "peek"));
    assert.equal(result, null);
    assert.equal(warn.length, 1);
    assert.match(warn[0], new RegExp(`\\[mcp\\] ${SLUG}/mcp/peek is declared but not in the generated tool map`));
    assert.match(warn[0], REGISTRY);
    assert.deepEqual(error, []);
  });

  test("a tool that throws at load is null, and the log carries the error, not 'missing'", async (t) => {
    setLoader(`${SLUG}/mcp/peek`, throwing);
    const { result, warn, error } = await logged(t, () => platform.tools.loadTool(SLUG, "peek"));
    assert.equal(result, null);
    assert.deepEqual(warn, []);
    assert.equal(error.length, 1);
    assert.match(String(error[0][0]), new RegExp(`\\[mcp\\] failed to import ${SLUG}/mcp/peek`));
    assert.equal(error[0][1], boom);
  });

  test("a loaded tool is its handler and schema", async (t) => {
    setLoader(`${SLUG}/mcp/peek`, async () => ({ default: peek, inputSchema }));
    const { result } = await logged(t, () => platform.tools.loadTool(SLUG, "peek"));
    assert.equal(result?.handler, peek);
    assert.equal(result?.inputSchema, inputSchema);
  });

  test("a loaded module is still checked: no inputSchema is null, as before", async (t) => {
    setLoader(`${SLUG}/mcp/peek`, async () => ({ default: peek }));
    const { result, warn, error } = await logged(t, () => platform.tools.loadTool(SLUG, "peek"));
    assert.equal(result, null);
    assert.deepEqual([warn, error], [[], []]);
  });

  test("tools/list describes a tool loaded from the map, and omits one that isn't in it", async (t) => {
    const missing = await logged(t, () => platform.tools.describeTool(provider, TOOL as never));
    assert.equal(missing.result, null);
    assert.match(missing.warn[0], REGISTRY);

    setLoader(`${SLUG}/mcp/peek`, async () => ({ default: peek, inputSchema }));
    const { result } = await logged(t, () => platform.tools.describeTool(provider, TOOL as never));
    assert.equal(result?.name, `${SLUG}__peek`);
    assert.deepEqual(Object.keys((result?.inputSchema.properties ?? {}) as object), ["limit"]);
  });
});

describe("the scheduler", () => {
  /** What the run's history row records: status and error, from the fake `sql`. */
  function recordedRun(job: string) {
    const runs = statements().filter((s) => s.text.includes("insert into public.app_job_runs"));
    assert.equal(runs.length, 1, "one run recorded");
    // values (slug, job, started_at, status, error, duration_ms, trigger)
    const [slug, name, , status, error, , trigger] = runs[0].values;
    assert.deepEqual([slug, name, trigger], [SLUG, job, "manual"]);
    return { status, error };
  }

  for (const [label, job, kind, key] of [
    ["a job", "tick", "job", `${SLUG}/jobs/tick`],
    ["a sync", "sync:feed", "sync", `${SLUG}/sync/feed`],
  ] as const) {
    describe(label, () => {
      test("with no loader, the run is an error that says to run the generator", async (t) => {
        const { result, error } = await logged(t, () => platform.scheduler.runJobNow(SLUG, job));
        assert.deepEqual(result, { ran: true });
        const run = recordedRun(job);
        assert.equal(run.status, "error");
        assert.match(
          String(run.error),
          new RegExp(`^apps/${key.replace(/[/]/g, "\\/")}\\.ts is declared but not in the generated ${kind} map\\. `),
        );
        assert.match(String(run.error), REGISTRY);
        assert.match(String(error[0]?.[0]), new RegExp(`\\[scheduler\\] ${SLUG}/${job} error`));
      });

      test("throwing at load, the run is an error with the module's own message", async (t) => {
        setLoader(key, throwing);
        const { result, error } = await logged(t, () => platform.scheduler.runJobNow(SLUG, job));
        assert.deepEqual(result, { ran: true });
        assert.deepEqual(recordedRun(job), { status: "error", error: boom.message });
        assert.equal(error[0]?.[1], boom);
      });
    });
  }

  test("a loaded job runs, and its run is ok", async (t) => {
    let runs = 0;
    setLoader(`${SLUG}/jobs/tick`, async () => ({ default: async () => void runs++ }));
    const { result, error } = await logged(t, () => platform.scheduler.runJobNow(SLUG, "tick"));
    assert.deepEqual(result, { ran: true });
    assert.equal(runs, 1);
    assert.deepEqual(recordedRun("tick"), { status: "ok", error: null });
    assert.deepEqual(error, []);
  });

  test("a loaded sync reaches the defineSync check, as before", async (t) => {
    setLoader(`${SLUG}/sync/feed`, async () => ({ default: { not: "a sync" } }));
    await logged(t, () => platform.scheduler.runJobNow(SLUG, "sync:feed"));
    const run = recordedRun("sync:feed");
    assert.equal(run.status, "error");
    assert.match(String(run.error), /must default-export defineSync/);
  });
});

describe("the services broker", () => {
  const request = () =>
    platform.services
      .createServicesClient({ callerSlug: CALLER, actingUser: null })
      .request(SLUG, "lookup", { q: 1 });

  const noHandler = (err: unknown) => {
    assert.ok(err instanceof platform.services.ServiceRequestError, String(err));
    assert.equal(err.code, "NO_HANDLER");
    // What the consumer has always been told, which names no internals.
    assert.equal(err.message, `"${SLUG}:lookup" has no handler on disk.`);
    return true;
  };

  test("a service with no loader is NO_HANDLER, and the log says to run the generator", async (t) => {
    const { warn, error } = await logged(t, () => assert.rejects(request(), noHandler));
    assert.equal(warn.length, 1);
    assert.match(warn[0], new RegExp(`\\[services\\] ${SLUG}/services/lookup is declared but not in the generated service map`));
    assert.match(warn[0], REGISTRY);
    assert.deepEqual(error, []);
  });

  test("a service that throws at load is NO_HANDLER too, and the log carries the error", async (t) => {
    setLoader(`${SLUG}/services/lookup`, throwing);
    const { warn, error } = await logged(t, () => assert.rejects(request(), noHandler));
    assert.deepEqual(warn, []);
    assert.equal(error.length, 1);
    assert.match(String(error[0][0]), new RegExp(`\\[services\\] ${SLUG}/services/lookup failed to load`));
    assert.equal(error[0][1], boom);
  });

  test("a loaded service answers with its handler's result", async (t) => {
    setLoader(`${SLUG}/services/lookup`, async () => ({
      default: async (_ctx: unknown, params: unknown) => ({ echoed: params }),
    }));
    const { result } = await logged(t, request);
    assert.deepEqual(result, { echoed: { q: 1 } });
  });

  test("a loaded module without a default export is still NO_HANDLER, as before", async (t) => {
    setLoader(`${SLUG}/services/lookup`, async () => ({ lookup: () => 1 }));
    await logged(t, () =>
      assert.rejects(request(), (err: unknown) => {
        assert.ok(err instanceof platform.services.ServiceRequestError);
        assert.equal(err.code, "NO_HANDLER");
        assert.match(err.message, /handler has no default export/);
        return true;
      }),
    );
  });
});
