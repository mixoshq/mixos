/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One app's own migrations behind, against a real Postgres. The app runs none
 * of its code, through any door, and says "This app is being updated" in each
 * door's terms while another app keeps working. Switched off, it answers as a
 * switched-off app always has. A check that can't tell lets it run. Once the
 * release step has applied its migration, it serves again with no restart.
 *
 * Behind for real: the release step applies the app's migration, then the
 * test deletes the ledger row and drops the table it made. "This build" is the
 * generated `EXPECTED_APP_MIGRATIONS`, which the test extends with the
 * fixture's file, as the registry generator would for an app in the build.
 *
 * Every fixture module records at its top level that it was imported, and each
 * handler records that it ran, as in `app-gate.integration.test.ts`, so "never
 * imported" is read rather than inferred from a status code. A module is
 * imported at most once per process, so every test of the app being updated
 * runs before the first that lets it run.
 *
 * The answer to "is it behind" is kept for 15 seconds, so the test forgets it
 * where the database changes underneath, rather than waiting.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database and roles on. Every name it creates ends in this run's own
 * suffix, and it drops them all when it finishes:
 *
 *   docker run -d --name upd -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test src/lib/apps/app-maintenance.integration.test.ts
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ReactElement } from "react";
import postgres, { type Sql } from "postgres";
import { NextRequest } from "next/server";
import { appRoleName, appSchemaName } from "./app-identifiers";
import type { AppManifest, RouteMethodContract } from "./types";

const REPO = path.resolve(__dirname, "..", "..", "..");
const serverUrl = process.env.MIXOS_TEST_DATABASE_URL;
const skip = serverUrl ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres";

// Roles belong to the server, not to a database, so every name is this run's.
const run = randomBytes(3).toString("hex");
const database = `mixos_upd_${run}`;
const UPDATING = `upd-${run}`;
const OTHER = `other-${run}`;
const MIGRATION = "0001_items.sql";
const USER_EMAIL = `user-${run}@example.com`;

const MESSAGE = "This app is being updated. Try again shortly.";

/** Made in `before`, so a skipped run leaves nothing behind. */
let work: string;
let appsDir: string;

// ── what the fixtures record ────────────────────────────────────────────────

function journal(): string[] {
  return ((globalThis as { __updJournal?: string[] }).__updJournal ??= []);
}
const imported = (slug: string, file: string) => journal().includes(`imported:${slug}/${file}`);
const ran = (slug: string, file: string) =>
  journal().filter((e) => e === `ran:${slug}/${file}`).length;
const heard = () => journal().filter((e) => e === "heard:ping").length;
/** Everything the updating app's code has done. */
const updatingDid = () => journal().filter((e) => e.includes(`:${UPDATING}/`));

/** A module that records its import, with `ran()` to record each call. */
function fixture(slug: string, file: string, body: string): void {
  const full = path.join(appsDir, slug, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const tag = `${slug}/${file}`;
  fs.writeFileSync(
    full,
    `const journal = ((globalThis as { __updJournal?: string[] }).__updJournal ??= []);\n` +
      `journal.push(${JSON.stringify(`imported:${tag}`)});\n` +
      `const ran = () => journal.push(${JSON.stringify(`ran:${tag}`)});\n` +
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

/** A tool: a default handler and an `inputSchema` the broker can parse with. */
const tool = `
export const inputSchema = { safeParse: (data: unknown) => ({ success: true, data }) };
export default async function peek() { ran(); return { from: "peek" }; }
`;

const page = `export default function Page() { ran(); return null; }\n`;

function writeFixtures(): void {
  for (const [slug, name] of [[UPDATING, "Updating"], [OTHER, "Other"]]) {
    fs.mkdirSync(path.join(appsDir, slug), { recursive: true });
    fs.writeFileSync(path.join(appsDir, slug, "app.json"), `{ "name": "${name}" }\n`);
    fixture(slug, "api/index/route.ts", route("index"));
    fixture(slug, "jobs/tick.ts", `export default async function tick() { ran(); }\n`);
    fixture(slug, "mcp/peek.ts", tool);
    fixture(slug, "pages/Main.ts", page);
  }
  fs.mkdirSync(path.join(appsDir, UPDATING, "migrations"), { recursive: true });
  fs.writeFileSync(
    path.join(appsDir, UPDATING, "migrations", MIGRATION),
    "create table items (id int primary key);\n",
  );
  fixture(UPDATING, "api/items/route.ts", route("items"));
  fixture(
    UPDATING,
    "sync/feed.ts",
    `export default {
  brand: Symbol.for("mixos.sync.definition"),
  fetchPage: async () => { ran(); return { items: [] }; },
  upsert: async () => {},
};
`,
  );
  fixture(
    UPDATING,
    "services/lookup.ts",
    `export default async function lookup() { ran(); return { from: "lookup" }; }\n`,
  );
  fixture(
    UPDATING,
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
    hasPages: true,
    pageCount: 1,
    // Open on /p, and on /apps for anyone holding the app, which a global app
    // is held by everyone.
    pageVisibility: { "": ["public"] },
    global: true,
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
    routes: [{ path: "", params: [], methods: [publicGet] }],
    widgets: [],
    schedules: [{ name: "tick", everyMinutes: 60 }],
    telemetry: [],
    provides: [],
    consumes: [],
    emits: [],
    listensTo: [],
    branding: null,
    mcp: [{ name: "peek", description: "Peek.", sources: ["mixos"] }],
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

const updating = manifest(UPDATING, "Updating", {
  database: true,
  routes: [
    { path: "", params: [], methods: [publicGet] },
    { path: "items", params: [], methods: [publicGet] },
  ],
  sync: [
    {
      name: "feed",
      schedule: { everyMinutes: 60 },
      source: "fixture",
      window: { coldStartDays: 1, defaultDays: 1, minDays: 1 },
      budgetMs: 10_000,
    },
  ],
  provides: [{ name: "lookup", audience: "app", consumers: [OTHER] }],
});
const other = manifest(OTHER, "Other", {
  consumes: [{ app: UPDATING, service: "lookup" }],
});

// ── stand-ins for what needs a Next request ─────────────────────────────────

const STUBS = new Map<string, string>([
  [
    "@/lib/auth/session",
    `export async function getReadOnlySession() { return null; }
export async function requireReadOnlySession() {
  const session = (globalThis as { __updSession?: unknown }).__updSession;
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

/** The runner and the scheduler report every step; the tests read the database instead. */
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

/** What `fn` wrote to `console.error`, one string per call. */
async function errorsDuring(fn: () => Promise<unknown>): Promise<string[]> {
  const { error } = console;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.error = error;
  }
  return lines;
}

/**
 * Drop every kept answer to "is the database behind", so the next request
 * reads the ledger. They live on globalThis (`src/lib/platform/maintenance.ts`
 * and `./schema-version.ts`). Called only once every read has finished.
 */
function forgetMaintenanceAnswers(): void {
  const g = globalThis as {
    __maintenanceState?: { kept?: unknown };
    __appMigrationCache?: unknown;
    __schemaVersionCache?: unknown;
  };
  delete g.__appMigrationCache;
  delete g.__schemaVersionCache;
  if (g.__maintenanceState) delete g.__maintenanceState.kept;
}

/** The digest Next's `notFound()` and `redirect()` throw with. */
function digestOf(err: unknown): string {
  return String((err as { digest?: unknown })?.digest ?? "");
}

describe("an app whose own migrations are behind", { skip }, () => {
  let admin: Sql;
  let sql: Sql;
  let userId: string;
  let resolver: ReturnType<typeof registerHooks> | undefined;
  let platform: {
    gate: typeof import("./app-gate");
    dispatch: typeof import("./dispatch");
    call: typeof import("./call");
    errors: typeof import("./errors");
    scheduler: typeof import("./scheduler");
    services: typeof import("./services");
    loader: typeof import("../hooks/loader");
    broker: typeof import("../mcp/broker");
    tools: typeof import("../mcp/tools");
    proxy: typeof import("../../proxy");
    appPage: typeof import("../../app/(main)/apps/[appSlug]/[[...path]]/page");
    publicPage: typeof import("../../app/(public)/p/[appSlug]/[[...path]]/page");
    appUpdating: typeof import("../../components/apps/app-updating");
    registry: typeof import("../../generated/app-registry");
    hookLoaders: typeof import("../../generated/app-hook-loaders");
    pageLoaders: typeof import("../../generated/app-page-loaders");
    buildInfo: typeof import("../../generated/build-info");
    db: typeof import("../db/client");
  };

  const setActive = (slug: string, on: boolean) =>
    sql`update public.apps set is_active = ${on} where slug = ${slug}`;

  /** What the release step does for the app; then the next request reads the ledger. */
  async function releaseStep() {
    const { migrateAppSchemas } = await import("../../../scripts/app-migrations");
    await quietly(() => migrateAppSchemas(sql, { apps: [updating, other], appsDir }));
    forgetMaintenanceAnswers();
  }

  async function jobRow(slug: string, job: string) {
    const [row] = await sql`
      select running_since, next_run_at from public.app_scheduled_jobs
      where app_slug = ${slug} and job_name = ${job}
    `;
    return row ? { ...row } : undefined;
  }
  async function runs(slug: string) {
    const rows = await sql`
      select job_name, status, trigger from public.app_job_runs
      where app_slug = ${slug} order by started_at
    `;
    return rows.map((r) => ({ ...r }));
  }
  /** Each claim the scheduler wins, logged by a trigger this test installs. */
  async function claims(slug: string) {
    const rows = await sql`select job_name from upd_test.claims where app_slug = ${slug}`;
    return rows.map((r) => r.job_name as string);
  }

  before(async () => {
    admin = postgres(serverUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${database}`);
    const u = new URL(serverUrl!);
    u.pathname = `/${database}`;
    const url = u.toString();
    sql = postgres(url, { max: 1, onnotice: () => {} });
    work = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-app-maintenance-"));
    appsDir = path.join(work, "apps");

    const { migratePlatform } = await import("../../../scripts/platform-migrations");
    await quietly(() => migratePlatform(sql, path.join(REPO, "supabase", "migrations")));
    writeFixtures();
    // New apps arrive inactive. The other app is switched on now; the one
    // being updated stays off until the tests of a switched-off app are done.
    await releaseStep();
    await setActive(OTHER, true);
    // Every MCP tool starts off. What is tested here is the
    // app gate, so both apps' tools are switched on, as an admin would.
    await sql`
      insert into public.app_mcp_tool_settings (app_slug, tool_name, enabled)
      values (${UPDATING}, 'peek', true), (${OTHER}, 'peek', true)
    `;

    // Behind for real: the ledger lacks the file, and its table is gone.
    await sql`delete from public._migrations where app_slug = ${UPDATING}`;
    await sql.unsafe(`drop table ${appSchemaName(UPDATING)}.items`);

    const [user] = await sql`
      insert into public.users (email, display_name) values (${USER_EMAIL}, 'User') returning id
    `;
    userId = user.id;
    (globalThis as { __updSession?: unknown }).__updSession = {
      user: { id: userId, email: USER_EMAIL, name: "User", isAdmin: false },
    };

    await sql.unsafe(`
      create schema upd_test;
      create table upd_test.claims (app_slug text not null, job_name text not null);
      create function upd_test.log_claim() returns trigger language plpgsql as $$
      begin
        insert into upd_test.claims values (new.app_slug, new.job_name);
        return null;
      end $$;
      create trigger upd_test_log_claim
        after update of running_since on public.app_scheduled_jobs
        for each row when (old.running_since is null and new.running_since is not null)
        execute function upd_test.log_claim();
    `);

    const stubs = writeStubs();
    const prefixes = [UPDATING, OTHER].map((slug) => [`@apps/${slug}/`, slug] as const);
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
      gate: await import("./app-gate"),
      dispatch: await import("./dispatch"),
      call: await import("./call"),
      errors: await import("./errors"),
      scheduler: await import("./scheduler"),
      services: await import("./services"),
      loader: await import("../hooks/loader"),
      broker: await import("../mcp/broker"),
      tools: await import("../mcp/tools"),
      proxy: await import("../../proxy"),
      appPage: await import("../../app/(main)/apps/[appSlug]/[[...path]]/page"),
      publicPage: await import("../../app/(public)/p/[appSlug]/[[...path]]/page"),
      appUpdating: await import("../../components/apps/app-updating"),
      registry: await import("../../generated/app-registry"),
      hookLoaders: await import("../../generated/app-hook-loaders"),
      pageLoaders: await import("../../generated/app-page-loaders"),
      buildInfo: await import("../../generated/build-info"),
      db: await import("../db/client"),
    };
    platform.registry.appRegistry.push(updating, other);
    platform.hookLoaders.hookLoaders[UPDATING] = () => import(`@apps/${UPDATING}/hooks`);
    for (const slug of [UPDATING, OTHER]) {
      platform.pageLoaders.pageLoaders[`${slug}/pages/Main`] = () => import(`@apps/${slug}/pages/Main`);
    }
    (platform.buildInfo.EXPECTED_APP_MIGRATIONS as { slug: string; file: string }[]).push({
      slug: UPDATING,
      file: MIGRATION,
    });
    // The first answer, read now so the line it logs stays out of the output.
    // The log has a test of its own.
    await errorsDuring(() => platform.gate.checkAppGate(OTHER));
  });

  after(async () => {
    try {
      if (platform) {
        const registry = platform.registry.appRegistry;
        for (const slug of [UPDATING, OTHER]) {
          const at = registry.findIndex((a) => a.slug === slug);
          if (at >= 0) registry.splice(at, 1);
          delete platform.pageLoaders.pageLoaders[`${slug}/pages/Main`];
        }
        delete platform.hookLoaders.hookLoaders[UPDATING];
        const expected = platform.buildInfo.EXPECTED_APP_MIGRATIONS as { slug: string; file: string }[];
        const at = expected.findIndex((m) => m.slug === UPDATING);
        if (at >= 0) expected.splice(at, 1);
        await platform.db.sql.end();
      }
      resolver?.deregister();
    } finally {
      await sql?.end();
      if (admin) {
        await admin.unsafe(`drop database if exists ${database} with (force)`);
        await admin.unsafe(`drop role if exists ${appRoleName(UPDATING)}`);
        await admin.end();
      }
      if (work) fs.rmSync(work, { recursive: true, force: true });
    }
  });

  // ── the doors ─────────────────────────────────────────────────────────────

  /** A request to an app's root route, on the public mount. */
  const dispatchRoot = (slug: string) =>
    platform.dispatch.dispatchAppRoute({
      request: new Request(`http://localhost/api/p/${slug}`),
      method: "GET",
      appSlug: slug,
      segments: [],
      mount: "public",
    });

  const lookup = () =>
    platform.services
      .createServicesClient({ callerSlug: OTHER, actingUser: null })
      .request(UPDATING, "lookup", {});

  const ping = () => platform.loader.appRegistrar(UPDATING).doAction("ping");

  const principal = () => ({
    userId,
    clientId: `client-${run}`,
    clientName: "Test client",
    grantedApps: [UPDATING, OTHER],
  });
  const callTool = (slug: string) =>
    platform.broker.callTool(principal(), `${slug}__peek`, {});
  const listed = async () =>
    (await platform.tools.reachableApps(userId, [UPDATING, OTHER])).map((a) => a.slug);

  /** The proxy, for a page; signed in means a session cookie, as the browser sends. */
  const proxy = (pathname: string, { signedIn = false } = {}) =>
    platform.proxy.default(
      new NextRequest(`http://localhost${pathname}`, {
        headers: signedIn ? { cookie: "authjs.session-token=present" } : {},
      }),
    );
  /** The proxy let the request through to the page. */
  const passed = (res: Response) => res.headers.get("x-middleware-next") === "1";

  const appPage = (slug: string, path: string[] = []) =>
    platform.appPage.default({ params: Promise.resolve({ appSlug: slug, path }) });
  const publicPage = (slug: string) =>
    platform.publicPage.default({ params: Promise.resolve({ appSlug: slug, path: [] }) });

  // ── switched off ──────────────────────────────────────────────────────────

  describe("switched off, it answers as a switched-off app always has", () => {
    test("the gate says inactive, whatever its migrations say", async () => {
      assert.deepEqual(await platform.gate.checkAppGate(UPDATING), {
        open: false,
        reason: "inactive",
      });
    });

    test("the gateway answers 404, callAppRoute NOT_FOUND, a consumer PROVIDER_INACTIVE", async () => {
      const res = await dispatchRoot(UPDATING);
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { error: "Not found", code: "NOT_FOUND" });

      await assert.rejects(platform.call.callAppRoute(UPDATING, "GET /items"), {
        name: "AppError",
        code: "NOT_FOUND",
        message: `"${UPDATING}" is not active.`,
      });
      await assert.rejects(lookup(), {
        name: "ServiceRequestError",
        code: "PROVIDER_INACTIVE",
        message: `"${UPDATING}" is not active.`,
      });
    });

    test("its pages: the proxy lets them through, and they answer 404 and the dashboard", async () => {
      assert.ok(passed(await proxy(`/p/${UPDATING}`)));
      assert.ok(passed(await proxy(`/apps/${UPDATING}`, { signedIn: true })));
      await assert.rejects(publicPage(UPDATING), (err) => digestOf(err).endsWith(";404"));
      await assert.rejects(appPage(UPDATING), (err) => digestOf(err).startsWith("NEXT_REDIRECT;"));
    });

    test("its MCP tools are refused as before, and not listed", async () => {
      await assert.rejects(callTool(UPDATING), {
        name: "McpToolError",
        code: "FORBIDDEN_USER",
        message: `You don't have access to "Updating".`,
      });
      assert.deepEqual(await listed(), [OTHER]);
    });

    test("the tick runs none of its jobs, and Run now says the app is inactive", async () => {
      await quietly(() => platform.scheduler.runDueJobs());
      assert.deepEqual(await claims(UPDATING), []);
      assert.deepEqual(
        await quietly(() => platform.scheduler.runJobNow(UPDATING, "tick")),
        { ran: false, reason: "app inactive" },
      );
    });

    test("none of its code was imported", () => {
      assert.deepEqual(updatingDid(), []);
    });
  });

  // ── switched on, behind ───────────────────────────────────────────────────

  describe("switched on, it is being updated", () => {
    before(() => setActive(UPDATING, true));

    test("the gate says updating, and the other app is open", async () => {
      assert.deepEqual(await platform.gate.checkAppGate(UPDATING), {
        open: false,
        reason: "updating",
      });
      assert.deepEqual(await platform.gate.checkAppGate(OTHER), { open: true });
    });

    test("the log names the app and the pending file, once per refresh", async () => {
      forgetMaintenanceAnswers();
      const lines = (
        await errorsDuring(async () => {
          for (let i = 0; i < 3; i++) await platform.gate.checkAppGate(UPDATING);
          await dispatchRoot(UPDATING);
        })
      ).filter((line) => line.startsWith(`Serving "being updated"`));
      assert.equal(lines.length, 1, lines.join("\n"));
      assert.ok(lines[0].includes(UPDATING));
      assert.ok(lines[0].includes(`apps/${UPDATING}/migrations/${MIGRATION}`));
    });

    test("the gateway answers 503 with Retry-After, on either mount, and names no file", async () => {
      for (const mount of ["public", "authenticated"] as const) {
        const res = await platform.dispatch.dispatchAppRoute({
          request: new Request(`http://localhost/api/apps/${UPDATING}`),
          method: "GET",
          appSlug: UPDATING,
          segments: [],
          mount,
        });
        assert.equal(res.status, 503, mount);
        assert.equal(res.headers.get("retry-after"), "30", mount);
        assert.equal(res.headers.get("cache-control"), "no-store", mount);
        const text = await res.text();
        assert.deepEqual(JSON.parse(text), { error: MESSAGE, code: "UNAVAILABLE" }, mount);
        assert.doesNotMatch(text, /\d|migration|\.sql/i, mount);
      }
    });

    test("callAppRoute throws an AppError that is a 503, with the message", async () => {
      await assert.rejects(platform.call.callAppRoute(UPDATING, "GET /items"), (err) => {
        assert.ok(err instanceof platform.errors.AppError);
        assert.equal(err.code, "UNAVAILABLE");
        assert.equal(err.message, MESSAGE);
        assert.equal(platform.errors.statusForAppErrorCode(err.code), 503);
        return true;
      });
    });

    test("its pages answer 503 from the proxy; the signed-out still go to sign-in", async () => {
      for (const res of [
        await proxy(`/p/${UPDATING}`),
        await proxy(`/apps/${UPDATING}`, { signedIn: true }),
      ]) {
        assert.equal(res.status, 503);
        assert.equal(res.headers.get("retry-after"), "30");
        assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
        const body = await res.text();
        assert.ok(body.includes(MESSAGE));
        assert.doesNotMatch(body.replace(/<\/?h1>/g, ""), /\d/);
      }

      const signedOut = await proxy(`/apps/${UPDATING}`);
      assert.equal(signedOut.status, 307);
      assert.equal(new URL(signedOut.headers.get("location")!).pathname, "/login");
      // A page the manifest doesn't open on /p is left to its route's 404.
      assert.ok(passed(await proxy(`/p/${UPDATING}/admin`)));
    });

    test("a page that is reached anyway shows the notice and loads nothing", async () => {
      const { default: AppUpdating } = platform.appUpdating;
      const signedIn = (await appPage(UPDATING)) as ReactElement;
      assert.equal(signedIn.type, AppUpdating);
      const shown = (await publicPage(UPDATING)) as ReactElement<{ fullScreen?: boolean }>;
      assert.equal(shown.type, AppUpdating);
      assert.equal(shown.props.fullScreen, true);
      // A page the app doesn't have is still a 404.
      await assert.rejects(appPage(UPDATING, ["missing"]), (err) => digestOf(err).endsWith(";404"));
    });

    test("a consumer gets PROVIDER_UPDATING, a 503 if it lets it escape", async () => {
      await assert.rejects(lookup(), (err) => {
        assert.ok(err instanceof platform.services.ServiceRequestError);
        assert.equal(err.code, "PROVIDER_UPDATING");
        assert.equal(err.message, `"${UPDATING}" is being updated. Try again shortly.`);
        assert.equal(platform.errors.statusForServiceErrorCode(err.code), 503);
        assert.equal(platform.errors.toErrorResponse(err, "failed").status, 503);
        return true;
      });
    });

    test("its MCP tools refuse with the message, and are not listed", async () => {
      await assert.rejects(callTool(UPDATING), {
        name: "McpToolError",
        code: "APP_UPDATING",
        message: MESSAGE,
      });
      assert.deepEqual(await listed(), [OTHER]);
    });

    test("hooks.ts is not loaded, so nothing it would register runs", async () => {
      await platform.loader.ensureHooksLoaded();
      await ping();
      assert.equal(heard(), 0);
    });

    test("the tick leaves its job and its sync unrun and still due", async () => {
      const before = {
        tick: await jobRow(UPDATING, "tick"),
        feed: await jobRow(UPDATING, "sync:feed"),
      };
      assert.ok(before.tick && before.feed, "the first tick did not seed the jobs' rows");

      await quietly(() => platform.scheduler.runDueJobs());

      // Claimed, refused by the gate, and released without moving.
      assert.deepEqual((await claims(UPDATING)).sort(), ["sync:feed", "tick"]);
      assert.deepEqual(await runs(UPDATING), []);
      for (const [job, was] of [["tick", before.tick], ["sync:feed", before.feed]] as const) {
        const now = await jobRow(UPDATING, job);
        assert.equal(now?.running_since, null, `${job} was left claimed`);
        assert.deepEqual(now?.next_run_at, was.next_run_at, `${job}'s next run moved`);
      }

      let started = false;
      assert.deepEqual(
        await quietly(() =>
          platform.scheduler.runJobNow(UPDATING, "tick", {
            onStart: async () => {
              started = true;
            },
          }),
        ),
        { ran: false, reason: "app updating" },
      );
      assert.equal(started, false, "Run now started a run it refused");
      assert.deepEqual(await runs(UPDATING), []);
    });

    test("the other app keeps working, through every door", async () => {
      const res = await dispatchRoot(OTHER);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { route: "index" });
      assert.deepEqual(await platform.call.callAppRoute(OTHER, "GET /"), { route: "index" });

      assert.ok(passed(await proxy(`/p/${OTHER}`)));
      assert.ok(passed(await proxy(`/apps/${OTHER}`, { signedIn: true })));
      const shown = (await publicPage(OTHER)) as ReactElement;
      assert.notEqual(shown.type, platform.appUpdating.default);
      await appPage(OTHER);
      assert.ok(imported(OTHER, "pages/Main.ts"));

      assert.deepEqual(await callTool(OTHER), { from: "peek" });
      assert.deepEqual(
        await quietly(() => platform.scheduler.runJobNow(OTHER, "tick")),
        { ran: true },
      );
      assert.ok(ran(OTHER, "jobs/tick.ts") >= 1);
      assert.ok(ran(OTHER, "api/index/route.ts") >= 2);
    });

    test("none of its code was imported", () => {
      assert.deepEqual(updatingDid(), []);
    });
  });

  // ── can't tell ────────────────────────────────────────────────────────────

  describe("a check that can't tell lets it run", () => {
    before(async () => {
      // A query that fails for a reason other than a missing table: "can't
      // tell", not "behind", as readiness reads it.
      await sql`alter table public._migrations rename column migration_file to migration_file_hidden`;
      forgetMaintenanceAnswers();
    });
    after(async () => {
      await sql`alter table public._migrations rename column migration_file_hidden to migration_file`;
      forgetMaintenanceAnswers();
    });

    test("the gateway runs its route", async () => {
      assert.deepEqual(await platform.gate.checkAppGate(UPDATING), { open: true });
      const res = await dispatchRoot(UPDATING);
      assert.equal(res.status, 200);
      assert.equal(ran(UPDATING, "api/index/route.ts"), 1);
    });
  });

  // ── after the release step ────────────────────────────────────────────────

  describe("once the release step has run, it serves again with no restart", () => {
    before(async () => {
      // Behind again, as the can't-tell test found it...
      let gate: Awaited<ReturnType<typeof platform.gate.checkAppGate>> | undefined;
      await errorsDuring(async () => {
        gate = await platform.gate.checkAppGate(UPDATING);
      });
      assert.deepEqual(gate, { open: false, reason: "updating" });
      // ...until the release step applies the migration.
      await releaseStep();
    });

    test("the gate is open, and readiness's check finds nothing pending", async () => {
      assert.deepEqual(await platform.gate.checkAppGate(UPDATING), { open: true });
      const [row] = await sql`
        select 1 from public._migrations where app_slug = ${UPDATING} and migration_file = ${MIGRATION}
      `;
      assert.ok(row, "the release step did not record the migration");
    });

    test("the gateway and callAppRoute run its routes", async () => {
      const res = await dispatchRoot(UPDATING);
      assert.equal(res.status, 200);
      assert.deepEqual(await platform.call.callAppRoute(UPDATING, "GET /items"), { route: "items" });
      assert.equal(ran(UPDATING, "api/items/route.ts"), 1);
    });

    test("its pages are served", async () => {
      assert.ok(passed(await proxy(`/p/${UPDATING}`)));
      assert.ok(passed(await proxy(`/apps/${UPDATING}`, { signedIn: true })));
      const shown = (await publicPage(UPDATING)) as ReactElement;
      assert.notEqual(shown.type, platform.appUpdating.default);
      assert.ok(imported(UPDATING, "pages/Main.ts"));
    });

    test("the tick runs the jobs it left due", async () => {
      await quietly(() => platform.scheduler.runDueJobs());
      assert.equal(ran(UPDATING, "jobs/tick.ts"), 1);
      assert.equal(ran(UPDATING, "sync/feed.ts"), 1);
      assert.deepEqual(
        (await runs(UPDATING)).map((r) => r.job_name).sort(),
        ["sync:feed", "tick"],
      );
    });

    test("its service, hooks and MCP tools answer", async () => {
      assert.deepEqual(await lookup(), { from: "lookup" });
      await ping();
      assert.equal(heard(), 1);
      assert.deepEqual(await callTool(UPDATING), { from: "peek" });
      assert.deepEqual((await listed()).sort(), [OTHER, UPDATING].sort());
    });
  });
});
