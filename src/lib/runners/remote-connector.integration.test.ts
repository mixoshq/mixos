/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A connector in its runner, through the platform as an app reaches it: the
 * context build, the facade, the write rules, the telemetry and Verify
 * connection, around a RemoteConnector, against a real Postgres. Skipped
 * without MIXOS_TEST_DATABASE_URL, or on a Node without the network
 * permission.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import postgres, { type Sql } from "postgres";
import { migratePlatform } from "../../../scripts/platform-migrations";
import type { AppManifest } from "@/lib/apps/types";
import type { ConnectorManifest } from "@/lib/connectors/types";
import { isolationSupport } from "./supervisor";

const REPO = path.resolve(__dirname, "../../..");
const serverUrl = process.env.MIXOS_TEST_DATABASE_URL;
const skip = !serverUrl
  ? "set MIXOS_TEST_DATABASE_URL to run against a real Postgres"
  : isolationSupport().supported
    ? false
    : "this Node has no network permission";
const run = randomBytes(3).toString("hex");
const database = `mixos_remote_${run}`;
const KEYED = "_template";
const APP = `reader-${run}`;

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, { log, warn, error });
  }
}

type Items = { listItems(): Promise<Array<{ id: string }>>; createItem(d: object): Promise<unknown> };

describe("a connector in its runner, through the platform", { skip }, () => {
  let admin: Sql;
  let sql: Sql;
  let server: http.Server;
  let bundles = "";
  const seen: string[] = [];
  let p: typeof import("@/generated/connector-registry") &
    typeof import("@/generated/app-registry") &
    typeof import("@/lib/connectors/config") &
    typeof import("@/lib/connectors/test-connection") &
    typeof import("@/lib/apps/context") &
    typeof import("./remote-connector") &
    typeof import("./isolation-audit") & { platformSql: Sql };

  before(async () => {
    server = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url?.split("?")[0]}`);
      res.setHeader("content-type", "application/json");
      if (req.url === "/me") return res.end(JSON.stringify({ name: "Tester" }));
      res.end(JSON.stringify({ data: [{ id: "1", name: "one" }] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    admin = postgres(serverUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${database}`);
    const u = new URL(serverUrl!);
    u.pathname = `/${database}`;
    sql = postgres(u.toString(), { max: 1, onnotice: () => {} });
    await quietly(() => migratePlatform(sql, path.join(REPO, "supabase", "migrations")));
    process.env.DATABASE_URL = u.toString();
    process.env.PGSSLMODE = u.searchParams.get("sslmode") ?? "disable";
    process.env.CONNECTOR_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    (process.env as Record<string, string>).NODE_ENV = "production";
    delete process.env.MIXOS_ISOLATION;

    p = {
      ...(await import("@/generated/connector-registry")),
      ...(await import("@/generated/app-registry")),
      ...(await import("@/lib/connectors/config")),
      ...(await import("@/lib/connectors/test-connection")),
      ...(await import("@/lib/apps/context")),
      ...(await import("./remote-connector")),
      ...(await import("./isolation-audit")),
      platformSql: (await import("@/lib/db/client")).sql as unknown as Sql,
    };
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO, "connectors", KEYED, "connector.json"), "utf8")) as ConnectorManifest;
    p.connectorRegistry.push({ ...manifest, name: KEYED } as never);
    const { buildConnectorBundle } = await import("../../../scripts/build-runner-bundles");
    bundles = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-bundles-"));
    p.useRunnerBundleRoot(bundles);
    await buildConnectorBundle({ ...manifest, name: KEYED } as ConnectorManifest & { name: string }, bundles);

    const baseApp = p.appRegistry[0];
    assert.ok(baseApp);
    p.appRegistry.push({
      ...baseApp,
      slug: APP,
      name: "Reader",
      connectors: [KEYED],
      optionalConnectors: [],
      connectorRequirements: [{ name: KEYED, optional: false, access: "read", version: "1.0.0" }],
      egress: [],
      env: [],
      database: false,
      notifications: false,
      consumes: [],
    } as AppManifest);
    await sql`insert into public.apps (slug, name, is_active) values (${APP}, 'Reader', true)`;
    const [user] = await sql`
      insert into public.users (email, display_name, is_admin) values (${`admin-${run}@mixos.test`}, 'Admin', true)
      returning id
    `;
    await p.saveConnectorConfig(KEYED, { apiKey: "k", baseUrl: base }, user.id);
  });

  after(async () => {
    await p?.stopConnectorRunners?.();
    await p?.platformSql?.end();
    await sql?.end();
    server?.close();
    if (bundles) fs.rmSync(bundles, { recursive: true, force: true });
    if (admin) {
      await admin.unsafe(`drop database if exists ${database} with (force)`);
      await admin.end();
    }
  });

  test("an app's declared read runs in the runner, through the facade, and is recorded", async () => {
    const ctx = (await quietly(() => p.buildSystemAppContext(APP))) as unknown as { connectors: Record<string, unknown> };
    const items = (ctx.connectors[KEYED] as Items).listItems();
    assert.deepEqual((await items).map((i) => i.id), ["1"]);
    assert.ok(seen.includes("GET /items"));
    for (let i = 0; i < 100; i++) {
      const [{ n }] = await sql`
        select count(*)::int as n from public.telemetry_events
        where source_type = 'connector' and source_slug = ${KEYED} and caller_app_slug = ${APP} and event_name = 'listItems' and outcome = 'ok'
      `;
      if (n > 0) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.fail("the call wasn't recorded");
  });

  test("a write the app didn't ask for is refused by the platform, and never reaches the runner", async () => {
    const ctx = (await quietly(() => p.buildSystemAppContext(APP))) as unknown as { connectors: Record<string, unknown> };
    const before = seen.length;
    await assert.rejects(async () => (ctx.connectors[KEYED] as Items).createItem({ name: "x" }), /doesn't ask for "access": "write"/);
    assert.equal(seen.slice(before).filter((s) => s.startsWith("POST")).length, 0);
  });

  test("Verify connection runs the connector's testConnection in its runner", async () => {
    const result = (await quietly(() => p.runConnectorTest(KEYED, {}))) as unknown as { ok: boolean };
    assert.equal(result.ok, true);
    assert.ok(seen.includes("GET /me"));
  });

  test("where connectors run is audited when it changes, and only then", async () => {
    assert.equal(await p.auditConnectorIsolation(), "recorded");
    assert.equal(await p.auditConnectorIsolation(), "unchanged");
    process.env.MIXOS_ISOLATION = "off";
    try {
      assert.equal(await p.auditConnectorIsolation(), "recorded");
    } finally {
      delete process.env.MIXOS_ISOLATION;
    }
    const rows = await sql`
      select details from public.admin_audit_log where action = 'platform.isolation.connectors' order by created_at
    `;
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.details.isolated, true);
    assert.equal(rows[1]!.details.isolated, false);
    assert.match(rows[1]!.details.reason, /MIXOS_ISOLATION=off/);
  });
});
