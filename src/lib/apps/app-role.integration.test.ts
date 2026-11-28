/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every way an app is handed `context.db` runs as the app's own role, against
 * a real database, the real context builders and a login that is not a
 * superuser:
 *
 *   - API routes, public routes and jobs: the app's role, read-write;
 *   - MCP tools and search (`buildReadOnlyAppContext`,
 *     `createReadOnlyScopedClient`): the app's role, read-only at the database;
 *   - App Services: the provider's role, read-only when an MCP tool asks;
 *   - a declared sync: the app's handlers write as the app, and the watermark
 *     is written by the platform, in a table the app's role can't reach;
 *   - `createSwrCache` works as the app.
 *
 * Each app has a `whoami` view, made here and not by a migration (the SQL
 * policy refuses `current_user` in app SQL), so the tests can ask the
 * database who a query ran as.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database and roles on:
 *
 *   docker run -d --rm --name approle -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55433:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55433/postgres \
 *     npx tsx --test src/lib/apps/app-role.integration.test.ts
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres, { type Sql } from "postgres";
import { migrateAppSchemas, type MigratedApp } from "../../../scripts/app-migrations";
import { migratePlatform } from "../../../scripts/platform-migrations";
import { appRoleName, appSchemaName } from "./app-identifiers";
import type { AppManifest, SyncDefinition } from "./types";

const REPO = path.resolve(__dirname, "../../..");
const serverUrl = process.env.MIXOS_TEST_DATABASE_URL;
const skip = serverUrl ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres";

const run = randomBytes(3).toString("hex");
const database = `mixos_approle_${run}`;
const owner = `mixos_approle_owner_${run}`;
const password = randomBytes(12).toString("hex");
const appsDir = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-app-role-"));

const CONSUMER = `consumer-${run}`;
const PROVIDER = `provider-${run}`;
const C = { schema: appSchemaName(CONSUMER), role: appRoleName(CONSUMER) };
const P = { schema: appSchemaName(PROVIDER), role: appRoleName(PROVIDER) };

const SYNC: SyncDefinition = {
  name: "items",
  schedule: { everyMinutes: 60 },
  source: "mixos",
  window: { coldStartDays: 3, defaultDays: 7, minDays: 1 },
  budgetMs: 10_000,
};

async function loadPlatform() {
  return {
    ...(await import("@/generated/app-registry")),
    ...(await import("@/generated/app-service-loaders")),
    ...(await import("./context")),
    ...(await import("./read-only-context")),
    ...(await import("./scoped-db")),
    ...(await import("./swr-cache")),
    ...(await import("./sync")),
    platformSql: (await import("@/lib/db/client")).sql,
  };
}

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, { log, warn, error });
  }
}

function migrated(slug: string, migration: string, extra: Partial<MigratedApp> = {}): MigratedApp {
  fs.mkdirSync(path.join(appsDir, slug, "migrations"), { recursive: true });
  fs.writeFileSync(path.join(appsDir, slug, "migrations", "001_init.sql"), migration);
  return { slug, name: slug, description: "", icon: "box", database: true, updatedAt: [], sync: [], ...extra };
}

type WhoAmI = { who: string; ro: string };
type Db = { table: (name: string) => { select: (columns: string) => PromiseLike<{ data: unknown; error: { code: string } | null }> } };

async function whoami(db: Db | null | undefined): Promise<WhoAmI> {
  assert.ok(db, "the context has a db");
  const { data, error } = await db.table("whoami").select("who, ro");
  assert.equal(error, null);
  return (data as WhoAmI[])[0];
}

describe("context.db runs as the app's own role", { skip }, () => {
  let admin: Sql;
  let sql: Sql;
  let p: Awaited<ReturnType<typeof loadPlatform>>;
  let alice: { id: string; email: string; display_name: string; is_admin: boolean };
  const seenByProvider: WhoAmI[] = [];

  before(async () => {
    admin = postgres(serverUrl!, { max: 1, onnotice: () => {} });
    const [{ superuser }] = await admin<{ superuser: boolean }[]>`
      select rolsuper as superuser from pg_roles where rolname = current_user
    `;
    await admin.unsafe(`create role ${owner} login createrole password '${password}'`);
    if (!superuser) await admin.unsafe(`grant ${owner} to current_user`);
    await admin.unsafe(`create database ${database} owner ${owner}`);

    const url = new URL(serverUrl!);
    url.username = owner;
    url.password = password;
    url.pathname = `/${database}`;
    sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
    await quietly(() => migratePlatform(sql, path.join(REPO, "supabase", "migrations")));
    await quietly(() =>
      migrateAppSchemas(sql, {
        apps: [
          migrated(
            CONSUMER,
            [
              "create table items (id int primary key, label text not null);",
              "create table swr_cache (",
              "  cache_key  text primary key,",
              "  payload    jsonb not null,",
              "  fetched_at timestamptz not null default now()",
              ");",
            ].join("\n"),
            { sync: [SYNC] },
          ),
          migrated(PROVIDER, "create table notes (id int primary key);"),
        ],
        appsDir,
      }),
    );
    for (const { schema, role } of [C, P]) {
      await sql.unsafe(
        `create view ${schema}.whoami as select current_user::text as who, current_setting('transaction_read_only') as ro`,
      );
      await sql.unsafe(`alter view ${schema}.whoami owner to ${role}`);
    }
    await sql`update public.apps set is_active = true where slug in (${CONSUMER}, ${PROVIDER})`;
    [alice] = (await sql`
      insert into public.users (email, display_name, is_admin)
      values (${`alice-${run}@mixos.test`}, 'Alice', true)
      returning id, email, display_name, is_admin
    `) as unknown as (typeof alice)[];

    process.env.DATABASE_URL = url.toString();
    process.env.PGSSLMODE = "disable";
    process.env.APP_SETTINGS_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    process.env.CONNECTOR_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    process.env.NEXTAUTH_URL = "https://mixos.test";
    p = await loadPlatform();

    const base = p.appRegistry[0];
    assert.ok(base, "the registry needs one app to copy a manifest shape from");
    const shape = {
      ...base,
      optionalConnectors: [],
      env: [],
      notifications: false,
      telemetry: [],
      provides: [],
      consumes: [],
      egress: [],
      connectors: [],
      connectorRequirements: [],
      sync: [],
      database: true,
      global: true,
    } as unknown as AppManifest;
    p.appRegistry.push(
      { ...shape, slug: CONSUMER, name: "Consumer", sync: [SYNC], consumes: [{ app: PROVIDER, service: "whoami" }] } as unknown as AppManifest,
      { ...shape, slug: PROVIDER, name: "Provider", provides: [{ name: "whoami", audience: "user", consumers: [CONSUMER] }] } as unknown as AppManifest,
    );
    p.serviceLoaders[`${PROVIDER}/services/whoami`] = async () => ({
      default: async (ctx: { db: Db | null }) => {
        seenByProvider.push(await whoami(ctx.db));
        return { ok: true };
      },
    });
  });

  after(async () => {
    if (p) {
      for (const slug of [CONSUMER, PROVIDER]) {
        const at = p.appRegistry.findIndex((a) => a.slug === slug);
        if (at >= 0) p.appRegistry.splice(at, 1);
      }
      delete p.serviceLoaders[`${PROVIDER}/services/whoami`];
      await p.platformSql.end();
    }
    await sql?.end();
    if (admin) {
      await admin.unsafe(`drop database if exists ${database} with (force)`);
      for (const r of [C.role, P.role, owner]) await admin.unsafe(`drop role if exists ${r}`);
      await admin.end();
    }
    fs.rmSync(appsDir, { recursive: true, force: true });
  });

  test("routes, public routes and jobs query as the app's role, read-write", async () => {
    const contexts = {
      route: await quietly(() => p.buildAppContext(CONSUMER, alice)),
      public: await quietly(() => p.buildPublicAppContext(CONSUMER)),
      job: await quietly(() => p.buildSystemAppContext(CONSUMER)),
    };
    for (const [surface, ctx] of Object.entries(contexts)) {
      assert.deepEqual(await whoami(ctx.db), { who: C.role, ro: "off" }, surface);
    }
    // The platform's own handle on the schema is the platform's login.
    assert.deepEqual(await whoami(p.createPlatformScopedClient(CONSUMER)), { who: owner, ro: "off" });
  });

  test("MCP tools and search query as the app's role, and the database refuses their writes", async () => {
    const mcp = await quietly(() => p.buildReadOnlyAppContext(CONSUMER, alice));
    assert.deepEqual(await whoami(mcp.db), { who: C.role, ro: "on" });
    // The search broker's client (src/lib/search/broker.ts).
    assert.deepEqual(await whoami(p.createReadOnlyScopedClient(CONSUMER)), { who: C.role, ro: "on" });
  });

  test("App Services run as the provider's role, and read-only when an MCP tool asks", async () => {
    seenByProvider.length = 0;
    const route = await quietly(() => p.buildAppContext(CONSUMER, alice));
    await quietly(() => route.services!.request(PROVIDER, "whoami"));
    const mcp = await quietly(() => p.buildReadOnlyAppContext(CONSUMER, alice));
    await quietly(() => mcp.services!.request(PROVIDER, "whoami"));
    assert.deepEqual(seenByProvider, [
      { who: P.role, ro: "off" },
      { who: P.role, ro: "on" },
    ]);
  });

  test("a sync writes the app's rows as the app, and its watermark as the platform", async () => {
    const ctx = await quietly(() => p.buildSystemAppContext(CONSUMER));
    const result = await p.runSync(
      ctx,
      SYNC,
      {
        fetchPage: async () => ({ items: [{ id: 1, label: "one" }] }),
        upsert: async (c, items) => {
          const { error } = await c.db!.table("items").upsert(items as Record<string, unknown>[]);
          assert.equal(error, null);
        },
      },
      p.createPlatformScopedClient(CONSUMER),
    );
    assert.equal(result.drained, true);
    assert.equal(result.items, 1);

    const [state] = await sql.unsafe(`select synced_through, last_status from ${C.schema}._sync_state where name = 'items'`);
    assert.equal(state.last_status, "ok");
    assert.ok(state.synced_through, "the watermark moved");

    // The app's own handle can't read or write the platform's bookkeeping.
    const read = await ctx.db!.table("_sync_state").select("*");
    assert.equal(read.error?.code, "42501");
    const write = await ctx.db!.table("_sync_state").upsert({ name: "items", synced_through: null }, { onConflict: "name" });
    assert.equal(write.error?.code, "42501");
  });

  test("createSwrCache builds, stores and serves as the app's role", async () => {
    const ctx = await quietly(() => p.buildAppContext(CONSUMER, alice));
    const cache = p.createSwrCache({ namespace: CONSUMER, userScoped: false });
    let builds = 0;
    const build = async () => ({ n: ++builds });
    const first = await cache.getCached(ctx.db, "k", build);
    const second = await cache.getCached(ctx.db, "k", build);
    assert.deepEqual([first.cached, second.cached, second.payload], [false, true, { n: 1 }]);
    const peeked = await cache.peekCached<{ n: number }>(p.createReadOnlyScopedClient(CONSUMER), "k");
    assert.deepEqual(peeked?.payload, { n: 1 });
    await cache.deleteCached(ctx.db, "k");
    assert.equal(await cache.peekCached(p.createReadOnlyScopedClient(CONSUMER), "k"), null);
  });
});
