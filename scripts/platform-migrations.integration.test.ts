/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The runner against a real Postgres: it applies each file once, and refuses a
 * database whose ledger records one of the checkout's numbers under another
 * name, applying nothing.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database on. Its name ends in this run's own suffix, and it is
 * dropped when the run finishes:
 *
 *   docker run -d --name runner -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test scripts/platform-migrations.integration.test.ts
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres, { type Sql } from "postgres";
import { migratePlatform } from "./platform-migrations";

const serverUrl = process.env.MIXOS_TEST_DATABASE_URL;
const skip = serverUrl ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres";

const run = randomBytes(3).toString("hex");
const database = `mixos_runner_${run}`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-platform-runner-"));

/** A migrations directory holding `files`, each `name -> sql`. */
function directory(label: string, files: Record<string, string>): string {
  const dir = path.join(scratch, label);
  fs.mkdirSync(dir);
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), text);
  return dir;
}

const ONE = "create table public.one (id int);\n";
const TWO = "create table public.two (id int);\n";

describe("the platform migration runner", { skip }, () => {
  let admin: Sql;
  let sql: Sql;

  const tables = async () =>
    (
      await sql<{ name: string }[]>`
        select table_name as name from information_schema.tables
        where table_schema = 'public' order by table_name
      `
    ).map((r) => r.name);

  const ledger = async () =>
    (
      await sql<{ version: string; name: string | null }[]>`
        select version, name from supabase_migrations.schema_migrations order by version
      `
    ).map((r) => `${r.version} ${r.name}`);

  before(async () => {
    admin = postgres(serverUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${database}`);
    const u = new URL(serverUrl!);
    u.pathname = `/${database}`;
    sql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  });

  after(async () => {
    await sql?.end();
    if (admin) {
      await admin.unsafe(`drop database if exists ${database} with (force)`);
      await admin.end();
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  test("each file is applied once, and recorded under its number and name", async () => {
    const dir = directory("first", { "0001_one.sql": ONE });
    assert.deepEqual(await migratePlatform(sql, dir, () => {}), { applied: ["0001_one.sql"], alreadyApplied: 0 });
    assert.deepEqual(await migratePlatform(sql, dir, () => {}), { applied: [], alreadyApplied: 1 });
    assert.deepEqual(await ledger(), ["0001 one"]);
  });

  test("a ledger that records a number under another name is refused, with nothing applied", async () => {
    const dir = directory("other-history", { "0001_baseline.sql": ONE, "0002_two.sql": TWO });
    await assert.rejects(migratePlatform(sql, dir, () => {}), (err: Error) => {
      assert.match(err.message, /migration history is not this checkout's/);
      assert.match(err.message, /0001 is recorded as "one", but this checkout's 0001 is 0001_baseline\.sql/);
      assert.match(err.message, /Nothing was applied/);
      return true;
    });
    assert.deepEqual(await tables(), ["one"]);
    assert.deepEqual(await ledger(), ["0001 one"]);
  });

  test("the same history goes on, and a later file is applied", async () => {
    const dir = directory("same-history", { "0001_one.sql": ONE, "0002_two.sql": TWO });
    assert.deepEqual(await migratePlatform(sql, dir, () => {}), { applied: ["0002_two.sql"], alreadyApplied: 1 });
    assert.deepEqual(await tables(), ["one", "two"]);
    assert.deepEqual(await ledger(), ["0001 one", "0002 two"]);
  });

  test("a row with no name disagrees with nothing", async () => {
    await sql`update supabase_migrations.schema_migrations set name = null where version = '0002'`;
    const dir = directory("unnamed", { "0001_one.sql": ONE, "0002_renamed.sql": TWO });
    assert.deepEqual(await migratePlatform(sql, dir, () => {}), { applied: [], alreadyApplied: 2 });
  });
});
