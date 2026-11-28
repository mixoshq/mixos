/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Reach section's data, against a real database: calls made through an
 * app's real context arrive in `getObservedConnectorCalls` grouped by app and
 * method; a call the facade refused isn't there; the window is 30 days; and an
 * unreadable table answers "don't know", never "nothing". With the apps'
 * switches from `readAppActiveMap`, `connectorReach` says who can write.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database on. The database's name ends in this run's own suffix, and
 * it is dropped when the run finishes:
 *
 *   docker run -d --name reach -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test src/lib/connectors/reach.integration.test.ts
 *
 * The connector is the API-key template under connectors/, registered for this
 * run only, and the apps declaring it exist only in this process's registry.
 * Upstream calls go to a stubbed fetch, so nothing leaves the machine.
 */

import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import postgres, { type Sql } from "postgres";
import { migratePlatform } from "../../../scripts/platform-migrations";
import type { AppManifest } from "@/lib/apps/types";
import type { BaseConnector, ConnectorManifest } from "./types";

const REPO = path.resolve(__dirname, "../../..");
const serverUrl = process.env.MIXOS_TEST_DATABASE_URL;
const skip = serverUrl ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres";

const run = randomBytes(3).toString("hex");
const database = `mixos_reach_${run}`;

/** API key; `listItems` and `getItem` read, `createItem` changes data. */
const KEYED = "_template";
/** Another connector's calls, which KEYED's list must not hold. */
const OTHER = `other-${run}`;
const WRITER = `writer-${run}`;
const READER = `reader-${run}`;
/** Declares KEYED, and an admin switched it off. */
const IDLE = `idle-${run}`;

async function loadPlatform() {
  return {
    ...(await import("@/generated/connector-registry")),
    ...(await import("@/generated/connector-loaders")),
    ...(await import("@/generated/app-registry")),
    ...(await import("./config")),
    ...(await import("./observed")),
    ...(await import("./reach")),
    ...(await import("./writable-admin")),
    ...(await import("@/lib/apps/access")),
    ...(await import("@/lib/apps/context")),
    platformSql: (await import("@/lib/db/client")).sql,
  };
}

/** Silence the logs a refusal writes on purpose, for the length of `fn`. */
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

type Keyed = BaseConnector & {
  listItems(): Promise<unknown[]>;
  getItem(id: string): Promise<unknown>;
  createItem(data: Record<string, unknown>): Promise<unknown>;
};

const realFetch = globalThis.fetch;

describe("Reach", { skip }, () => {
  let admin: Sql;
  let sql: Sql;
  let p: Awaited<ReturnType<typeof loadPlatform>>;

  const connectorsOf = async (slug: string) =>
    (await quietly(() => p.buildSystemAppContext(slug))).connectors[KEYED] as Keyed;

  /** The calls are recorded fire-and-forget: wait until `n` have landed. */
  async function settled(n: number) {
    for (let i = 0; i < 100; i++) {
      const [{ count }] = await sql`
        select count(*)::int as count from public.telemetry_events where source_type = 'connector'
      `;
      if (count >= n) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.fail(`fewer than ${n} connector calls were recorded`);
  }

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
    process.env.NEXTAUTH_URL = "https://mixos.test";
    p = await loadPlatform();

    p.connectorRegistry.push(manifestOf(KEYED));
    p.connectorLoaders[`${KEYED}/index`] = () => import("@connectors/_template/index");
    const base = p.appRegistry[0];
    assert.ok(base, "the registry needs one app to copy a manifest shape from");
    const app = (slug: string, name: string, access: "read" | "write"): AppManifest =>
      ({
        ...base,
        slug,
        name,
        connectors: [KEYED],
        optionalConnectors: [],
        connectorRequirements: [{ name: KEYED, optional: false, access, version: "1.0.0" }],
        env: [],
        egress: [],
        database: false,
        notifications: false,
        consumes: [],
        telemetry: [],
      }) as AppManifest;
    p.appRegistry.push(app(WRITER, "Writer", "write"), app(READER, "Reader", "read"), app(IDLE, "Idle", "write"));

    await sql`
      insert into public.apps (slug, name, is_active)
      values (${WRITER}, 'Writer', true), (${READER}, 'Reader', true), (${IDLE}, 'Idle', false)
    `;
    const [user] = await sql`
      insert into public.users (email, display_name, is_admin)
      values (${`admin-${run}@mixos.test`}, 'Admin', true)
      returning id, email
    `;
    await p.saveConnectorConfig(KEYED, { apiKey: "key-1" }, user.id);
    await p.setConnectorChanges(KEYED, true, { id: user.id, email: user.email });
    // Allowed, then read-only again below, so the refused write is refused by Allow changes.
    await p.setConnectorChanges(KEYED, false, { id: user.id, email: user.email });

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (init?.method === "POST") return Response.json({ id: "2", name: "new" });
      if (/\/items\/[^/?]+/.test(url)) return Response.json({ id: "1", name: "old" });
      return Response.json({ data: [{ id: "1", name: "old" }], meta: {} });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  after(async () => {
    globalThis.fetch = realFetch;
    await p?.platformSql.end();
    await sql?.end();
    if (admin) {
      await admin.unsafe(`drop database if exists ${database} with (force)`);
      await admin.end();
    }
  });

  test("calls through an app's context are grouped by app and method; a refused write isn't there", async () => {
    const reader = await connectorsOf(READER);
    await reader.listItems();
    await reader.listItems();
    await reader.getItem("1");

    const writer = await connectorsOf(WRITER);
    await writer.listItems();
    // Read-only: the facade refuses it before the connector is called, so nothing records it.
    await assert.rejects(
      async () => writer.createItem({ name: "x" }),
      (err: { category?: string; userMessage?: string }) =>
        err.category === "forbidden" && /read-only here/.test(err.userMessage ?? ""),
    );
    await settled(4);

    // Older than the window, another connector's, and a failure: written as the instrumentation would.
    await sql`
      insert into public.telemetry_events (source_type, source_slug, caller_app_slug, event_name, outcome, created_at)
      values ('connector', ${KEYED}, ${READER}, 'getItem', 'ok', now() - interval '31 days'),
             ('connector', ${OTHER}, ${READER}, 'listThings', 'ok', now()),
             ('connector', ${KEYED}, ${READER}, 'getItem', 'error', now()),
             ('connector', ${KEYED}, null, 'listItems', 'ok', now()),
             ('route', ${READER}, null, 'GET /x', 'ok', now())
    `;

    const observed = await p.getObservedConnectorCalls([KEYED, OTHER, "unused"]);
    assert.ok(observed);
    assert.deepEqual(observed[KEYED], [
      { appSlug: READER, appName: "Reader", method: "getItem", calls: 2, errors: 1 },
      { appSlug: READER, appName: "Reader", method: "listItems", calls: 2, errors: 0 },
      { appSlug: WRITER, appName: "Writer", method: "listItems", calls: 1, errors: 0 },
      { appSlug: null, appName: null, method: "listItems", calls: 1, errors: 0 },
    ]);
    assert.deepEqual(observed[OTHER], [{ appSlug: READER, appName: "Reader", method: "listThings", calls: 1, errors: 0 }]);
    assert.deepEqual(observed.unused, []);
  });

  test("with the apps' switches read from the table, who can change data", async () => {
    const active = await p.readAppActiveMap();
    assert.ok(active);
    assert.equal(active[WRITER], true);
    assert.equal(active[IDLE], false);

    const keyed = p.connectorRegistry.find((c) => c.name === KEYED)!;
    const reach = (changesAllowed: boolean) =>
      connectorReachOf(p.connectorReach({ connector: keyed, apps: p.appRegistry, active, disabled: false, changesAllowed }));
    const connectorReachOf = (r: ReturnType<typeof p.connectorReach>) =>
      Object.fromEntries(r.apps.map((a) => [a.slug, { write: a.write, canWriteNow: a.canWriteNow }]));

    assert.deepEqual(reach(false), {
      [WRITER]: { write: "read-only", canWriteNow: false },
      [READER]: { write: "not-asked", canWriteNow: false },
      [IDLE]: { write: "read-only", canWriteNow: false },
    });
    assert.deepEqual(reach(true), {
      [WRITER]: { write: "allowed", canWriteNow: true },
      [READER]: { write: "not-asked", canWriteNow: false },
      // Switched off, so none of its code runs.
      [IDLE]: { write: "allowed", canWriteNow: false },
    });
  });

  test("a table that can't be read answers don't-know, never nothing", async () => {
    await sql`alter table public.telemetry_events rename to telemetry_events_away`;
    await sql`alter table public.apps rename to apps_away`;
    try {
      assert.equal(await quietly(() => p.getObservedConnectorCalls([KEYED])), null);
      assert.equal(await quietly(() => p.readAppActiveMap()), null);
    } finally {
      await sql`alter table public.telemetry_events_away rename to telemetry_events`;
      await sql`alter table public.apps_away rename to apps`;
    }
    assert.ok(await p.getObservedConnectorCalls([KEYED]));
  });
});
