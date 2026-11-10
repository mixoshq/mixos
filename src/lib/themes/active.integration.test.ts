/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Applying a theme against a real Postgres: the setting it writes, and the
 * `theme.apply` row it records.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database on. The database's name ends in this run's own suffix, and
 * it is dropped when the run finishes:
 *
 *   docker run -d --name theme -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test src/lib/themes/active.integration.test.ts
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import path from "node:path";
import postgres, { type Sql } from "postgres";
import { migratePlatform } from "../../../scripts/platform-migrations";

const REPO = path.resolve(__dirname, "../../..");
const serverUrl = process.env.MIXOS_TEST_DATABASE_URL;
const skip = serverUrl ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres";

const run = randomBytes(3).toString("hex");
const database = `mixos_theme_${run}`;

/** The runner reports every migration; the tests read the database instead. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

describe("applying a theme", { skip }, () => {
  let admin: Sql;
  let sql: Sql;
  let themes: typeof import("./active");
  let platformSql: Sql;
  let actor: { id: string; email: string };

  async function audited(targetId: string) {
    const rows = await sql`
      select actor_id, actor_email, target_type, target_id, details
      from public.admin_audit_log
      where action = 'theme.apply' and target_id = ${targetId}
    `;
    return rows.map((r) => ({ ...r }));
  }

  before(async () => {
    admin = postgres(serverUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${database}`);
    const u = new URL(serverUrl!);
    u.pathname = `/${database}`;
    sql = postgres(u.toString(), { max: 1, onnotice: () => {} });
    await quietly(() => migratePlatform(sql, path.join(REPO, "supabase", "migrations")));

    // The platform's own pool reads these on its first query.
    process.env.DATABASE_URL = u.toString();
    process.env.PGSSLMODE = u.searchParams.get("sslmode") ?? "disable";
    themes = await import("./active");
    platformSql = (await import("@/lib/db/client")).sql;

    const [user] = await sql`
      insert into public.users (email, display_name, is_admin)
      values (${`admin-${run}@mixos.test`}, 'Admin', true)
      returning id, email
    `;
    actor = { id: user.id, email: user.email };
  });

  after(async () => {
    await platformSql?.end();
    await sql?.end();
    if (admin) {
      await admin.unsafe(`drop database if exists ${database} with (force)`);
      await admin.end();
    }
  });

  test("applying a theme sets it for everyone and is recorded as theme.apply", async () => {
    await themes.setActiveTheme("mixos-dark-d666638f", actor);

    const [setting] = await sql`select value from public.platform_settings where key = 'theme'`;
    assert.equal(setting?.value, "mixos-dark-d666638f");
    assert.deepEqual(await audited("mixos-dark-d666638f"), [
      {
        actor_id: actor.id,
        actor_email: actor.email,
        target_type: "theme",
        target_id: "mixos-dark-d666638f",
        details: {},
      },
    ]);
  });

  test("a theme that is not installed is refused, and nothing is recorded", async () => {
    await assert.rejects(themes.setActiveTheme("no-such-theme", actor), /Unknown theme/);
    const [setting] = await sql`select value from public.platform_settings where key = 'theme'`;
    assert.equal(setting?.value, "mixos-dark-d666638f");
    assert.deepEqual(await audited("no-such-theme"), []);
  });
});
