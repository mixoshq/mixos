/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The connector telemetry prune (pruneConnectorTelemetry, ./telemetry.ts)
 * against a real Postgres, in a database of its own.
 */

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import path from "node:path";
import postgres, { type Sql } from "postgres";
import { migratePlatform } from "../../../scripts/platform-migrations";

const REPO = path.resolve(__dirname, "../../..");
const serverUrl = process.env.MIXOS_TEST_DATABASE_URL;
const skip = serverUrl ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres";
const database = `mixos_retain_${randomBytes(3).toString("hex")}`;
const DAY = 86_400_000;

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, { log, warn, error });
  }
}

describe("pruning connector telemetry", { skip }, () => {
  let admin: Sql;
  let sql: Sql;
  let p: typeof import("./telemetry") & { platformSql: Sql };

  /** `n` rows of a source, `ageDays` old. */
  async function rows(type: string, ageDays: number, n = 1) {
    const at = new Date(Date.now() - ageDays * DAY);
    for (let i = 0; i < n; i++) {
      await sql`
        insert into public.telemetry_events (source_type, source_slug, caller_app_slug, event_name, outcome, created_at)
        values (${type}, 'crm', 'notes', 'listDeals', 'ok', ${at})
      `;
    }
  }

  async function count(where = "true"): Promise<number> {
    const [{ n }] = await sql.unsafe(`select count(*)::int as n from public.telemetry_events where ${where}`);
    return n;
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
    p = { ...(await import("./telemetry")), platformSql: (await import("@/lib/db/client")).sql as unknown as Sql };
  });

  beforeEach(async () => {
    await sql`delete from public.telemetry_events`;
  });

  after(async () => {
    await p?.platformSql.end();
    await sql?.end();
    if (admin) {
      await admin.unsafe(`drop database if exists ${database} with (force)`);
      await admin.end();
    }
  });

  test("connector calls older than the retention go; newer ones, and every other source, stay", async () => {
    await rows("connector", 120, 3);
    await rows("connector", 89, 2);
    await rows("route", 120);
    await rows("app", 400);
    await rows("mcp", 400);
    assert.equal(await p.pruneConnectorTelemetry(90), 3);
    assert.equal(await count("source_type = 'connector'"), 2);
    assert.equal(await count("source_type <> 'connector'"), 3);
  });

  test("a longer retention keeps more; 0 (null) keeps them all", async () => {
    await rows("connector", 400);
    await rows("connector", 200);
    assert.equal(await p.pruneConnectorTelemetry(365), 1);
    assert.equal(await count(), 1);
    await rows("connector", 5000);
    assert.equal(await p.pruneConnectorTelemetry(null), 0);
    assert.equal(await p.pruneConnectorTelemetry(Infinity), 0);
    assert.equal(await count(), 2);
  });

  test("a batch at a time, up to a cap a tick; the next tick takes the rest", async () => {
    await rows("connector", 120, 7);
    assert.equal(await p.pruneConnectorTelemetry(90, { batch: 2, maxBatches: 2 }), 4);
    assert.equal(await count(), 3);
    assert.equal(await p.pruneConnectorTelemetry(90, { batch: 2, maxBatches: 2 }), 3);
    assert.equal(await count(), 0);
  });

  test("its index is the one the prune reads", async () => {
    const [index] = await sql`
      select indexdef from pg_indexes
      where schemaname = 'public' and indexname = 'idx_telemetry_events_connector_created'
    `;
    assert.match(index?.indexdef ?? "", /\(created_at\) WHERE \(source_type = 'connector'::text\)/);
  });
});
