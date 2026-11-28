/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What `context` lets an app reach, against a real database and real context
 * builders: nothing it could change for anyone else, and nothing privileged.
 *
 *   - `context.manifest` is the registry's own entry, which the platform reads
 *     again for the app's egress, connectors and whether it is global. It
 *     can't be written to.
 *   - `context.user` is the object the services broker reads to say who is
 *     asking. It can't be written to, so an app can't ask another app's
 *     service as someone else.
 *   - A connector's decrypted credentials are on the instance, and the app
 *     holds a facade: no property, walk or inspection reaches them.
 *   - A census of everything reachable from each context, through own
 *     properties and prototypes, finds no pool, no registry array, no
 *     `process`, no connector instance and no secret.
 *
 * What it can't see is what a closure holds: that is the point of a closure.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database on:
 *
 *   docker run -d --rm --name reach -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55433:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55433/postgres \
 *     npx tsx --test src/lib/apps/context-reach.integration.test.ts
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { inspect } from "node:util";
import postgres, { type Sql } from "postgres";
import { migratePlatform } from "../../../scripts/platform-migrations";
import type { AppManifest } from "@/lib/apps/types";
import type { ConnectorManifest } from "@/lib/connectors/types";

const REPO = path.resolve(__dirname, "../../..");
const serverUrl = process.env.MIXOS_TEST_DATABASE_URL;
const skip = serverUrl ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres";

const run = randomBytes(3).toString("hex");
const database = `mixos_reach_${run}`;

/** The API-key template under connectors/, registered for this run only. */
const KEYED = "_template";
const SECRET = `sk-live-${run}-do-not-leak`;
const CALLER = `caller-${run}`;
const PROVIDER = `provider-${run}`;

async function loadPlatform() {
  return {
    ...(await import("@/generated/connector-registry")),
    ...(await import("@/generated/connector-loaders")),
    ...(await import("@/generated/app-registry")),
    ...(await import("@/generated/app-service-loaders")),
    ...(await import("@/lib/connectors/config")),
    ...(await import("@/lib/connectors/http-connector")),
    ...(await import("@/lib/apps/access")),
    ...(await import("./context")),
    ...(await import("./read-only-context")),
    platformSql: (await import("@/lib/db/client")).sql,
  };
}

/** Silence the logs a context build writes on purpose, for the length of `fn`. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, { log, warn, error });
  }
}

const manifestOf = (name: string): ConnectorManifest => ({
  ...(JSON.parse(fs.readFileSync(path.join(REPO, "connectors", name, "connector.json"), "utf8")) as ConnectorManifest),
  name,
});

/** Try a write an app might attempt. Whether it throws is the frozen object's business. */
function attempt(write: () => void): void {
  try {
    write();
  } catch {
    // Refused: what the test then checks is that nothing changed.
  }
}

/**
 * Everything reachable from `root` through own data properties and
 * prototypes, the intrinsic prototypes left out. Getters are not run: the
 * walk is what any code holding the object could do without calling it.
 */
function reachable(root: unknown, maxDepth = 10): unknown[] {
  const intrinsic = new Set<unknown>([
    Object.prototype, Function.prototype, Array.prototype, Promise.prototype,
    Map.prototype, Set.prototype, WeakMap.prototype, WeakSet.prototype,
    Error.prototype, RegExp.prototype, Date.prototype, String.prototype,
    Number.prototype, Boolean.prototype, Symbol.prototype,
    Object.getPrototypeOf(async () => {}),
  ]);
  const seen = new Set<unknown>();
  const out: unknown[] = [];
  const walk = (value: unknown, depth: number) => {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) {
      out.push(value);
      return;
    }
    if (seen.has(value) || intrinsic.has(value) || depth > maxDepth) return;
    seen.add(value);
    out.push(value);
    for (const key of Reflect.ownKeys(value)) {
      const d = Reflect.getOwnPropertyDescriptor(value, key);
      if (d && "value" in d) walk(d.value, depth + 1);
    }
    walk(Reflect.getPrototypeOf(value), depth + 1);
  };
  walk(root, 0);
  return out;
}

describe("What context reaches", { skip }, () => {
  let admin: Sql;
  let sql: Sql;
  let p: Awaited<ReturnType<typeof loadPlatform>>;
  let alice: { id: string; email: string; display_name: string; is_admin: boolean };
  let bob: { id: string; email: string; display_name: string; is_admin: boolean };
  const seenByProvider: { id: string | null; isAdmin: boolean | null }[] = [];

  before(async () => {
    admin = postgres(serverUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${database}`);
    const u = new URL(serverUrl!);
    u.pathname = `/${database}`;
    sql = postgres(u.toString(), { max: 1, onnotice: () => {} });
    await quietly(() => migratePlatform(sql, path.join(REPO, "supabase", "migrations")));

    process.env.DATABASE_URL = u.toString();
    process.env.PGSSLMODE = u.searchParams.get("sslmode") ?? "disable";
    process.env.CONNECTOR_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    process.env.APP_SETTINGS_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    process.env.NEXTAUTH_URL = "https://mixos.test";
    p = await loadPlatform();

    p.connectorRegistry.push(manifestOf(KEYED));
    p.connectorLoaders[`${KEYED}/index`] = () => import("@connectors/_template/index");

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
    } as unknown as AppManifest;
    p.appRegistry.push(
      {
        ...shape,
        slug: CALLER,
        name: "Caller",
        global: false,
        database: true,
        egress: ["api.example.com"],
        connectors: [KEYED],
        connectorRequirements: [{ name: KEYED, optional: false, access: "read", version: "1.0.0" }],
        consumes: [{ app: PROVIDER, service: "whoami" }],
      } as unknown as AppManifest,
      {
        ...shape,
        slug: PROVIDER,
        name: "Provider",
        global: true,
        database: false,
        provides: [{ name: "whoami", audience: "user", consumers: [CALLER] }],
      } as unknown as AppManifest,
    );
    p.serviceLoaders[`${PROVIDER}/services/whoami`] = async () => ({
      default: async (ctx: { user: { id: string; isAdmin: boolean } | null }) => {
        seenByProvider.push({ id: ctx.user?.id ?? null, isAdmin: ctx.user?.isAdmin ?? null });
        return { ok: true };
      },
    });

    const users = await sql`
      insert into public.users (email, display_name, is_admin)
      values (${`alice-${run}@mixos.test`}, 'Alice', false), (${`bob-${run}@mixos.test`}, 'Bob', true)
      returning id, email, display_name, is_admin
    `;
    [alice, bob] = users.map((r) => ({ id: r.id, email: r.email, display_name: r.display_name, is_admin: r.is_admin }));
    await sql`
      insert into public.apps (slug, name, is_active, global)
      values (${CALLER}, 'Caller', true, false), (${PROVIDER}, 'Provider', true, true)
    `;
    await p.saveConnectorConfig(KEYED, { apiKey: SECRET }, bob.id);
  });

  after(async () => {
    if (p) {
      for (const slug of [CALLER, PROVIDER]) {
        const at = p.appRegistry.findIndex((a) => a.slug === slug);
        if (at >= 0) p.appRegistry.splice(at, 1);
      }
      const c = p.connectorRegistry.findIndex((m) => m.name === KEYED);
      if (c >= 0) p.connectorRegistry.splice(c, 1);
      delete p.serviceLoaders[`${PROVIDER}/services/whoami`];
      await p.platformSql.end();
    }
    await sql?.end();
    if (admin) {
      await admin.unsafe(`drop database if exists ${database} with (force)`);
      await admin.end();
    }
  });

  test("an app can't widen its own manifest: egress, connectors and global stay as reviewed", async () => {
    const ctx = await quietly(() => p.buildAppContext(CALLER, alice));
    const m = ctx.manifest as unknown as {
      egress: string[];
      connectors: string[];
      connectorRequirements: { name: string; access: string }[];
      global: boolean;
    };
    attempt(() => m.egress.push("evil.example.com"));
    attempt(() => m.connectors.push("other-connector"));
    attempt(() => {
      m.connectorRequirements[0].access = "write";
    });
    attempt(() => {
      m.global = true;
    });

    assert.deepEqual(m.egress, ["api.example.com"]);
    assert.deepEqual(m.connectors, [KEYED]);
    assert.equal(m.connectorRequirements[0].access, "read");
    assert.equal(p.isGlobalApp(CALLER), false);
    assert.equal(await p.hasAppGrant(bob.id, CALLER), false, "nobody holds it by a write");
    await assert.rejects(ctx.http!.fetch("https://evil.example.com/"), /not allowed to reach evil\.example\.com/);

    // And the next context, built from the same entry, is as declared.
    const next = await quietly(() => p.buildSystemAppContext(CALLER));
    assert.deepEqual(next.manifest.egress, ["api.example.com"]);
    assert.deepEqual(Object.keys(next.connectors), [KEYED]);
  });

  test("an app can't ask another app's service as someone else", async () => {
    const ctx = await quietly(() => p.buildAppContext(CALLER, alice));
    const user = ctx.user as unknown as { id: string; isAdmin: boolean; roles: string[] };
    attempt(() => {
      user.id = bob.id;
    });
    attempt(() => {
      user.isAdmin = true;
    });
    attempt(() => user.roles.push("owner"));
    assert.equal(user.id, alice.id);
    assert.equal(ctx.user.hasRole(["owner"]), false);

    seenByProvider.length = 0;
    await quietly(() => ctx.services!.request(PROVIDER, "whoami"));
    assert.deepEqual(seenByProvider, [{ id: alice.id, isAdmin: false }]);
  });

  test("a connector's credentials are out of reach on every context an app is handed", async () => {
    const contexts = {
      route: await quietly(() => p.buildAppContext(CALLER, alice)),
      public: await quietly(() => p.buildPublicAppContext(CALLER)),
      job: await quietly(() => p.buildSystemAppContext(CALLER)),
      mcp: await quietly(() => p.buildReadOnlyAppContext(CALLER, alice)),
    };
    for (const [surface, ctx] of Object.entries(contexts)) {
      const c = ctx.connectors[KEYED] as unknown as Record<string, unknown>;
      assert.ok(c, `${surface}: the connector is handed over`);
      assert.equal(c.configured, true, `${surface}: and configured`);
      assert.equal(c.credentials, undefined, `${surface}: credentials`);
      assert.doesNotMatch(JSON.stringify(ctx.connectors), new RegExp(SECRET), `${surface}: JSON`);
      assert.doesNotMatch(inspect(ctx.connectors, { showHidden: true, depth: 8 }), new RegExp(SECRET), `${surface}: inspect`);
    }
  });

  test("the census: nothing privileged is reachable from any context", async () => {
    const pool = (globalThis as { __pg?: unknown }).__pg;
    const contexts = {
      route: await quietly(() => p.buildAppContext(CALLER, alice)),
      public: await quietly(() => p.buildPublicAppContext(CALLER)),
      job: await quietly(() => p.buildSystemAppContext(CALLER)),
      mcp: await quietly(() => p.buildReadOnlyAppContext(CALLER, alice)),
    };
    for (const [surface, ctx] of Object.entries(contexts)) {
      const found = reachable(ctx);
      assert.ok(found.length > 20, `${surface}: the walk went somewhere`);
      for (const value of found) {
        assert.notEqual(value, p.platformSql, `${surface}: the platform's sql`);
        if (pool !== undefined) assert.notEqual(value, pool, `${surface}: the pool`);
        assert.notEqual(value, p.appRegistry, `${surface}: the registry array`);
        assert.notEqual(value, p.connectorRegistry, `${surface}: the connector registry`);
        assert.notEqual(value, process, `${surface}: process`);
        assert.notEqual(value, process.env, `${surface}: the environment`);
        assert.notEqual(value, globalThis, `${surface}: the global object`);
        assert.ok(!(value instanceof p.HttpConnector), `${surface}: a connector instance`);
        if (typeof value === "string") {
          assert.ok(!value.includes(SECRET), `${surface}: the connector's secret`);
          assert.notEqual(value, process.env.DATABASE_URL, `${surface}: the database URL`);
          assert.notEqual(value, process.env.CONNECTOR_ENCRYPTION_KEY, `${surface}: a key`);
        }
      }
      // Everything reachable that is an object or an array the platform reads
      // again is frozen: the manifest, to its leaves, and the user.
      assert.ok(Object.isFrozen(ctx.manifest), `${surface}: manifest`);
      if (ctx.user) assert.ok(Object.isFrozen(ctx.user) && Object.isFrozen(ctx.user.roles), `${surface}: user`);
    }
  });
});
