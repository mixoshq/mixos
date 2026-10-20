/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Allow changes, against a real database: where it is kept, who allowed it,
 * the activation gate, and the two keys a write needs in a real app context —
 * the app's entry asking for "write", and an admin's Allow changes.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database on. The database's name ends in this run's own suffix, and
 * it is dropped when the run finishes:
 *
 *   docker run -d --name writable -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test src/lib/connectors/writable.integration.test.ts
 *
 * The connector is the API-key template under connectors/, registered for
 * this run only, and the apps declaring it exist only in this process's
 * registry. Upstream calls go to a stubbed fetch, so nothing leaves the machine.
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
const database = `mixos_writable_${run}`;

/** API key; `listItems` reads and `createItem` changes data. */
const KEYED = "_template";
/** The same connector with its write taken out: nothing to allow. */
const READS = `reads-${run}`;
const WRITER = `writer-${run}`;
const WRITER_NAME = "Writer";
const READER = `reader-${run}`;

async function loadPlatform() {
  return {
    ...(await import("@/generated/connector-registry")),
    ...(await import("@/generated/app-registry")),
    ...(await import("./writable")),
    ...(await import("./writable-admin")),
    ...(await import("./write-policy")),
    ...(await import("./switch-keys")),
    ...(await import("./config")),
    ...(await import("@/lib/apps/context")),
    ...(await import("@/lib/apps/connector-reach")),
    ...(await import("@/lib/apps/connector-gates")),
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

const manifestOf = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(REPO, "connectors", name, "connector.json"), "utf8")) as ConnectorManifest;

/** The connector's methods, as an app would cast them. */
type Keyed = BaseConnector & {
  listItems(): Promise<unknown[]>;
  createItem(data: Record<string, unknown>): Promise<unknown>;
  request(path: string, init?: RequestInit): Promise<unknown>;
};

const realFetch = globalThis.fetch;
/** Every upstream request made, as "METHOD url". */
let sent: string[] = [];

/** A list for a GET, the created item for a POST. */
function upstream() {
  sent = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    sent.push(`${method} ${url}`);
    return method === "POST"
      ? Response.json({ id: "2", name: "new" })
      : Response.json({ data: [{ id: "1", name: "old" }], meta: {} });
  }) as typeof fetch;
}

describe("Allow changes", { skip }, () => {
  let admin: Sql;
  let sql: Sql;
  let p: Awaited<ReturnType<typeof loadPlatform>>;
  let actor: { id: string; email: string };

  async function audited(action: string, targetId: string) {
    const rows = await sql`
      select actor_id, actor_email, target_type, target_id, details
      from public.admin_audit_log
      where action = ${action} and target_id = ${targetId}
      order by created_at
    `;
    return rows.map((r) => ({ ...r }));
  }

  const connectorsOf = async (slug: string) =>
    (await quietly(() => p.buildSystemAppContext(slug))).connectors[KEYED] as Keyed;

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

    const keyed = manifestOf(KEYED);
    p.connectorRegistry.push(keyed, {
      ...keyed,
      name: READS,
      telemetry: keyed.telemetry.filter((t) => !t.mutates),
    });
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
    p.appRegistry.push(app(WRITER, WRITER_NAME, "write"), app(READER, "Reader", "read"));

    const [user] = await sql`
      insert into public.users (email, display_name, is_admin)
      values (${`admin-${run}@mixos.test`}, 'Admin', true)
      returning id, email
    `;
    actor = { id: user.id, email: user.email };
    await p.saveConnectorConfig(KEYED, { apiKey: "key-1" }, actor.id);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  after(async () => {
    await p?.platformSql.end();
    await sql?.end();
    if (admin) {
      await admin.unsafe(`drop database if exists ${database} with (force)`);
      await admin.end();
    }
  });

  test("read-only is no row; Allow changes is a row holding when, audited with what it unlocks and who asked", async () => {
    const key = p.connectorWritableKey(KEYED);
    const row = async () => (await sql`select value from public.platform_settings where key = ${key}`)[0];
    assert.equal(await p.isConnectorWritable(KEYED), false);
    assert.equal(await row(), undefined);

    await p.setConnectorChanges(KEYED, true, actor);
    assert.equal(await p.isConnectorWritable(KEYED), true);
    assert.ok(Number.isFinite(Date.parse((await row())?.value)));
    await p.setConnectorChanges(KEYED, false, actor);
    assert.equal(await row(), undefined);

    const details = { methods: ["createItem"], neededBy: [WRITER_NAME] };
    const by = { actor_id: actor.id, actor_email: actor.email, target_type: "connector", target_id: KEYED };
    assert.deepEqual(await audited("connector.allow-changes", KEYED), [{ ...by, details }]);
    assert.deepEqual(await audited("connector.disallow-changes", KEYED), [{ ...by, details }]);

    await assert.rejects(p.setConnectorChanges(READS, true, actor), /has no method that changes data/);
    assert.equal(await p.isConnectorWritable(READS), false);
  });

  test("a write needs both keys: the app asking, and an admin allowing", async () => {
    upstream();
    // Asked, not allowed: refused before anything is sent, for an admin to fix.
    const writer = await connectorsOf(WRITER);
    assert.deepEqual(await writer.listItems(), [{ id: "1", name: "old" }]);
    assert.throws(
      () => writer.createItem({ name: "new" }),
      (err: unknown) => err instanceof p.ConnectorChangesNotAllowedError && err.category === "forbidden",
    );
    assert.deepEqual(sent, ["GET https://api.example.com/items?limit=100"]);

    // Asked and allowed: it writes.
    await p.setConnectorWritable(KEYED, true);
    try {
      sent = [];
      const allowed = await connectorsOf(WRITER);
      assert.deepEqual(await allowed.createItem({ name: "new" }), { id: "2", name: "new" });
      assert.deepEqual(sent, ["POST https://api.example.com/items"]);

      // Allowed, not asked: the reader never writes, and never reaches around.
      sent = [];
      const reader = await connectorsOf(READER);
      assert.throws(() => reader.createItem({ name: "new" }), p.ConnectorUseError);
      assert.throws(() => reader.request("/items", { method: "DELETE" }), p.ConnectorUseError);
      assert.throws(() => allowed.request("/items", { method: "DELETE" }), p.ConnectorUseError);
      assert.deepEqual(sent, []);
    } finally {
      await p.setConnectorWritable(KEYED, false);
    }
  });

  test("the activation gate holds an app that writes until changes are allowed, and not one that reads", async () => {
    assert.deepEqual(await p.getMissingTenantConfigConnectors(WRITER), [
      { name: KEYED, displayName: manifestOf(KEYED).displayName, state: "read-only" },
    ]);
    assert.deepEqual(await p.getMissingTenantConfigConnectors(READER), []);
    assert.equal(p.missingConnectorSteps(await p.getMissingTenantConfigConnectors(WRITER)), "Allow changes in Template Connector");

    await p.setConnectorWritable(KEYED, true);
    try {
      assert.deepEqual(await p.getMissingTenantConfigConnectors(WRITER), []);
    } finally {
      await p.setConnectorWritable(KEYED, false);
    }
  });
});
