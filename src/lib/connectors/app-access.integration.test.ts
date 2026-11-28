/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An admin's narrowing of one app's reach on a connector, against a real
 * Postgres, through the app's real context:
 *
 *   - "Can't change data" takes a write away though the app asks and changes
 *     are allowed, with an error naming the limit, recorded as `narrowed`;
 *   - a method list refuses what it leaves out, and allows what it keeps;
 *   - a table that can't be read leaves the app reads only;
 *   - setting is audited, an empty list is refused, and everything allowed is
 *     no limit at all;
 *   - another app on the connector is untouched.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database on:
 *
 *   docker run -d --name limits -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test src/lib/connectors/app-access.integration.test.ts
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
const database = `mixos_limits_${run}`;
const KEYED = "_template";
const LIMITED = `limited-${run}`;
const OTHER = `other-${run}`;

async function loadPlatform() {
  return {
    ...(await import("@/generated/connector-registry")),
    ...(await import("@/generated/connector-loaders")),
    ...(await import("@/generated/app-registry")),
    ...(await import("./config")),
    ...(await import("./app-access")),
    ...(await import("./write-policy")),
    ...(await import("./writable-admin")),
    ...(await import("@/lib/apps/context")),
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

type Keyed = BaseConnector & {
  listItems(): Promise<unknown[]>;
  getItem(id: string): Promise<unknown>;
  createItem(d: object): Promise<unknown>;
};

const realFetch = globalThis.fetch;

describe("an admin's limits on an app's connector", { skip }, () => {
  let admin: Sql;
  let sql: Sql;
  let p: Awaited<ReturnType<typeof loadPlatform>>;
  let actor: { id: string; email: string };

  const keyedOf = async (slug: string) =>
    (await quietly(() => p.buildSystemAppContext(slug))).connectors[KEYED] as Keyed;
  async function refusedRows(reason: string) {
    for (let i = 0; i < 50; i++) {
      const rows = await sql`
        select event_name from public.telemetry_events
        where outcome = 'refused' and error_category = ${reason} and caller_app_slug = ${LIMITED}
      `;
      if (rows.length > 0) return rows.map((r) => r.event_name as string);
      await new Promise((r) => setTimeout(r, 20));
    }
    return [];
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
    p = await loadPlatform();

    p.connectorRegistry.push({
      ...(JSON.parse(fs.readFileSync(path.join(REPO, "connectors", KEYED, "connector.json"), "utf8")) as ConnectorManifest),
      name: KEYED,
    });
    p.connectorLoaders[`${KEYED}/index`] = () => import("@connectors/_template/index");
    const base = p.appRegistry[0];
    assert.ok(base);
    for (const slug of [LIMITED, OTHER]) {
      p.appRegistry.push({
        ...base,
        slug,
        name: slug,
        connectors: [KEYED],
        optionalConnectors: [],
        connectorRequirements: [{ name: KEYED, optional: false, access: "write", version: "1.0.0" }],
        env: [],
        egress: [],
        database: false,
        notifications: false,
        consumes: [],
      } as AppManifest);
      await sql`insert into public.apps (slug, name, is_active) values (${slug}, ${slug}, true)`;
    }
    const [user] = await sql`
      insert into public.users (email, display_name, is_admin) values (${`admin-${run}@mixos.test`}, 'Admin', true)
      returning id, email
    `;
    actor = { id: user.id, email: user.email };
    await p.saveConnectorConfig(KEYED, { apiKey: "k" }, actor.id);
    await p.setConnectorChanges(KEYED, true, actor);

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (init?.method === "POST") return Response.json({ id: "2", name: "new" });
      if (/\/items\/[^/?]+/.test(url)) return Response.json({ id: "1", name: "one" });
      return Response.json({ data: [{ id: "1", name: "one" }], meta: {} });
    }) as typeof fetch;
  });

  afterEach(async () => {
    await sql`delete from public.connector_app_access`;
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

  test("with no limit, it writes, as its entry and Allow changes say", async () => {
    await (await keyedOf(LIMITED)).createItem({ name: "x" });
  });

  test("Can't change data takes its writes away, naming the limit, and is recorded as narrowed", async () => {
    await p.setAppNarrowing(actor, KEYED, LIMITED, { writes: "deny", methods: null });
    const keyed = await keyedOf(LIMITED);
    await assert.rejects(async () => keyed.createItem({}), (err: Error) => err instanceof p.ConnectorNarrowedError);
    await keyed.listItems();
    assert.deepEqual(await refusedRows("narrowed"), ["createItem"]);
    // The other app on the connector still writes.
    await (await keyedOf(OTHER)).createItem({ name: "x" });

    const [row] = await sql`select details from public.admin_audit_log where action = 'connector.app.access'`;
    assert.deepEqual(row.details, { app: LIMITED, writes: "deny", methods: null });
  });

  test("a method list refuses what it leaves out", async () => {
    await p.setAppNarrowing(actor, KEYED, LIMITED, { writes: "inherit", methods: ["listItems", "notAMethod"] });
    const [stored] = await sql`select methods from public.connector_app_access where app_slug = ${LIMITED}`;
    assert.deepEqual(stored.methods, ["listItems"], "only declared methods are kept");
    const keyed = await keyedOf(LIMITED);
    await keyed.listItems();
    await assert.rejects(async () => keyed.getItem("1"), (err: Error) => err instanceof p.ConnectorNarrowedError);
    await assert.rejects(async () => keyed.createItem({}), (err: Error) => err instanceof p.ConnectorNarrowedError);
    // What the facade reports having stays the declaration; what runs is the limit.
    assert.ok("getItem" in keyed);
  });

  test("an empty list is refused, and allowing everything is no limit", async () => {
    await assert.rejects(p.setAppNarrowing(actor, KEYED, LIMITED, { writes: "inherit", methods: [] }), p.AppAccessError);
    await p.setAppNarrowing(actor, KEYED, LIMITED, {
      writes: "inherit",
      methods: ["listItems", "getItem", "createItem"],
    });
    assert.equal((await sql`select 1 from public.connector_app_access`).length, 0);
    await assert.rejects(p.setAppNarrowing(actor, KEYED, `nobody-${run}`, { writes: "deny", methods: null }), p.AppAccessError);
  });

  test("a table that can't be read leaves the app reads only", async () => {
    await sql`alter table public.connector_app_access rename to connector_app_access_away`;
    try {
      const keyed = await keyedOf(LIMITED);
      await keyed.listItems();
      await assert.rejects(async () => keyed.createItem({}), (err: Error) => err instanceof p.ConnectorNarrowedError);
    } finally {
      await sql`alter table public.connector_app_access_away rename to connector_app_access`;
    }
  });
});
