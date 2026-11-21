/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The release step's rename carry-over against a real Postgres: what an
 * instance keeps for an app, a connector and a theme follows it to its new slug,
 * whole, once, and never onto a slug that already holds something.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database and roles on. Every name it creates ends in this run's own
 * suffix, and it drops them all when it finishes:
 *
 *   docker run -d --name renames -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55433:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55433/postgres \
 *     npx tsx --test scripts/sync-renames.integration.test.ts
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres, { type Sql } from "postgres";
import { appRoleName, appSchemaName } from "../src/lib/apps/app-identifiers";
import { migrateAppSchemas, type MigratedApp } from "./app-migrations";
import type { ExtensionRename } from "./extension-renames";
import { migratePlatform } from "./platform-migrations";
import { syncRenames } from "./sync-renames";

const REPO = path.resolve(__dirname, "..");
const serverUrl = process.env.MIXOS_TEST_DATABASE_URL;
const skip = serverUrl ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres";

const run = randomBytes(3).toString("hex");
const database = `mixos_renames_${run}`;
const appsDir = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-renames-"));

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

const app = (slug: string): MigratedApp => ({
  slug,
  name: "Notes",
  description: "",
  icon: "notebook",
  database: true,
  updatedAt: [],
  sync: [],
});

/** An app folder at `slug` with one migration. */
function folder(slug: string): void {
  const dir = path.join(appsDir, slug);
  fs.mkdirSync(path.join(dir, "migrations"), { recursive: true });
  fs.writeFileSync(path.join(dir, "app.json"), '{ "name": "Notes", "database": true }\n');
  fs.writeFileSync(path.join(dir, "migrations", "001_notes.sql"), "create table notes (id int primary key, body text not null);\n");
}

describe("a renamed extension's data follows it", { skip }, () => {
  let admin: Sql;
  let sql: Sql;
  let user: string;

  const from = `notes-${run}`;
  const to = `${from}-0000beef`;
  const busy = `busy-${run}`;
  const busyTo = `${busy}-0000beef`;
  const crm = `crm-${run}`;
  const dusk = `dusk-${run}`;
  const rename = (kind: ExtensionRename["kind"], f: string, t: string): ExtensionRename => ({
    kind,
    from: f,
    to: t,
    date: "2026-11-10",
  });
  const LEDGER = [
    rename("app", from, to),
    rename("app", busy, busyTo),
    rename("connector", crm, `${crm}-0000beef`),
    rename("theme", dusk, `${dusk}-0000beef`),
  ];

  /** Everything the instance keeps for an app, counted under `slug`. */
  async function keptFor(slug: string) {
    const [counts] = await sql`
      select
        (select count(*)::int from public.apps where slug = ${slug}) as row,
        (select count(*)::int from public.user_app_grants where app_slug = ${slug}) as grants,
        (select count(*)::int from public.user_apps where app_slug = ${slug}) as installs,
        (select count(*)::int from public.app_passwords where app_slug = ${slug}) as passwords,
        (select count(*)::int from public.dashboard_widgets where app_slug = ${slug}) as widgets,
        (select count(*)::int from public.app_settings where app_slug = ${slug}) as settings,
        (select count(*)::int from public.app_api_keys where app_slug = ${slug}) as keys,
        (select count(*)::int from public.app_scheduled_jobs where app_slug = ${slug}) as jobs,
        (select count(*)::int from public._migrations where app_slug = ${slug}) as migrations,
        (select count(*)::int from public.telemetry_events where source_slug = ${slug} or caller_app_slug = ${slug}) as telemetry,
        (select count(*)::int from public.oauth_tokens where ${slug} = any(granted_apps)) as mcp,
        (select count(*)::int from public.release_notes_seen where note_id like ${`app:${slug}:%`}) as seen,
        (select count(*)::int from public.app_unlock_failures where subject = ${`10.0.0.1::${slug}`}) as lockouts,
        (select count(*)::int from public.user_search_preferences where ${slug} = any(source_order)) as "searchOrder",
        (select count(*)::int from public.user_search_preferences where ${slug} = any(disabled_sources)) as "searchOff",
        (select count(*)::int from public.user_search_preferences
          where ${`${slug}/notes`} = any(disabled_objects)) as "searchObjectOff"
    `;
    return { ...counts };
  }

  const ALL_OF_IT = {
    row: 1,
    grants: 1,
    installs: 1,
    passwords: 1,
    widgets: 1,
    settings: 1,
    keys: 1,
    jobs: 1,
    migrations: 1,
    telemetry: 2,
    mcp: 1,
    seen: 1,
    lockouts: 1,
    searchOrder: 1,
    searchOff: 1,
    searchObjectOff: 1,
  };
  const NONE = Object.fromEntries(Object.keys(ALL_OF_IT).map((k) => [k, 0]));

  before(async () => {
    admin = postgres(serverUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${database}`);
    const u = new URL(serverUrl!);
    u.pathname = `/${database}`;
    sql = postgres(u.toString(), { max: 1, onnotice: () => {} });
    await quietly(() => migratePlatform(sql, path.join(REPO, "supabase", "migrations")));

    folder(from);
    folder(busy);
    await quietly(() => migrateAppSchemas(sql, { apps: [app(from), app(busy)], appsDir }));
    await sql`update public.apps set is_active = true where slug = ${from}`;

    [{ id: user }] = await sql`
      insert into public.users (email, display_name) values ('user@example.com', 'User') returning id
    `;
    await sql`insert into public.user_app_grants (user_id, app_slug, role, role_only) values (${user}, ${from}, 'editor', false)`;
    await sql`insert into public.user_apps (user_id, app_slug) values (${user}, ${from})`;
    await sql`insert into public.app_passwords (app_slug, password_hash) values (${from}, 'HASH')`;
    await sql`insert into public.dashboard_widgets (user_id, app_slug, widget_id) values (${user}, ${from}, 'latest')`;
    await sql`insert into public.app_settings (app_slug, key, value) values (${from}, 'region', 'eu')`;
    await sql`
      insert into public.app_api_keys (app_slug, label, digest, hint)
      values (${from}, 'CI', ${randomBytes(16).toString("hex")}, 'abcd1234')
    `;
    await sql`
      insert into public.app_scheduled_jobs (app_slug, job_name, interval_minutes, enabled)
      values (${from}, 'sweep', 60, false)
    `;
    await sql`
      insert into public.telemetry_events (source_type, source_slug, event_name)
      values ('app', ${from}, 'opened')
    `;
    await sql`
      insert into public.telemetry_events (source_type, source_slug, caller_app_slug, event_name)
      values ('connector', 'mail', ${from}, 'listMessages')
    `;
    await sql`insert into public.oauth_clients (client_id, client_name, redirect_uris) values (${`client-${run}`}, 'Claude', '{}')`;
    await sql`
      insert into public.oauth_tokens (token_hash, token_type, client_id, user_id, granted_apps, expires_at)
      values (${randomBytes(16).toString("hex")}, 'access', ${`client-${run}`}, ${user}, ${[from, "other"]}, now() + interval '1 day')
    `;
    await sql`
      insert into public.release_notes_seen (user_id, note_id, note_date)
      values (${user}, ${`app:${from}:2026-11-01:abcdef012345`}, '2026-11-01')
    `;
    await sql`insert into public.app_unlock_failures (subject, failures) values (${`10.0.0.1::${from}`}, 2)`;
    await sql`
      insert into public.user_search_preferences (user_id, source_order, disabled_sources, disabled_objects)
      values (${user}, ${["@apps", from, "other"]}::text[], ${[from]}::text[], ${["other/notes", `${from}/notes`]}::text[])
    `;
    await sql.unsafe(`insert into "${appSchemaName(from)}".notes (id, body) values (1, 'kept')`);

    // The busy app's new slug already holds a grant: a build without the
    // ledger ran first, and someone was given the new app.
    await sql`insert into public.apps (slug, name) values (${busyTo}, 'Busy')`;
    await sql`insert into public.user_app_grants (user_id, app_slug, role, role_only) values (${user}, ${busyTo}, null, false)`;

    // A connector with credentials, a user's connection, and an admin's switches.
    await sql`insert into public.connector_configs (connector_name, encrypted_credentials) values (${crm}, 'ENC')`;
    await sql`insert into public.user_connector_oauth (user_id, connector_name, encrypted_credentials) values (${user}, ${crm}, 'ENC')`;
    await sql`
      insert into public.platform_settings (key, value) values
        (${`connector.disabled.${crm}`}, 'true'),
        (${`connector.identity.${crm}`}, 'local'),
        ('theme', ${dusk}),
        (${`theme.identity.${dusk}`}, 'local')
    `;
    assert.deepEqual(await keptFor(from), ALL_OF_IT);
  });

  after(async () => {
    await sql?.end();
    if (admin) {
      await admin.unsafe(`drop database if exists ${database} with (force)`);
      for (const slug of [from, to, busy, busyTo]) await admin.unsafe(`drop role if exists "${appRoleName(slug)}"`);
      await admin.end();
    }
    fs.rmSync(appsDir, { recursive: true, force: true });
  });

  test("an app's row, everything that names it, its schema and its role move to the new slug", async () => {
    const results = await syncRenames(sql, LEDGER);
    assert.deepEqual(
      results.map((r) => `${r.rename.kind} ${r.rename.from}: ${r.outcome}`),
      [`app ${from}: moved`, `app ${busy}: skipped`, `connector ${crm}: moved`, `theme ${dusk}: moved`],
    );

    assert.deepEqual(await keptFor(to), ALL_OF_IT);
    assert.deepEqual(await keptFor(from), NONE);
    // In the same place in the person's search order, not appended at the end.
    const [prefs] = await sql`
      select source_order, disabled_objects from public.user_search_preferences where user_id = ${user}
    `;
    assert.deepEqual(prefs.source_order, ["@apps", to, "other"]);
    assert.deepEqual(prefs.disabled_objects, ["other/notes", `${to}/notes`]);
    const [row] = await sql`select is_active, missing_since from public.apps where slug = ${to}`;
    assert.deepEqual({ ...row }, { is_active: true, missing_since: null });

    const [{ body }] = await sql.unsafe(`select body from "${appSchemaName(to)}".notes where id = 1`);
    assert.equal(body, "kept");
    const [{ owner }] = await sql`
      select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = ${appSchemaName(to)}
    `;
    assert.equal(owner, appRoleName(to));
    assert.equal((await sql`select 1 from pg_namespace where nspname = ${appSchemaName(from)}`).length, 0);

    const [{ granted }] = await sql`select granted_apps as granted from public.oauth_tokens`;
    assert.deepEqual(granted, [to, "other"]);
  });

  test("the next release step sees the app as it was, under its new name", async () => {
    folder(to);
    await quietly(() => migrateAppSchemas(sql, { apps: [app(to)], appsDir }));
    const [row] = await sql`select is_active, returned_changed_at, identity_changed_at from public.apps where slug = ${to}`;
    assert.deepEqual({ ...row }, { is_active: true, returned_changed_at: null, identity_changed_at: null });
    // Its migration ran once, before the rename, and wasn't run again.
    assert.equal((await keptFor(to)).migrations, 1);
  });

  test("a new slug that already holds something is never merged into", async () => {
    assert.equal((await keptFor(busy)).row, 1);
    assert.equal((await sql`select 1 from pg_namespace where nspname = ${appSchemaName(busy)}`).length, 1);
    const [skipped] = await sql`
      select details from public.admin_audit_log where action = 'app.rename.skipped' and target_id = ${busyTo}
    `;
    assert.match(skipped.details.reason, /user_app_grants/);
  });

  test("a connector's credentials, its users' connections and its switches follow it", async () => {
    const next = `${crm}-0000beef`;
    const [{ configs, connections }] = await sql`
      select
        (select count(*)::int from public.connector_configs where connector_name = ${next}) as configs,
        (select count(*)::int from public.user_connector_oauth where connector_name = ${next}) as connections
    `;
    assert.deepEqual({ configs, connections }, { configs: 1, connections: 1 });
    const keys = (await sql`select key from public.platform_settings where key like ${`connector.%.${crm}%`} order by key`).map(
      (r) => r.key,
    );
    assert.deepEqual(keys, [`connector.disabled.${next}`, `connector.identity.${next}`]);
  });

  test("the applied theme follows its theme", async () => {
    const [{ value }] = await sql`select value from public.platform_settings where key = 'theme'`;
    assert.equal(value, `${dusk}-0000beef`);
  });

  test("each move is audited, and a second run moves nothing", async () => {
    const actions = (await sql`select action from public.admin_audit_log where action like '%renamed' order by action`).map(
      (r) => r.action,
    );
    assert.deepEqual(actions, ["app.renamed", "connector.renamed", "theme.renamed"]);

    const again = await syncRenames(sql, LEDGER);
    assert.deepEqual(
      again.map((r) => r.outcome),
      ["nothing", "skipped", "nothing", "nothing"],
    );
    assert.deepEqual(await keptFor(to), ALL_OF_IT);
  });
});
