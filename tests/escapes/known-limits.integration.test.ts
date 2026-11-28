/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Known limits, pinned (tests/escapes/catalogue.ts): what code inside the
 * server process can still reach, as docs/threat-model.md says. Each passes
 * while the limit holds. The day one fails, the limit has changed: update the
 * threat model and the catalogue with it.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database on.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import path from "node:path";
import postgres, { type Sql } from "postgres";
import { migratePlatform } from "../../scripts/platform-migrations";

const REPO = path.resolve(__dirname, "../..");
const serverUrl = process.env.MIXOS_TEST_DATABASE_URL;
const skip = serverUrl ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres";
const database = `mixos_limits_${randomBytes(3).toString("hex")}`;

describe("known limits of the server process", { skip }, () => {
  let admin: Sql;
  let sql: Sql;
  let platformSql: Sql;

  before(async () => {
    admin = postgres(serverUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${database}`);
    const u = new URL(serverUrl!);
    u.pathname = `/${database}`;
    sql = postgres(u.toString(), { max: 1, onnotice: () => {} });
    const { log } = console;
    console.log = () => {};
    try {
      await migratePlatform(sql, path.join(REPO, "supabase", "migrations"));
    } finally {
      console.log = log;
    }
    process.env.DATABASE_URL = u.toString();
    process.env.PGSSLMODE = u.searchParams.get("sslmode") ?? "disable";
    process.env.CONNECTOR_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    platformSql = (await import("@/lib/db/client")).sql;
  });

  after(async () => {
    await platformSql?.end();
    await sql?.end();
    if (admin) {
      await admin.unsafe(`drop database if exists ${database} with (force)`);
      await admin.end();
    }
  });

  test("the platform's pool is on the global object", async () => {
    await platformSql`select 1`;
    // What code that reaches the global object (by evading the scan and the
    // reflection lock) finds: the platform's own login, every table.
    const pool = (globalThis as { __pg?: Sql }).__pg;
    assert.ok(pool, "the pool moved off the global object: update the threat model and the catalogue");
    const [{ who }] = await pool`select current_user as who`;
    assert.equal(typeof who, "string");
  });

  test("a connector's own code can read another connector's credentials", async () => {
    const { saveConnectorConfig, getDecryptedConfig } = await import("@/lib/connectors/config");
    await saveConnectorConfig("crm-limit", { apiKey: "the-crm-key" }, null as unknown as string);
    // Connector code isn't held by the app scan, and runs in this process
    // with the platform's modules: nothing stops it importing this.
    assert.deepEqual(await getDecryptedConfig("crm-limit"), { apiKey: "the-crm-key" });
  });
});
