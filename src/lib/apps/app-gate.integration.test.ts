/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The app gate against a real Postgres. An app an admin switched off runs none
 * of its code, through any door, and runs again once it is switched back on,
 * with no restart. And the Scheduled Jobs page's actions are audited.
 *
 * Every fixture module records at its top level that it was imported, and each
 * handler records that it ran, so "never imported" is read rather than
 * inferred from a status code. A module is imported at most once per process,
 * so every test of the switched-off app runs before the first that switches it
 * on.
 *
 * The fixtures live in a temporary folder, and a resolve hook points
 * `@apps/<fixture>/…` there. The same hook stands in for the two modules that
 * need a Next request: the session, and `revalidatePath`.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database and roles on. Every name it creates ends in this run's own
 * suffix, and it drops them all when it finishes:
 *
 *   docker run -d --name gate -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test src/lib/apps/app-gate.integration.test.ts
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import postgres, { type Sql } from "postgres";
import { appRoleName } from "./app-identifiers";
import type { AppManifest, RouteMethodContract } from "./types";

const REPO = path.resolve(__dirname, "..", "..", "..");
const serverUrl = process.env.MIXOS_TEST_DATABASE_URL;
const skip = serverUrl ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres";

// Roles belong to the server, not to a database, so every name is this run's.
const run = randomBytes(3).toString("hex");
const database = `mixos_gate_${run}`;
const GATED = `gated-${run}`;
const CALLER = `caller-${run}`;
/** The fixture's routes, under `api/`: written to disk and to the route loader map. */
const GATED_ROUTES = ["index", "items"] as const;
/** Its job, sync and service, as `<kind>/<name>`: on disk and in their kinds' loader maps. */
const GATED_HANDLERS = ["jobs/tick", "sync/feed", "services/lookup"] as const;
const ADMIN_EMAIL = `admin-${run}@example.com`;

/** Made in `before`, so a skipped run leaves nothing behind. */
let work: string;
let appsDir: string;

// ── what the fixtures record ────────────────────────────────────────────────

function journal(): string[] {
  return ((globalThis as { __gateJournal?: string[] }).__gateJournal ??= []);
}
const imported = (file: string) => journal().includes(`imported:${file}`);
const ran = (file: string) => journal().filter((e) => e === `ran:${file}`).length;

/** A module that records its import, with `ran()` to record each call. */
function fixture(file: string, body: string): void {
  const full = path.join(appsDir, GATED, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(
    full,
    `const journal = ((globalThis as { __gateJournal?: string[] }).__gateJournal ??= []);\n` +
      `journal.push(${JSON.stringify(`imported:${file}`)});\n` +
      `const ran = () => journal.push(${JSON.stringify(`ran:${file}`)});\n` +
      body,
  );
}

/** A `defineRoute()` result, written out so the fixture imports nothing. */
const route = (name: string) => `
export const GET = {
  brand: Symbol.for("mixos.route.definition"),
  auth: ["public"],
  roles: [],
  budget: { connectorCalls: 0, ms: 5000 },
  raw: false,
  handler: () => { ran(); return { route: ${JSON.stringify(name)} }; },
};
`;

function writeFixtures(): void {
  for (const [slug, name] of [[GATED, "Gated"], [CALLER, "Caller"]]) {
    fs.mkdirSync(path.join(appsDir, slug), { recursive: true });
    fs.writeFileSync(path.join(appsDir, slug, "app.json"), `{ "name": "${name}" }\n`);
  }
  for (const name of GATED_ROUTES) fixture(`api/${name}/route.ts`, route(name));
  fixture("jobs/tick.ts", `export default async function tick() { ran(); }\n`);
  fixture(
    "sync/feed.ts",
    `export default {
  brand: Symbol.for("mixos.sync.definition"),
  fetchPage: async () => { ran(); return { items: [] }; },
  upsert: async () => {},
};
`,
  );
  fixture(
    "services/lookup.ts",
    `export default async function lookup() { ran(); return { from: "lookup" }; }\n`,
  );
  fixture(
    "hooks.ts",
    `export default function register(hooks: { addAction: (n: string, cb: () => void) => void }) {
  ran();
  hooks.addAction("ping", () => { journal.push("heard:ping"); });
}
`,
  );
}

// ── the two apps, as the registry generator would emit them ─────────────────

function manifest(slug: string, name: string, extra: Partial<AppManifest>): AppManifest {
  return {
    slug,
    name,
    description: "",
    tagline: null,
    icon: "box",
    connectors: [],
    optionalConnectors: [],
    connectorRequirements: [],
    database: false,
    updatedAt: [],
    notifications: false,
    hasPages: false,
    pageCount: 0,
    global: false,
    roles: [],
    defaultRole: null,
    hookCounts: { actions: 0, filters: 0 },
    hooks: { emits: { actions: [], filters: [] }, listens: { actions: [], filters: [] } },
    authors: [],
    keywords: [],
    screenshots: [],
    license: null,
    appUrl: null,
    appSupportUrl: null,
    lastUpdated: null,
    escapes: [],
    env: [],
    egress: [],
    sync: [],
    routes: [],
    widgets: [],
    schedules: [],
    telemetry: [],
    provides: [],
    consumes: [],
    emits: [],
    listensTo: [],
    branding: null,
    search: [],
    mcp: [],
    ...extra,
  };
}

const publicGet: RouteMethodContract = {
  method: "GET",
  auth: ["public"],
  roles: [],
  budget: { connectorCalls: 0, ms: 5000 },
  raw: false,
  hasInput: false,
  hasOutput: false,
};

const gated = manifest(GATED, "Gated", {
  database: true,
  routes: [
    { path: "", params: [], methods: [publicGet] },
    { path: "items", params: [], methods: [publicGet] },
  ],
  schedules: [{ name: "tick", everyMinutes: 60 }],
  sync: [
    {
      name: "feed",
      schedule: { everyMinutes: 60 },
      source: "fixture",
      window: { coldStartDays: 1, defaultDays: 1, minDays: 1 },
      budgetMs: 10_000,
    },
  ],
  provides: [{ name: "lookup", audience: "app", consumers: [CALLER] }],
});
const caller = manifest(CALLER, "Caller", {
  consumes: [{ app: GATED, service: "lookup" }],
});

// ── stand-ins for what needs a Next request ─────────────────────────────────

const STUBS = new Map<string, string>([
  [
    "@/lib/auth/session",
    `export async function getReadOnlySession() { return null; }
export async function requireReadOnlySession() {
  const session = (globalThis as { __gateSession?: unknown }).__gateSession;
  if (!session) throw new Error("no session in this test");
  return session;
}
export const requireServerSession = requireReadOnlySession;
`,
  ],
  ["next/cache", `export function revalidatePath() {}\n`],
]);

function writeStubs(): Map<string, string> {
  const urls = new Map<string, string>();
  for (const [specifier, source] of STUBS) {
    const file = path.join(work, "stubs", `${specifier.replace(/[^a-z]+/g, "-")}.ts`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
    urls.set(specifier, pathToFileURL(file).href);
  }
  return urls;
}

/** The runner reports every step; the tests read the database instead. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

describe("the app gate", { skip }, () => {
  let admin: Sql;
  let sql: Sql;
  let resolver: ReturnType<typeof registerHooks> | undefined;
  let platform: {
    dispatch: typeof import("./dispatch");
    call: typeof import("./call");
    scheduler: typeof import("./scheduler");
    services: typeof import("./services");
    loader: typeof import("../hooks/loader");
    actions: typeof import("./scheduler-actions");
    registry: typeof import("../../generated/app-registry");
    hookLoaders: typeof import("../../generated/app-hook-loaders");
    routeLoaders: typeof import("../../generated/app-route-loaders");
    jobLoaders: typeof import("../../generated/app-job-loaders");
    syncLoaders: typeof import("../../generated/app-sync-loaders");
    serviceLoaders: typeof import("../../generated/app-service-loaders");
    db: typeof import("../db/client");
  };

  /** The loader map a fixture handler goes in, by its `<kind>/` prefix. */
  const handlerMap = (handler: (typeof GATED_HANDLERS)[number]) =>
    ({
      jobs: platform.jobLoaders.jobLoaders,
      sync: platform.syncLoaders.syncLoaders,
      services: platform.serviceLoaders.serviceLoaders,
    })[handler.slice(0, handler.indexOf("/")) as "jobs" | "sync" | "services"];

  const setActive = (on: boolean) =>
    sql`update public.apps set is_active = ${on} where slug = ${GATED}`;

  async function jobRow(job: string) {
    const [row] = await sql`
      select running_since, next_run_at, updated_at from public.app_scheduled_jobs
      where app_slug = ${GATED} and job_name = ${job}
    `;
    return row ? { ...row } : undefined;
  }
  async function runs(trigger: "scheduled" | "manual") {
    const rows = await sql`
      select job_name, status from public.app_job_runs
      where app_slug = ${GATED} and trigger = ${trigger} order by started_at
    `;
    return rows.map((r) => ({ ...r }));
  }
  /** Each claim the scheduler wins, logged by a trigger this test installs. */
  async function claims() {
    const rows = await sql`select job_name from gate_test.claims where app_slug = ${GATED}`;
    return rows.map((r) => r.job_name as string);
  }

  before(async () => {
    admin = postgres(serverUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${database}`);
    const u = new URL(serverUrl!);
    u.pathname = `/${database}`;
    const url = u.toString();
    sql = postgres(url, { max: 1, onnotice: () => {} });
    work = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-app-gate-"));
    appsDir = path.join(work, "apps");

    const { migratePlatform } = await import("../../../scripts/platform-migrations");
    const { migrateAppSchemas } = await import("../../../scripts/app-migrations");
    await quietly(() => migratePlatform(sql, path.join(REPO, "supabase", "migrations")));
    writeFixtures();
    // New apps arrive inactive, which is where every test below starts.
    await quietly(() => migrateAppSchemas(sql, { apps: [gated, caller], appsDir }));

    await sql.unsafe(`
      create schema gate_test;
      create table gate_test.claims (app_slug text not null, job_name text not null);
      create function gate_test.log_claim() returns trigger language plpgsql as $$
      begin
        insert into gate_test.claims values (new.app_slug, new.job_name);
        return null;
      end $$;
      create trigger gate_test_log_claim
        after update of running_since on public.app_scheduled_jobs
        for each row when (old.running_since is null and new.running_since is not null)
        execute function gate_test.log_claim();
      create function gate_test.switch_off() returns trigger language plpgsql as $$
      begin
        update public.apps set is_active = false where slug = new.app_slug;
        return null;
      end $$;
    `);

    const stubs = writeStubs();
    const prefixes = [GATED, CALLER].map((slug) => [`@apps/${slug}/`, slug] as const);
    resolver = registerHooks({
      resolve(specifier, context, nextResolve) {
        const stub = stubs.get(specifier);
        if (stub) return nextResolve(stub, context);
        for (const [prefix, slug] of prefixes) {
          if (specifier.startsWith(prefix)) {
            const file = path.join(appsDir, slug, `${specifier.slice(prefix.length)}.ts`);
            return nextResolve(pathToFileURL(file).href, context);
          }
        }
        return nextResolve(specifier, context);
      },
    });

    // The platform's own client, pointed at this database.
    process.env.DATABASE_URL = url;
    process.env.PGSSLMODE = u.searchParams.get("sslmode") ?? "disable";
    process.env.NEXTAUTH_URL ??= "http://localhost:3000";

    platform = {
      dispatch: await import("./dispatch"),
      call: await import("./call"),
      scheduler: await import("./scheduler"),
      services: await import("./services"),
      loader: await import("../hooks/loader"),
      actions: await import("./scheduler-actions"),
      registry: await import("../../generated/app-registry"),
      hookLoaders: await import("../../generated/app-hook-loaders"),
      routeLoaders: await import("../../generated/app-route-loaders"),
      jobLoaders: await import("../../generated/app-job-loaders"),
      syncLoaders: await import("../../generated/app-sync-loaders"),
      serviceLoaders: await import("../../generated/app-service-loaders"),
      db: await import("../db/client"),
    };
    platform.registry.appRegistry.push(gated, caller);
    platform.hookLoaders.hookLoaders[GATED] = () => import(`@apps/${GATED}/hooks`);
    // What `npm run registry` writes for the fixture's routes, which the
    // gateway and callAppRoute load through.
    for (const route of GATED_ROUTES) {
      platform.routeLoaders.routeLoaders[`${GATED}/api/${route}/route`] = () =>
        import(`@apps/${GATED}/api/${route}/route`);
    }
    // And for its job, sync and service, which the scheduler and the services
    // broker load through.
    for (const handler of GATED_HANDLERS) {
      handlerMap(handler)[`${GATED}/${handler}`] = () => import(`@apps/${GATED}/${handler}`);
    }
  });

  after(async () => {
    try {
      if (platform) {
        const registry = platform.registry.appRegistry;
        for (const slug of [GATED, CALLER]) {
          const at = registry.findIndex((a) => a.slug === slug);
          if (at >= 0) registry.splice(at, 1);
        }
        delete platform.hookLoaders.hookLoaders[GATED];
        for (const route of GATED_ROUTES) {
          delete platform.routeLoaders.routeLoaders[`${GATED}/api/${route}/route`];
        }
        for (const handler of GATED_HANDLERS) delete handlerMap(handler)[`${GATED}/${handler}`];
        await platform.db.sql.end();
      }
      resolver?.deregister();
    } finally {
      await sql?.end();
      if (admin) {
        await admin.unsafe(`drop database if exists ${database} with (force)`);
        await admin.unsafe(`drop role if exists ${appRoleName(GATED)}`);
        await admin.end();
      }
      if (work) fs.rmSync(work, { recursive: true, force: true });
    }
  });

  /** A request to the gated app's root route, on the public mount. */
  const dispatchRoot = () =>
    platform.dispatch.dispatchAppRoute({
      request: new Request(`http://localhost/api/p/${GATED}`),
      method: "GET",
      appSlug: GATED,
      segments: [],
      mount: "public",
    });

  const lookup = () =>
    platform.services
      .createServicesClient({ callerSlug: CALLER, actingUser: null })
      .request(GATED, "lookup", {});

  const ping = () => platform.loader.appRegistrar(GATED).doAction("ping");

  describe("while the app is switched off", () => {
    test("the gateway answers 404 and never imports the route", async () => {
      const res = await dispatchRoot();
      assert.equal(res.status, 404);
      assert.equal(imported("api/index/route.ts"), false);
    });

    test("callAppRoute refuses and never imports the route", async () => {
      await assert.rejects(platform.call.callAppRoute(GATED, "GET /items"), {
        name: "AppError",
        code: "NOT_FOUND",
        message: `"${GATED}" is not active.`,
      });
      assert.equal(imported("api/items/route.ts"), false);
    });

    test("the tick runs neither its job nor its sync", async () => {
      await quietly(() => platform.scheduler.runDueJobs());
      assert.equal(imported("jobs/tick.ts"), false);
      assert.equal(imported("sync/feed.ts"), false);
      assert.deepEqual(await claims(), []);
      assert.deepEqual(await runs("scheduled"), []);
    });

    test("Run now is refused by the claim itself, and imports nothing", async () => {
      const before = await jobRow("tick");
      assert.ok(before, "the tick did not seed the job's row");
      for (const job of ["tick", "sync:feed"]) {
        assert.deepEqual(await quietly(() => platform.scheduler.runJobNow(GATED, job)), {
          ran: false,
          reason: "app inactive",
        });
      }
      assert.equal(imported("jobs/tick.ts"), false);
      assert.equal(imported("sync/feed.ts"), false);
      // Never claimed, so the row is exactly as it was.
      assert.deepEqual(await claims(), []);
      assert.deepEqual(await jobRow("tick"), before);
      assert.deepEqual(await runs("manual"), []);
    });

    test("an audience: \"app\" service is refused with PROVIDER_INACTIVE, never imported", async () => {
      await assert.rejects(lookup(), {
        name: "ServiceRequestError",
        code: "PROVIDER_INACTIVE",
        message: `"${GATED}" is not active.`,
      });
      assert.equal(imported("services/lookup.ts"), false);
    });

    test("hooks.ts is not loaded, and so nothing it would register runs", async () => {
      await platform.loader.ensureHooksLoaded();
      await ping();
      assert.equal(imported("hooks.ts"), false);
      assert.equal(journal().includes("heard:ping"), false);
    });

    test("switched off after a job is claimed, the job is left unrun and still due", async () => {
      // A trigger switches the app off in the claim's own transaction: the
      // claim saw it active, and everything after the claim sees it off.
      await sql.unsafe(`
        create trigger gate_test_switch_off
          after update of running_since on public.app_scheduled_jobs
          for each row when (new.running_since is not null)
          execute function gate_test.switch_off()
      `);
      try {
        const before = { tick: await jobRow("tick"), feed: await jobRow("sync:feed") };
        let started = false;

        await setActive(true);
        const manual = await quietly(() =>
          platform.scheduler.runJobNow(GATED, "tick", {
            onStart: async () => {
              started = true;
            },
          }),
        );
        assert.deepEqual(manual, { ran: false, reason: "app inactive" });
        assert.equal(started, false, "onStart ran for a run that never started");

        await setActive(true);
        await quietly(() => platform.scheduler.runDueJobs());

        assert.ok((await claims()).length >= 2, "the scheduler never won a claim");
        assert.equal(imported("jobs/tick.ts"), false);
        assert.equal(imported("sync/feed.ts"), false);
        assert.deepEqual(await runs("scheduled"), []);
        assert.deepEqual(await runs("manual"), []);
        // Released, and due exactly as before.
        for (const [job, was] of [["tick", before.tick], ["sync:feed", before.feed]] as const) {
          const now = await jobRow(job);
          assert.equal(now?.running_since, null, `${job} was left claimed`);
          assert.deepEqual(now?.next_run_at, was?.next_run_at, `${job}'s next run moved`);
        }
      } finally {
        await sql.unsafe(`drop trigger gate_test_switch_off on public.app_scheduled_jobs`);
        await setActive(false);
      }
    });
  });

  describe("once it is switched on, with no restart", () => {
    before(() => setActive(true));

    test("the gateway imports and runs the route", async () => {
      const res = await dispatchRoot();
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { route: "index" });
      assert.equal(ran("api/index/route.ts"), 1);
    });

    test("callAppRoute imports and runs the route", async () => {
      assert.deepEqual(await platform.call.callAppRoute(GATED, "GET /items"), { route: "items" });
      assert.equal(ran("api/items/route.ts"), 1);
    });

    test("the tick runs its job and its sync, and Run now runs the job", async () => {
      await quietly(() => platform.scheduler.runDueJobs());
      assert.equal(ran("jobs/tick.ts"), 1);
      assert.equal(ran("sync/feed.ts"), 1);
      assert.deepEqual(
        (await runs("scheduled")).sort((a, b) => a.job_name.localeCompare(b.job_name)),
        [
          { job_name: "sync:feed", status: "ok" },
          { job_name: "tick", status: "ok" },
        ],
      );

      assert.deepEqual(await quietly(() => platform.scheduler.runJobNow(GATED, "tick")), {
        ran: true,
      });
      assert.equal(ran("jobs/tick.ts"), 2);
      assert.deepEqual(await runs("manual"), [{ job_name: "tick", status: "ok" }]);
    });

    test("the provider's service answers", async () => {
      assert.deepEqual(await lookup(), { from: "lookup" });
      assert.equal(ran("services/lookup.ts"), 1);
    });

    test("hooks.ts loads on the next dispatch, and the switch holds both ways", async () => {
      await ping();
      assert.equal(ran("hooks.ts"), 1, "the entrypoint did not run once");
      assert.equal(journal().filter((e) => e === "heard:ping").length, 1);

      await setActive(false);
      await ping();
      assert.equal(journal().filter((e) => e === "heard:ping").length, 1, "a switched-off app's listener ran");

      await setActive(true);
      await ping();
      assert.equal(journal().filter((e) => e === "heard:ping").length, 2);
      assert.equal(ran("hooks.ts"), 1, "the entrypoint ran again");
    });
  });

  describe("the Scheduled Jobs page's actions are audited", () => {
    let adminId: string;

    async function audited(action: string) {
      const rows = await sql`
        select actor_id, actor_email, target_type, target_id, details
        from public.admin_audit_log where action = ${action} order by created_at
      `;
      return rows.map((r) => ({ ...r }));
    }
    const form = (fields: Record<string, string>) => {
      const data = new FormData();
      for (const [key, value] of Object.entries(fields)) data.set(key, value);
      return data;
    };

    before(async () => {
      const [row] = await sql`
        insert into public.users (email, display_name, is_admin)
        values (${ADMIN_EMAIL}, 'Admin', true) returning id
      `;
      adminId = row.id;
      (globalThis as { __gateSession?: unknown }).__gateSession = {
        user: { id: adminId, email: ADMIN_EMAIL, name: "Admin", isAdmin: true },
      };
    });

    test("Run now on a switched-off app is refused, and records nothing", async () => {
      await setActive(false);
      try {
        const manualRuns = (await runs("manual")).length;
        await quietly(() => platform.actions.runJobNowAction(form({ appSlug: GATED, jobName: "tick" })));
        assert.equal((await runs("manual")).length, manualRuns);
        assert.deepEqual(await audited("app.job.run"), []);
      } finally {
        await setActive(true);
      }
    });

    test("Run now records who ran which job", async () => {
      await quietly(() => platform.actions.runJobNowAction(form({ appSlug: GATED, jobName: "tick" })));
      assert.deepEqual(await audited("app.job.run"), [
        {
          actor_id: adminId,
          actor_email: ADMIN_EMAIL,
          target_type: "app",
          target_id: GATED,
          details: { job: "tick" },
        },
      ]);
    });

    test("Disable and Enable are each recorded", async () => {
      const toggle = (enabled: boolean) =>
        platform.actions.setJobEnabledAction(
          form({ appSlug: GATED, jobName: "tick", enabled: String(enabled) }),
        );
      const entry = {
        actor_id: adminId,
        actor_email: ADMIN_EMAIL,
        target_type: "app",
        target_id: GATED,
        details: { job: "tick" },
      };

      await toggle(false);
      const [disabled] = await sql`
        select enabled from public.app_scheduled_jobs where app_slug = ${GATED} and job_name = 'tick'
      `;
      assert.equal(disabled.enabled, false);
      assert.deepEqual(await audited("app.job.disable"), [entry]);

      await toggle(true);
      assert.deepEqual(await audited("app.job.enable"), [entry]);
    });

    test("Stop tick and Start tick are each recorded", async () => {
      const entry = {
        actor_id: adminId,
        actor_email: ADMIN_EMAIL,
        target_type: null,
        target_id: null,
        details: {},
      };

      await platform.actions.setSchedulerEnabledAction(form({ enabled: "false" }));
      assert.equal(await platform.scheduler.getSchedulerEnabled(), false);
      assert.deepEqual(await audited("scheduler.stop"), [entry]);

      await platform.actions.setSchedulerEnabledAction(form({ enabled: "true" }));
      assert.equal(await platform.scheduler.getSchedulerEnabled(), true);
      assert.deepEqual(await audited("scheduler.start"), [entry]);
    });
  });
});
