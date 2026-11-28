/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-app detection, against a real Postgres:
 *
 *   - refused calls are recorded: a write the app's entry doesn't ask for, an
 *     undeclared member, a disabled connector, and each egress refusal;
 *   - the first run takes what is there as the baseline and raises nothing;
 *   - then each rule fires on new activity, and stays quiet on the baseline:
 *     a first write, a first host through a wildcard (not a listed one), any
 *     refusal, a spike; and the cap on subjects;
 *   - it runs at most every 15 minutes;
 *   - Mark as expected is audited, and retention bounds only what this adds.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database on:
 *
 *   docker run -d --name detect -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test src/lib/apps/detection.integration.test.ts
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import postgres, { type Sql } from "postgres";
import { migratePlatform } from "../../../scripts/platform-migrations";
import type { AppManifest } from "@/lib/apps/types";
import type { BaseConnector, ConnectorManifest } from "@/lib/connectors/types";

const REPO = path.resolve(__dirname, "../../..");
const serverUrl = process.env.MIXOS_TEST_DATABASE_URL;
const skip = serverUrl ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres";

const run = randomBytes(3).toString("hex");
const database = `mixos_detect_${run}`;
const KEYED = "_template";
const WATCH = `watch-${run}`;
const MINUTE = 60_000;

async function loadPlatform() {
  return {
    ...(await import("@/generated/connector-registry")),
    ...(await import("@/generated/connector-loaders")),
    ...(await import("@/generated/app-registry")),
    ...(await import("@/lib/connectors/config")),
    ...(await import("@/lib/connectors/switch-keys")),
    ...(await import("./context")),
    ...(await import("./http")),
    ...(await import("./detection")),
    ...(await import("./anomaly")),
    ...(await import("./telemetry")),
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

type Keyed = BaseConnector & { listItems(): Promise<unknown[]>; createItem(d: object): Promise<unknown> };

describe("per-app detection", { skip }, () => {
  let admin: Sql;
  let sql: Sql;
  let p: Awaited<ReturnType<typeof loadPlatform>>;
  let actor: { id: string; email: string };
  const t0 = new Date();
  const at = (minutes: number) => new Date(t0.getTime() + minutes * MINUTE);

  /** The calls are recorded fire-and-forget: wait until `n` match. */
  async function settled(where: string, n: number) {
    for (let i = 0; i < 100; i++) {
      const [{ count }] = await sql.unsafe(`select count(*)::int as count from public.telemetry_events where ${where}`);
      if (count >= n) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.fail(`fewer than ${n} rows where ${where}`);
  }

  async function telemetry(rows: Array<{ type: string; slug: string; event: string; outcome?: string; at: Date; n?: number }>) {
    for (const r of rows) {
      for (let i = 0; i < (r.n ?? 1); i++) {
        await sql`
          insert into public.telemetry_events (source_type, source_slug, caller_app_slug, event_name, outcome, created_at)
          values (${r.type}, ${r.slug}, ${WATCH}, ${r.event}, ${r.outcome ?? "ok"}, ${r.at})
        `;
      }
    }
  }

  const open = async () => (await p.getOpenAnomalies())[WATCH] ?? [];

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
    p.appRegistry.push({
      ...base,
      slug: WATCH,
      name: "Watch",
      connectors: [KEYED],
      optionalConnectors: [],
      connectorRequirements: [{ name: KEYED, optional: false, access: "read", version: "1.0.0" }],
      egress: ["api.example.com", "*.cdn.example.com", "localhost"],
      env: [],
      database: false,
      notifications: false,
      consumes: [],
    } as AppManifest);
    await sql`insert into public.apps (slug, name, is_active) values (${WATCH}, 'Watch', true)`;
    const [user] = await sql`
      insert into public.users (email, display_name, is_admin) values (${`admin-${run}@mixos.test`}, 'Admin', true)
      returning id, email
    `;
    actor = { id: user.id, email: user.email };
    await p.saveConnectorConfig(KEYED, { apiKey: "k" }, actor.id);
  });

  after(async () => {
    await p?.platformSql.end();
    await sql?.end();
    if (admin) {
      await admin.unsafe(`drop database if exists ${database} with (force)`);
      await admin.end();
    }
  });

  test("refused calls are recorded: an unasked write, an undeclared member, a disabled connector", async () => {
    const keyed = (await quietly(() => p.buildSystemAppContext(WATCH))).connectors[KEYED] as Keyed & {
      request: () => unknown;
    };
    await assert.rejects(async () => keyed.createItem({}));
    assert.throws(() => keyed.request());
    await sql`insert into public.platform_settings (key, value) values (${p.connectorSwitchKey(KEYED)}, now()::text)`;
    const off = (await quietly(() => p.buildSystemAppContext(WATCH))).connectors[KEYED] as Keyed;
    await assert.rejects(off.listItems());
    await sql`delete from public.platform_settings where key = ${p.connectorSwitchKey(KEYED)}`;

    await settled(`source_type = 'connector' and outcome = 'refused'`, 3);
    const rows = await sql`
      select event_name, error_category from public.telemetry_events
      where source_type = 'connector' and outcome = 'refused' order by error_category
    `;
    assert.deepEqual(
      rows.map((r) => [r.event_name, r.error_category]),
      [
        ["listItems", "disabled"],
        ["request", "undeclared"],
        ["createItem", "write-not-asked"],
      ],
    );
  });

  test("context.http records each refusal: a host it doesn't list, a scheme, a private address", async () => {
    const http = p.createHttpClient(WATCH, ["api.example.com", "localhost"], { userId: actor.id });
    await assert.rejects(http.fetch("https://evil.example.org/x"), /not allowed to reach evil\.example\.org/);
    await assert.rejects(http.fetch("ftp://api.example.com/x"), /may not use the ftp: scheme/);
    await assert.rejects(http.fetch("http://localhost:1/x"), /non-public address/);
    await settled(`source_type = 'egress'`, 3);
    const rows = await sql`
      select source_slug, outcome, error_category, user_id from public.telemetry_events
      where source_type = 'egress' order by error_category
    `;
    assert.deepEqual(
      rows.map((r) => [r.source_slug, r.outcome, r.error_category]),
      [
        ["localhost", "refused", "address"],
        ["evil.example.org", "refused", "host"],
        ["api.example.com", "refused", "scheme"],
      ],
    );
    assert.ok(rows.every((r) => r.user_id === actor.id));
  });

  test("the first run takes what is there as the baseline, and raises nothing", async () => {
    await sql`delete from public.telemetry_events where outcome = 'refused'`;
    await telemetry([
      { type: "connector", slug: KEYED, event: "listItems", at: at(-60 * 24) },
      { type: "connector", slug: KEYED, event: "createItem", at: at(-60 * 24) },
      { type: "egress", slug: "api.example.com", event: "request", at: at(-60 * 24) },
    ]);
    const first = await p.runDetection(t0);
    assert.deepEqual(first, { ran: true, backfill: true, raised: 0 });
    assert.deepEqual(await open(), []);
    const seen = await sql`select kind, subject from public.app_activity_seen where app_slug = ${WATCH} order by subject`;
    assert.deepEqual(
      seen.map((r) => r.subject as string).sort(),
      [`${KEYED}.createItem`, `${KEYED}.listItems`, "api.example.com"].sort(),
    );
    // Not again within 15 minutes.
    assert.equal((await p.runDetection(at(5))).ran, false);
  });

  test("then each rule fires on what is new, and stays quiet on the baseline", async () => {
    // The baseline again: quiet.
    await telemetry([
      { type: "connector", slug: KEYED, event: "listItems", at: at(2) },
      { type: "connector", slug: KEYED, event: "createItem", at: at(2) },
      { type: "egress", slug: "api.example.com", event: "request", at: at(3) },
    ]);
    assert.deepEqual(await p.runDetection(at(16)), { ran: true, backfill: false, raised: 0 });

    // New: a host through the wildcard, a listed host seen for the first time, refusals.
    await telemetry([
      { type: "egress", slug: "img.cdn.example.com", event: "request", at: at(20) },
      { type: "egress", slug: "localhost", event: "request", at: at(20) },
      { type: "connector", slug: KEYED, event: "deleteAll", outcome: "refused", at: at(21), n: 3 },
      { type: "egress", slug: "evil.example.org", event: "request", outcome: "refused", at: at(22) },
    ]);
    await sql`update public.telemetry_events set error_category = 'undeclared' where event_name = 'deleteAll'`;
    await sql`update public.telemetry_events set error_category = 'host' where source_slug = 'evil.example.org'`;
    const second = await p.runDetection(at(32));
    assert.equal(second.ran, true);
    const kinds = (await open()).map((a) => [a.kind, a.subject, a.count]).sort();
    assert.deepEqual(kinds, [
      ["new-host", "img.cdn.example.com", 1],
      ["refused", `connector:${KEYED}.deleteAll:undeclared`, 3],
      ["refused", "egress:evil.example.org:host", 1],
    ]);
    const words = (await open()).map((a) => p.describeAnomaly(a)).sort();
    assert.ok(words.includes(`Called ${KEYED}.deleteAll, refused 3 times (a method its connector doesn't declare).`));
    assert.ok(words.includes("Tried to reach evil.example.org, refused once (a host its egress doesn't list)."));
  });

  test("a first write raises new-write", async () => {
    await sql`delete from public.app_activity_seen where subject = ${`${KEYED}.createItem`}`;
    await telemetry([{ type: "connector", slug: KEYED, event: "createItem", at: at(40) }]);
    await p.runDetection(at(48));
    assert.ok((await open()).some((a) => a.kind === "new-write" && a.subject === `${KEYED}.createItem`));
  });

  test("a spike: more than ten times the week's hourly mean, and more than 100", async () => {
    await telemetry([{ type: "connector", slug: KEYED, event: "listItems", at: at(60), n: 150 }]);
    await p.runDetection(at(70));
    const spike = (await open()).find((a) => a.kind === "spike");
    assert.ok(spike, "a spike was raised");
    assert.ok(Number(spike.detail.lastHour) >= 150);
  });

  test("past the cap, one too-many-subjects, and nothing more kept", async () => {
    for (let i = 0; i < 500; i++) {
      await sql`
        insert into public.app_activity_seen (app_slug, kind, subject) values (${WATCH}, 'egress-host', ${`h${i}.example`})
        on conflict do nothing
      `;
    }
    await telemetry([{ type: "egress", slug: "z.cdn.example.com", event: "request", at: at(80) }]);
    await p.runDetection(at(88));
    assert.ok((await open()).some((a) => a.kind === "too-many-subjects"));
    const kept = await sql`select 1 from public.app_activity_seen where subject = 'z.cdn.example.com'`;
    assert.equal(kept.length, 0);
  });

  test("Mark as expected is audited, and clears them from the tile", async () => {
    const ids = (await open()).map((a) => a.id);
    assert.equal(await p.acknowledgeAnomalies(actor, WATCH, ids), ids.length);
    assert.deepEqual(await open(), []);
    const [row] = await sql`select details from public.admin_audit_log where action = 'app.anomaly.acknowledge'`;
    assert.equal((row.details as { anomalies: unknown[] }).anomalies.length, ids.length);
  });

  test("retention: egress at 90 days and acknowledged anomalies at 180; connector rows are kept", async () => {
    await telemetry([
      { type: "egress", slug: "old.example", event: "request", at: at(-60 * 24 * 91) },
      { type: "connector", slug: KEYED, event: "listItems", at: at(-60 * 24 * 400) },
    ]);
    assert.ok((await p.pruneEgressTelemetry()) >= 1);
    assert.equal((await sql`select 1 from public.telemetry_events where source_slug = 'old.example'`).length, 0);
    assert.equal(
      (await sql`select 1 from public.telemetry_events where source_type = 'connector' and created_at < ${at(-60 * 24 * 399)}`).length,
      1,
    );
    await sql`update public.app_anomalies set acknowledged_at = now() - interval '181 days'`;
    assert.ok((await p.pruneAcknowledgedAnomalies()) >= 1);
    assert.equal((await sql`select 1 from public.app_anomalies`).length, 0);
  });
});
