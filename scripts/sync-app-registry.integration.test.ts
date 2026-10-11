/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The release step's registry sync against a real Postgres: an app that leaves
 * the build keeps everything it had, and comes back as it left only when its
 * files are the same.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database and roles on. Every name it creates ends in this run's own
 * suffix, and it drops them all when it finishes:
 *
 *   docker run -d --name keepapp -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test scripts/sync-app-registry.integration.test.ts
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres, { type Sql } from "postgres";
import { appRoleName, appSchemaName } from "../src/lib/apps/app-identifiers";
import { appCodeHash } from "./app-code-hash";
import { migrateAppSchemas, type MigratedApp } from "./app-migrations";
import { migratePlatform } from "./platform-migrations";
import { RELEASE_STEP_ACTOR } from "./sync-app-registry";

const REPO = path.resolve(__dirname, "..");
const serverUrl = process.env.MIXOS_TEST_DATABASE_URL;
const skip = serverUrl ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres";

// Roles belong to the server, not to a database, so every name is this run's.
const run = randomBytes(3).toString("hex");
const database = `mixos_keep_${run}`;
const appsDir = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-keep-app-data-"));

/** The runner reports every step; the tests read the database instead. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

describe("an app leaving the build and coming back", { skip }, () => {
  let admin: Sql;
  let sql: Sql;
  let url: string;

  const notes: MigratedApp = {
    slug: `notes-${run}`,
    name: "Notes",
    description: "",
    icon: "notebook",
    database: true,
    updatedAt: [],
    sync: [],
  };
  const folder = path.join(appsDir, notes.slug);
  const schema = appSchemaName(notes.slug);
  /** The hash of the files it first shipped with. */
  let firstHash: string;

  /** One release step, for a build that carries `apps`. */
  const release = (apps: MigratedApp[]) => quietly(() => migrateAppSchemas(sql, { apps, appsDir }));

  async function appRow() {
    const [row] = await sql`
      select is_active, missing_since, code_hash, returned_changed_at
      from public.apps where slug = ${notes.slug}
    `;
    return row ? { ...row } : undefined;
  }

  /** Everything the app had, counted, from the row's dependents to its own table. */
  async function everything() {
    const [counts] = await sql`
      select
        (select count(*)::int from public.user_app_grants where app_slug = ${notes.slug}) as grants,
        (select count(*)::int from public.user_apps where app_slug = ${notes.slug}) as installs,
        (select count(*)::int from public.app_passwords where app_slug = ${notes.slug}) as passwords,
        (select count(*)::int from public.dashboard_widgets where app_slug = ${notes.slug}) as widgets,
        (select count(*)::int from public.app_settings where app_slug = ${notes.slug}) as settings,
        (select count(*)::int from public.app_api_keys where app_slug = ${notes.slug}) as keys,
        (select count(*)::int from public.app_scheduled_jobs where app_slug = ${notes.slug}) as jobs,
        (select count(*)::int from public._migrations where app_slug = ${notes.slug}) as migrations
    `;
    const [{ rows }] = await sql.unsafe(`select count(*)::int as rows from "${schema}".notes`);
    return { ...counts, rows };
  }
  const ALL_OF_IT = {
    grants: 1,
    installs: 1,
    passwords: 1,
    widgets: 1,
    settings: 1,
    keys: 1,
    jobs: 1,
    migrations: 1,
    rows: 1,
  };

  async function audited(action: "app.missing" | "app.returned") {
    const rows = await sql`
      select actor_id, actor_email, target_type, details
      from public.admin_audit_log
      where action = ${action} and target_id = ${notes.slug}
      order by created_at
    `;
    return rows.map((r) => ({ ...r }));
  }

  before(async () => {
    admin = postgres(serverUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${database}`);
    const u = new URL(serverUrl!);
    u.pathname = `/${database}`;
    url = u.toString();
    sql = postgres(url, { max: 1, onnotice: () => {} });
    await quietly(() => migratePlatform(sql, path.join(REPO, "supabase", "migrations")));

    fs.mkdirSync(path.join(folder, "migrations"), { recursive: true });
    fs.mkdirSync(path.join(folder, "api", "notes"), { recursive: true });
    fs.writeFileSync(path.join(folder, "app.json"), '{ "name": "Notes", "database": true }\n');
    fs.writeFileSync(path.join(folder, "api", "notes", "route.ts"), "export const GET = defineRoute({});\n");
    fs.writeFileSync(
      path.join(folder, "migrations", "001_notes.sql"),
      "create table notes (id int primary key, body text not null);\n",
    );
  });

  after(async () => {
    await sql?.end();
    if (admin) {
      await admin.unsafe(`drop database if exists ${database} with (force)`);
      await admin.unsafe(`drop role if exists ${appRoleName(notes.slug)}`);
      await admin.end();
    }
    fs.rmSync(appsDir, { recursive: true, force: true });
  });

  test("a new app arrives inactive, with the hash of its files recorded", async () => {
    await release([notes]);
    firstHash = appCodeHash(folder)!;
    assert.deepEqual(await appRow(), {
      is_active: false,
      missing_since: null,
      code_hash: firstHash,
      returned_changed_at: null,
    });

    // What an admin and a user give an app once it is in use.
    await sql`update public.apps set is_active = true where slug = ${notes.slug}`;
    const [{ id: user }] = await sql`
      insert into public.users (email, display_name) values ('user@example.com', 'User') returning id
    `;
    await sql`insert into public.user_app_grants (user_id, app_slug, role) values (${user}, ${notes.slug}, 'editor')`;
    await sql`insert into public.user_apps (user_id, app_slug) values (${user}, ${notes.slug})`;
    await sql`insert into public.app_passwords (app_slug, password_hash) values (${notes.slug}, 'HASH')`;
    await sql`insert into public.dashboard_widgets (user_id, app_slug, widget_id) values (${user}, ${notes.slug}, 'latest')`;
    await sql`insert into public.app_settings (app_slug, key, value) values (${notes.slug}, 'region', 'eu')`;
    await sql`
      insert into public.app_api_keys (app_slug, label, digest, hint)
      values (${notes.slug}, 'CI', ${randomBytes(16).toString("hex")}, 'abcd1234')
    `;
    await sql`
      insert into public.app_scheduled_jobs (app_slug, job_name, interval_minutes, enabled)
      values (${notes.slug}, 'sweep', 60, false)
    `;
    await sql.unsafe(`insert into "${schema}".notes (id, body) values (1, 'kept')`);
    assert.deepEqual(await everything(), ALL_OF_IT);
  });

  test("leaving the build marks the app missing, keeps everything and is audited", async () => {
    await release([]);

    const row = await appRow();
    assert.ok(row?.missing_since instanceof Date, "missing_since was not set");
    assert.equal(row.is_active, true, "the admin's switch was changed");
    assert.equal(row.code_hash, firstHash);
    assert.deepEqual(await everything(), ALL_OF_IT);
    const [{ enabled }] = await sql`
      select enabled from public.app_scheduled_jobs where app_slug = ${notes.slug} and job_name = 'sweep'
    `;
    assert.equal(enabled, false, "the job's switch was changed");

    assert.deepEqual(await audited("app.missing"), [
      {
        actor_id: null,
        actor_email: RELEASE_STEP_ACTOR,
        target_type: "app",
        details: { active: true, codeHash: firstHash },
      },
    ]);

    // A second release without it keeps the first date, and records nothing new.
    await release([]);
    assert.deepEqual((await appRow())?.missing_since, row.missing_since);
    assert.equal((await audited("app.missing")).length, 1);
  });

  test("coming back with the same files, it is as it left", async () => {
    const { missing_since: left } = (await appRow())!;
    await release([notes]);

    assert.deepEqual(await appRow(), {
      is_active: true,
      missing_since: null,
      code_hash: firstHash,
      returned_changed_at: null,
    });
    assert.deepEqual(await everything(), ALL_OF_IT);
    assert.deepEqual(await audited("app.returned"), [
      {
        actor_id: null,
        actor_email: RELEASE_STEP_ACTOR,
        target_type: "app",
        details: {
          codeChanged: false,
          previousCodeHash: firstHash,
          codeHash: firstHash,
          missingSince: left.toISOString(),
          identityChanged: false,
          deactivated: false,
        },
      },
    ]);
  });

  test("coming back with different files, it is switched off and flagged, and keeps its data", async () => {
    await release([]);
    const { missing_since: left } = (await appRow())!;

    fs.writeFileSync(path.join(folder, "api", "notes", "route.ts"), "export const GET = defineRoute({ roles: [] });\n");
    const newHash = appCodeHash(folder)!;
    assert.notEqual(newHash, firstHash);
    await release([notes]);

    const row = await appRow();
    assert.equal(row?.is_active, false);
    assert.equal(row.missing_since, null);
    assert.equal(row.code_hash, newHash);
    assert.ok(row.returned_changed_at instanceof Date, "returned_changed_at was not set");
    assert.deepEqual(await everything(), ALL_OF_IT);

    const returned = await audited("app.returned");
    assert.equal(returned.length, 2);
    assert.deepEqual(returned[1], {
      actor_id: null,
      actor_email: RELEASE_STEP_ACTOR,
      target_type: "app",
      details: {
        codeChanged: true,
        previousCodeHash: firstHash,
        codeHash: newHash,
        missingSince: left.toISOString(),
        identityChanged: false,
        deactivated: true,
      },
    });

    // Another release with those files changes nothing: they are now the
    // recorded ones, and the flag waits for an admin.
    await release([notes]);
    assert.deepEqual(await appRow(), row);
    assert.equal((await audited("app.returned")).length, 2);
  });

  test("files it can't find to hash count as different files", async () => {
    await sql`update public.apps set is_active = true, returned_changed_at = null where slug = ${notes.slug}`;
    await release([]);
    // Back in the registry, with no folder where this release step looks.
    await quietly(() => migrateAppSchemas(sql, { apps: [notes], appsDir: path.join(appsDir, "nowhere") }));

    const row = await appRow();
    assert.equal(row?.is_active, false);
    assert.equal(row.code_hash, null);
    assert.ok(row.returned_changed_at instanceof Date, "returned_changed_at was not set");
    assert.deepEqual(await everything(), ALL_OF_IT);
  });

  test("on the instance, the kept row serves nothing, and activating clears the flag", async () => {
    // The platform's own client, pointed at this database. The registry it
    // reads is this checkout's generated one, which has never heard of this
    // run's slug, so the slug is not in the build it serves.
    process.env.DATABASE_URL = url;
    process.env.PGSSLMODE = new URL(url).searchParams.get("sslmode") ?? "disable";
    const access = await import("../src/lib/apps/access");
    const { sql: platformSql } = await import("../src/lib/db/client");
    try {
      await sql`update public.apps set is_active = true where slug = ${notes.slug}`;
      assert.equal(await access.isAppActive(notes.slug), false, "a slug not in the build was served");

      await sql`update public.apps set is_active = false, returned_changed_at = now() where slug = ${notes.slug}`;
      await access.setAppActive(notes.slug, false);
      assert.ok((await appRow())?.returned_changed_at instanceof Date, "deactivating cleared the flag");
      await access.setAppActive(notes.slug, true);
      const row = await appRow();
      assert.deepEqual([row?.is_active, row?.returned_changed_at], [true, null]);
    } finally {
      await platformSql.end();
    }
  });
});
