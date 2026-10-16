/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Delete data against a real Postgres, run as a role that is not a superuser:
 * the shape of a hosted database, where the role in DATABASE_URL owns the
 * database and may create roles, and no more.
 *
 * What it proves:
 *
 *   - every refusal: a name that isn't one, nothing kept, the serving build
 *     has it, no release step's mark, another build seen in the last 24 hours
 *     has it (and the caller's own build doesn't count), a shared database
 *     right after removal, the release step's lock held, a schema that isn't
 *     the app's and a role with a power MixOS never gives;
 *   - nothing outside the extension is touched, by a before-and-after of every
 *     platform table, both apps' schemas, and the schemas and roles there are,
 *     with an app whose slug the first's starts (`notes…` and
 *     `notes…_archive`) and two connectors named the same way;
 *   - the audit log is kept, and gains the deletion's row;
 *   - one transaction: a failure after the rows are deleted and the schema is
 *     dropped leaves everything as it was;
 *   - the release step marks a connector its build lacks and clears the mark
 *     when it comes back, and a later app under a deleted slug inherits nothing.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database and roles on. Every name it creates ends in this run's own
 * suffix, and it drops them all when it finishes:
 *
 *   docker run -d --name deldata -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test src/lib/repository/delete-data.integration.test.ts
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres, { type Sql } from "postgres";
import { migrateAppSchemas, type MigratedApp } from "../../../scripts/app-migrations";
import { takeMigrationLock } from "../../../scripts/migration-lock";
import { migratePlatform } from "../../../scripts/platform-migrations";
import { RELEASE_STEP_ACTOR } from "../../../scripts/sync-app-registry";
import { syncIdentities } from "../../../scripts/sync-identities";
import type { AdminActor } from "../apps/admin-audit";
import { appRoleName, appSchemaName } from "../apps/app-identifiers";
import type { SyncDefinition } from "../apps/types";
import { recordBuildSeen } from "../platform/builds-seen";
import {
  DataRefusalError,
  deleteExtensionData,
  previewExtensionData,
  type DataCheckOptions,
  type DataRefusalCode,
} from "./delete-data";
import type { AppDataCounts, ConnectorDataCounts } from "./delete-data-outcomes";

const REPO = path.resolve(__dirname, "..", "..", "..");
const serverUrl = process.env.MIXOS_TEST_DATABASE_URL;
const skip = serverUrl ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres";

// Roles belong to the server, not to a database, so every name is this run's.
const run = randomBytes(3).toString("hex");
const database = `mixos_deldata_${run}`;
const owner = `mixos_deldata_owner_${run}`;
const password = randomBytes(12).toString("hex");
const appsDir = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-delete-data-"));

/** The app whose data goes. */
const NOTES = `notes${run}`;
/** Its slug starts with NOTES's, and so do its schema's and role's names: none of it may go. */
const ARCHIVE = `notes${run}_archive`;
/** A connector whose data goes, and one whose name starts with its name. */
const CRM = `crm${run}`;
const CRM_EU = `crm${run}_eu`;

const ADMIN: AdminActor = { id: null, email: "admin@example.com" };

const SYNC: SyncDefinition[] = [
  {
    name: "feed",
    schedule: { everyMinutes: 60 },
    source: "mixos",
    window: { coldStartDays: 7, defaultDays: 1, minDays: 1 },
    budgetMs: 10_000,
  },
];

function app(slug: string): MigratedApp {
  return {
    slug,
    name: slug === NOTES ? "Notes" : "Notes Archive",
    description: "",
    icon: "notebook",
    database: true,
    updatedAt: [{ table: "notes", column: "updated_at" }],
    sync: SYNC,
  };
}

function migration(slug: string, text: string): void {
  const dir = path.join(appsDir, slug, "migrations");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "001_notes.sql"), text);
  fs.writeFileSync(path.join(appsDir, slug, "app.json"), `{ "name": "${slug}", "database": true }\n`);
}

const NOTES_SQL = [
  "create table notes (id int primary key, body text not null, updated_at timestamptz not null default now());",
  "create table tags (note_id int not null references notes(id) on delete cascade, tag text not null, primary key (note_id, tag));",
  "create view recent as select id, body from notes;",
].join("\n");

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

type Snapshot = Map<string, string[]>;
type Change = { removed: Record<string, unknown>[]; added: Record<string, unknown>[] };

describe("Delete data against a real database", { skip }, () => {
  let admin: Sql;
  /** The platform's connection: the database's owner, not a superuser. */
  let sql: Sql;
  let ownerUrl: string;
  const notes = app(NOTES);
  const archive = app(ARCHIVE);

  /** One release step, for a build that carries `apps`. */
  const release = (apps: MigratedApp[]) => quietly(() => migrateAppSchemas(sql, { apps, appsDir, installs: [] }));
  const releaseConnectors = (connectors: string[]) =>
    syncIdentities(sql, { connectors, themes: [], installs: [] });

  /** What the checks are told about this server. */
  const asked = (extra: Partial<DataCheckOptions> = {}): DataCheckOptions => ({
    inServingBuild: false,
    ownBuildKey: null,
    sql,
    ...extra,
  });

  async function refusedWith(code: DataRefusalCode, fn: () => Promise<unknown>): Promise<DataRefusalError> {
    try {
      await fn();
    } catch (err) {
      assert.ok(err instanceof DataRefusalError, `expected a refusal, got ${String(err)}`);
      assert.equal(err.code, code, err.message);
      return err;
    }
    assert.fail(`expected it to be refused with ${code}`);
  }

  /**
   * Everything a deletion could reach: every row of every platform table, every
   * row of every table in both apps' schemas, and the schemas, roles and
   * relations there are.
   */
  async function snapshot(): Promise<Snapshot> {
    const out: Snapshot = new Map();
    const tables = await sql<{ schema: string; name: string }[]>`
      select table_schema as schema, table_name as name from information_schema.tables
      where table_type = 'BASE TABLE' and table_schema = any(${["public", appSchemaName(NOTES), appSchemaName(ARCHIVE)]})
      order by 1, 2
    `;
    for (const { schema, name } of tables) {
      const rows = await sql.unsafe<{ row: string }[]>(`select to_jsonb(t)::text as row from "${schema}"."${name}" t`);
      out.set(`${schema}.${name}`, rows.map((r) => r.row).sort());
    }
    const schemas = await sql<{ name: string }[]>`
      select nspname as name from pg_namespace where nspname !~ '^pg_' order by 1
    `;
    out.set("schemas", schemas.map((r) => r.name));
    const roles = await sql<{ name: string }[]>`
      select rolname as name from pg_roles where rolname like ${`%${run}%`} order by 1
    `;
    out.set("roles", roles.map((r) => r.name));
    const relations = await sql<{ name: string }[]>`
      select n.nspname || '.' || c.relname || ':' || c.relkind::text as name
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
      order by 1
    `;
    out.set("relations", relations.map((r) => r.name));
    return out;
  }

  /** What changed between two snapshots, by what was there. */
  function changes(before: Snapshot, after: Snapshot): Map<string, Change> {
    const out = new Map<string, Change>();
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const a = [...(before.get(key) ?? [])];
      const b = [...(after.get(key) ?? [])];
      const removed: string[] = [];
      for (const row of a) {
        const i = b.indexOf(row);
        if (i >= 0) b.splice(i, 1);
        else removed.push(row);
      }
      if (removed.length === 0 && b.length === 0) continue;
      const parse = (row: string) => (row.startsWith("{") ? JSON.parse(row) : { name: row });
      out.set(key, { removed: removed.map(parse), added: b.map(parse) });
    }
    return out;
  }

  before(async () => {
    admin = postgres(serverUrl!, { max: 1, onnotice: () => {} });
    const [{ superuser }] = await admin<{ superuser: boolean }[]>`
      select rolsuper as superuser from pg_roles where rolname = current_user
    `;
    await admin.unsafe(`create role ${owner} login createrole password '${password}'`);
    if (!superuser) await admin.unsafe(`grant ${owner} to current_user`);
    await admin.unsafe(`create database ${database} owner ${owner}`);
    const url = new URL(serverUrl!);
    url.username = owner;
    url.password = password;
    url.pathname = `/${database}`;
    ownerUrl = url.toString();
    sql = postgres(ownerUrl, { max: 1, onnotice: () => {} });
    await quietly(() => migratePlatform(sql, path.join(REPO, "supabase", "migrations")));

    migration(NOTES, NOTES_SQL);
    migration(ARCHIVE, NOTES_SQL);
    await release([notes, archive]);

    // Everything an app keeps, for both, so whatever goes for one is seen to stay for the other.
    const [{ id: user }] = await sql`
      insert into public.users (email, display_name) values ('user@example.com', 'User') returning id
    `;
    await sql`
      insert into public.oauth_clients (client_id, client_name, redirect_uris)
      values ('client-a', 'Client', ${["https://client.example/cb"]})
    `;
    for (const slug of [NOTES, ARCHIVE]) {
      await sql`update public.apps set is_active = true where slug = ${slug}`;
      await sql`insert into public.user_app_grants (user_id, app_slug, role) values (${user}, ${slug}, 'editor')`;
      await sql`insert into public.user_apps (user_id, app_slug) values (${user}, ${slug})`;
      await sql`insert into public.app_passwords (app_slug, password_hash) values (${slug}, 'HASH')`;
      await sql`insert into public.dashboard_widgets (user_id, app_slug, widget_id) values (${user}, ${slug}, 'latest')`;
      await sql`insert into public.app_settings (app_slug, key, value) values (${slug}, 'region', 'eu')`;
      await sql`
        insert into public.app_api_keys (app_slug, label, digest, hint)
        values (${slug}, 'CI', ${randomBytes(16).toString("hex")}, 'abcd1234')
      `;
      await sql`
        insert into public.app_mcp_tool_settings (app_slug, tool_name, enabled, updated_by)
        values (${slug}, 'search', true, ${user})
      `;
      await sql`
        insert into public.app_scheduled_jobs (app_slug, job_name, interval_minutes) values (${slug}, 'sweep', 60)
      `;
      await sql`
        insert into public.app_job_runs (app_slug, job_name, status) values (${slug}, 'sweep', 'ok')
      `;
      await sql`insert into public.app_open_events (user_id, app_slug) values (${user}, ${slug})`;
      for (const type of ["app", "route", "service", "mcp"]) {
        await sql`
          insert into public.telemetry_events (source_type, source_slug, caller_app_slug, event_name)
          values (${type}, ${slug}, ${type === "mcp" ? "client-a" : null}, 'used')
        `;
      }
      const schema = appSchemaName(slug);
      await sql.unsafe(`insert into "${schema}".notes (id, body) values (1, 'kept'), (2, 'also kept')`);
      await sql.unsafe(`insert into "${schema}".tags (note_id, tag) values (1, 'a')`);
      await sql.unsafe(`insert into "${schema}"._sync_state (name, last_status) values ('feed', 'ok')`);
    }
    // Calls NOTES made: a connector's telemetry and another app's service's. Theirs, so they stay.
    await sql`
      insert into public.telemetry_events (source_type, source_slug, caller_app_slug, event_name)
      values ('connector', ${CRM}, ${NOTES}, 'list'), ('service', ${ARCHIVE}, ${NOTES}, 'search')
    `;
    // MCP authorizations: one lists both apps, one ARCHIVE alone, a code NOTES alone.
    await sql`
      insert into public.oauth_tokens (token_hash, token_type, client_id, user_id, granted_apps, expires_at)
      values
        ('token-both', 'access', 'client-a', ${user}, ${[NOTES, ARCHIVE]}, now() + interval '1 hour'),
        ('token-archive', 'refresh', 'client-a', ${user}, ${[ARCHIVE]}, now() + interval '1 day')
    `;
    await sql`
      insert into public.oauth_authorization_codes
        (code_hash, client_id, user_id, redirect_uri, code_challenge, granted_apps, expires_at)
      values ('code-notes', 'client-a', ${user}, 'https://client.example/cb', 'challenge', ${[NOTES]}, now() + interval '1 minute')
    `;

    // Everything a connector keeps, for both.
    for (const name of [CRM, CRM_EU]) {
      await sql`insert into public.connector_configs (connector_name, encrypted_credentials) values (${name}, 'SEALED')`;
      await sql`
        insert into public.user_connector_oauth (user_id, connector_name, encrypted_credentials)
        values (${user}, ${name}, 'SEALED')
      `;
      await sql`
        insert into public.connector_scope_status (connector_name, user_id, scope, status)
        values (${name}, null, 'read', 'granted'), (${name}, ${user}, 'read', 'granted')
      `;
      await sql`
        insert into public.connector_webhook_events (event_key, connector_name) values (${`event-${name}`}, ${name})
      `;
      await sql`
        insert into public.telemetry_events (source_type, source_slug, caller_app_slug, event_name)
        values ('connector', ${name}, ${ARCHIVE}, 'get')
      `;
      await sql`
        insert into public.platform_settings (key, value)
        values (${`connector.disabled.${name}`}, '2026-10-01T00:00:00.000Z'), (${`connector.replaced.${name}`}, 'local')
      `;
    }
    await quietly(() => releaseConnectors([CRM, CRM_EU]));
  });

  after(async () => {
    await sql?.end();
    if (admin) {
      await admin.unsafe(`drop database if exists ${database} with (force)`);
      for (const role of await admin<{ rolname: string }[]>`
        select rolname from pg_roles where rolname like ${`mixos_app_%${run}%`}
      `) {
        await admin.unsafe(`drop role if exists "${role.rolname}"`);
      }
      await admin.unsafe(`drop role if exists ${owner}`);
      await admin.end();
    }
    fs.rmSync(appsDir, { recursive: true, force: true });
  });

  test("a name that isn't one, or with nothing kept, is refused", async () => {
    await refusedWith("not-a-name", () => deleteExtensionData("app", "Notes!", { ...asked(), actor: ADMIN }));
    await refusedWith("not-a-name", () => previewExtensionData("connector", "../crm", asked()));
    await refusedWith("nothing-kept", () => deleteExtensionData("app", `ghost${run}`, { ...asked(), actor: ADMIN }));
    await refusedWith("nothing-kept", () => deleteExtensionData("connector", `ghost${run}`, { ...asked(), actor: ADMIN }));
  });

  test("an app the serving build has, or that no release step marked, is refused, and nothing changes", async () => {
    const before = await snapshot();
    await refusedWith("in-this-build", () =>
      deleteExtensionData("app", NOTES, { ...asked({ inServingBuild: true }), actor: ADMIN }),
    );
    const unmarked = await refusedWith("not-marked", () => deleteExtensionData("app", NOTES, { ...asked(), actor: ADMIN }));
    assert.match(unmarked.message, /No release step has run on this database without notes\w+ yet/);
    assert.deepEqual(changes(before, await snapshot()), new Map());

    // What the preview says before it.
    const preview = await previewExtensionData("app", NOTES, asked());
    assert.equal(preview.refusal?.code, "not-marked");
    assert.equal(preview.markedAt, null);
    assert.equal(preview.schema, appSchemaName(NOTES));
    assert.equal(preview.role, appRoleName(NOTES));
    assert.deepEqual(preview.counts, {
      tables: 3,
      grants: 1,
      installs: 1,
      passwords: 1,
      widgets: 1,
      settings: 1,
      apiKeys: 1,
      mcpToolSwitches: 1,
      scheduledJobs: 1,
      jobRuns: 1,
      migrations: 1,
      telemetryEvents: 4,
      appOpens: 1,
      mcpAccess: 2,
    } satisfies AppDataCounts);
  });

  test("right after Remove, the removal stands in for the mark on a local database only", async () => {
    // ARCHIVE has no mark: as it would be in a checkout that has just removed it.
    const shared = await previewExtensionData(
      "app",
      ARCHIVE,
      asked({ afterRemoval: { localDatabase: false, hosts: "db.example.com" } }),
    );
    assert.equal(shared.refusal?.code, "shared-database");
    assert.match(shared.refusal!.message, /db\.example\.com, which other instances may use too/);
    const local = await previewExtensionData(
      "app",
      ARCHIVE,
      asked({ afterRemoval: { localDatabase: true, hosts: "localhost" } }),
    );
    assert.equal(local.refusal, null);
  });

  test("another build seen in the last 24 hours that has it refuses it; the caller's own build doesn't", async () => {
    await release([archive]);
    const [{ missing_since: marked }] = await sql`select missing_since from public.apps where slug = ${NOTES}`;
    assert.ok(marked instanceof Date, "the release step didn't mark it");

    const other = `build:abc1234def567890abc1234def567890abc12345:0123456789abcdef`;
    await recordBuildSeen(sql, { key: other, apps: [NOTES, ARCHIVE], connectors: [CRM] });
    const before = await snapshot();
    const refused = await refusedWith("carried-elsewhere", () =>
      deleteExtensionData("app", NOTES, { ...asked(), actor: ADMIN }),
    );
    assert.match(refused.message, /a build of commit abc1234, seen just now/);
    assert.deepEqual(changes(before, await snapshot()), new Map());

    // A day and an hour later it no longer counts.
    await sql`update public.platform_builds_seen set last_seen_at = now() - interval '25 hours' where build_key = ${other}`;
    assert.equal((await previewExtensionData("app", NOTES, asked())).refusal, null);

    // The caller's own record, from before it removed the app, doesn't count; anyone else's would.
    const own = `checkout:${"0".repeat(32)}`;
    await recordBuildSeen(sql, { key: own, apps: [NOTES, ARCHIVE], connectors: [] });
    assert.equal((await previewExtensionData("app", NOTES, asked({ ownBuildKey: own }))).refusal, null);
    assert.equal((await previewExtensionData("app", NOTES, asked())).refusal?.code, "carried-elsewhere");
  });

  test("while the release step's lock is held it waits, then refuses as busy, and nothing changes", async () => {
    const holder = postgres(ownerUrl, { max: 1, onnotice: () => {} });
    let let_go!: () => void;
    const holding = new Promise<void>((held) => {
      void holder.begin(async (tx) => {
        await takeMigrationLock(tx);
        held();
        await new Promise<void>((resolve) => (let_go = resolve));
      });
    });
    await holding;
    try {
      const before = await snapshot();
      await refusedWith("busy", () =>
        deleteExtensionData("app", NOTES, { ...asked({ ownBuildKey: `checkout:${"0".repeat(32)}` }), actor: ADMIN, lockTimeoutMs: 300 }),
      );
      assert.deepEqual(changes(before, await snapshot()), new Map());
    } finally {
      let_go();
      await holder.end();
    }
  });

  test("a schema that isn't the app's, or a role MixOS didn't make, is left alone and refused", async () => {
    const stray = `stray${run}`;
    await sql`insert into public.apps (slug, name, missing_since) values (${stray}, 'Stray', now())`;
    await sql.unsafe(`create schema "${appSchemaName(stray)}"`);
    const notIts = await refusedWith("not-its-schema", () =>
      deleteExtensionData("app", stray, { ...asked(), actor: ADMIN }),
    );
    assert.match(notIts.message, new RegExp(`belongs to ${owner}, not to ${appRoleName(stray)}`));
    const [{ exists }] = await sql`select exists (select 1 from pg_namespace where nspname = ${appSchemaName(stray)}) as exists`;
    assert.equal(exists, true);

    const logs = `logs${run}`;
    await sql`insert into public.apps (slug, name, missing_since) values (${logs}, 'Logs', now())`;
    await sql.unsafe(`create role "${appRoleName(logs)}" login`);
    const role = await refusedWith("role-not-its-own", () => deleteExtensionData("app", logs, { ...asked(), actor: ADMIN }));
    assert.match(role.message, /has LOGIN, which MixOS never gives an app's role/);
    const [{ count }] = await sql`select count(*)::int as count from pg_roles where rolname = ${appRoleName(logs)}`;
    assert.equal(count, 1);
  });

  const own = { ownBuildKey: `checkout:${"0".repeat(32)}` };

  test("one transaction: a view outside the schema that dropping it would take refuses it, after the rows went", async () => {
    // Made by hand, outside the app's schema, on the app's table.
    await sql.unsafe(`create view public.digest_${run} as select id from "${appSchemaName(NOTES)}".notes`);
    const before = await snapshot();
    const refused = await refusedWith("outside-schema", () =>
      deleteExtensionData("app", NOTES, { ...asked(own), actor: ADMIN }),
    );
    assert.match(refused.message, new RegExp(`would also drop view public\\.digest_${run}`));
    assert.deepEqual(changes(before, await snapshot()), new Map(), "something changed after the refusal");
    await sql.unsafe(`drop view public.digest_${run}`);
  });

  test("one transaction: a role that holds something outside its schema refuses it, after the schema was dropped", async () => {
    await sql.unsafe(`grant select on public.users to "${appRoleName(NOTES)}"`);
    const before = await snapshot();
    await refusedWith("role-holds-more", () => deleteExtensionData("app", NOTES, { ...asked(own), actor: ADMIN }));
    assert.deepEqual(changes(before, await snapshot()), new Map(), "something changed after the refusal");
    await sql.unsafe(`revoke select on public.users from "${appRoleName(NOTES)}"`);
  });

  test("an app's data goes: its schema, its role and its rows, and nothing else", async () => {
    const [{ count: auditBefore }] = await sql`
      select count(*)::int as count from public.admin_audit_log where target_id = ${NOTES}
    `;
    assert.ok(auditBefore > 0, "the release step's rows for it were expected");
    const before = await snapshot();

    const result = await deleteExtensionData("app", NOTES, { ...asked(own), actor: ADMIN });
    assert.deepEqual(result, {
      kind: "app",
      slug: NOTES,
      counts: {
        tables: 3,
        grants: 1,
        installs: 1,
        passwords: 1,
        widgets: 1,
        settings: 1,
        apiKeys: 1,
        mcpToolSwitches: 1,
        scheduledJobs: 1,
        jobRuns: 1,
        migrations: 1,
        telemetryEvents: 4,
        appOpens: 1,
        mcpAccess: 2,
      },
      schema: appSchemaName(NOTES),
      role: appRoleName(NOTES),
    });

    const changed = changes(before, await snapshot());
    const keyedBy = (column: string) => (row: Record<string, unknown>) => row[column] === NOTES;
    // Every row that went is NOTES's, and every one of NOTES's went.
    for (const [table, column] of [
      ["public.apps", "slug"],
      ["public.user_app_grants", "app_slug"],
      ["public.user_apps", "app_slug"],
      ["public.app_passwords", "app_slug"],
      ["public.dashboard_widgets", "app_slug"],
      ["public.app_settings", "app_slug"],
      ["public.app_api_keys", "app_slug"],
      ["public.app_mcp_tool_settings", "app_slug"],
      ["public.app_scheduled_jobs", "app_slug"],
      ["public.app_job_runs", "app_slug"],
      ["public._migrations", "app_slug"],
      ["public.app_open_events", "app_slug"],
    ] as const) {
      const change = changed.get(table);
      assert.ok(change, `${table} didn't change`);
      assert.ok(change.removed.length > 0 && change.removed.every(keyedBy(column)), `${table}: ${JSON.stringify(change)}`);
      assert.deepEqual(change.added, [], table);
      assert.equal(
        (before.get(table) ?? []).filter((r) => keyedBy(column)(JSON.parse(r))).length,
        change.removed.length,
        `${table} kept some of its rows`,
      );
      changed.delete(table);
    }

    // Its telemetry: what it was the source of. The calls it made are the connector's and ARCHIVE's.
    const telemetry = changed.get("public.telemetry_events")!;
    assert.deepEqual(
      telemetry.removed.map((r) => `${r.source_type}:${r.source_slug}`).sort(),
      ["app", "mcp", "route", "service"].map((t) => `${t}:${NOTES}`),
    );
    assert.deepEqual(telemetry.added, []);
    changed.delete("public.telemetry_events");
    const [{ calls }] = await sql`
      select count(*)::int as calls from public.telemetry_events where caller_app_slug = ${NOTES}
    `;
    assert.equal(calls, 2, "the calls it made went with it");

    // MCP authorizations keep every other app they list.
    const tokens = changed.get("public.oauth_tokens")!;
    assert.deepEqual(tokens.removed.map((r) => [r.token_hash, r.granted_apps]), [["token-both", [NOTES, ARCHIVE]]]);
    assert.deepEqual(tokens.added.map((r) => [r.token_hash, r.granted_apps]), [["token-both", [ARCHIVE]]]);
    changed.delete("public.oauth_tokens");
    const codes = changed.get("public.oauth_authorization_codes")!;
    assert.deepEqual(codes.added.map((r) => [r.code_hash, r.granted_apps]), [["code-notes", []]]);
    changed.delete("public.oauth_authorization_codes");

    // The audit log only gains the deletion's row.
    const audit = changed.get("public.admin_audit_log")!;
    assert.deepEqual(audit.removed, []);
    assert.equal(audit.added.length, 1);
    assert.equal(audit.added[0].action, "app.data.delete");
    assert.equal(audit.added[0].target_id, NOTES);
    assert.equal(audit.added[0].actor_email, ADMIN.email);
    assert.deepEqual((audit.added[0].details as { counts: unknown }).counts, result.counts);
    changed.delete("public.admin_audit_log");
    const [{ count: auditAfter }] = await sql`
      select count(*)::int as count from public.admin_audit_log where target_id = ${NOTES}
    `;
    assert.equal(auditAfter, auditBefore + 1, "the audit log lost a row");

    // Its schema's tables, its schema, its role, and the relations in it.
    for (const table of ["notes", "tags", "_sync_state"]) {
      const change = changed.get(`${appSchemaName(NOTES)}.${table}`);
      assert.ok(change && change.added.length === 0, table);
      changed.delete(`${appSchemaName(NOTES)}.${table}`);
    }
    assert.deepEqual(changed.get("schemas"), { removed: [{ name: appSchemaName(NOTES) }], added: [] });
    changed.delete("schemas");
    assert.deepEqual(changed.get("roles"), { removed: [{ name: appRoleName(NOTES) }], added: [] });
    changed.delete("roles");
    const relations = changed.get("relations")!;
    assert.ok(relations.removed.every((r) => String(r.name).startsWith(`${appSchemaName(NOTES)}.`)));
    assert.deepEqual(relations.added, []);
    changed.delete("relations");

    // And nothing else: not ARCHIVE's rows, schema or role, nor any connector's.
    assert.deepEqual([...changed.keys()], [], `more changed: ${JSON.stringify([...changed])}`);
    const [kept] = await sql`
      select
        exists (select 1 from pg_namespace where nspname = ${appSchemaName(ARCHIVE)}) as schema,
        exists (select 1 from pg_roles where rolname = ${appRoleName(ARCHIVE)}) as role
    `;
    assert.deepEqual({ ...kept }, { schema: true, role: true });
    const [{ rows }] = await sql.unsafe(`select count(*)::int as rows from "${appSchemaName(ARCHIVE)}".notes`);
    assert.equal(rows, 2);
  });

  test("a later app under the deleted slug inherits nothing", async () => {
    // Different files: before the deletion, the release step would bring it
    // back switched off and flagged, with its old grants.
    migration(NOTES, "create table entries (id int primary key);\n");
    await release([{ ...notes, updatedAt: [] }, archive]);
    const [row] = await sql`
      select is_active, missing_since, returned_changed_at, identity, identity_changed_at
      from public.apps where slug = ${NOTES}
    `;
    assert.deepEqual(
      { ...row },
      { is_active: false, missing_since: null, returned_changed_at: null, identity: "local", identity_changed_at: null },
    );
    const [held] = await sql`
      select
        (select count(*)::int from public.user_app_grants where app_slug = ${NOTES}) as grants,
        (select count(*)::int from public.app_settings where app_slug = ${NOTES}) as settings,
        (select count(*)::int from public.app_api_keys where app_slug = ${NOTES}) as keys,
        (select count(*)::int from public.app_mcp_tool_settings where app_slug = ${NOTES}) as switches,
        (select count(*)::int from public.oauth_tokens where ${NOTES} = any(granted_apps)) as mcp
    `;
    assert.deepEqual({ ...held }, { grants: 0, settings: 0, keys: 0, switches: 0, mcp: 0 });
    const [{ returned }] = await sql`
      select count(*)::int as returned from public.admin_audit_log
      where action = 'app.returned' and target_id = ${NOTES}
    `;
    assert.equal(returned, 0, "it came back as the old app");
    const tables = await sql`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${appSchemaName(NOTES)} and c.relkind = 'r' order by 1
    `;
    assert.deepEqual(tables.map((t) => t.relname), ["_sync_state", "entries"]);
  });

  test("the release step marks a connector its build lacks, and clears the mark when it comes back", async () => {
    const maps = `maps${run}`;
    const result = await releaseConnectors([CRM_EU, maps]);
    assert.deepEqual(result.missing, [CRM]);
    const [{ value: since }] = await sql`select value from public.platform_settings where key = ${`connector.missing.${CRM}`}`;
    assert.ok(!Number.isNaN(Date.parse(since)));
    // A connector with no credentials, and one in the build, aren't marked.
    const marks = await sql`
      select key from public.platform_settings where key like ${`connector.missing.%${run}%`} order by key
    `;
    assert.deepEqual(marks.map((m) => m.key), [`connector.missing.${CRM}`]);
    const [missing] = await sql`
      select actor_id, actor_email, details from public.admin_audit_log
      where action = 'connector.missing' and target_id = ${CRM}
    `;
    assert.deepEqual({ ...missing }, { actor_id: null, actor_email: RELEASE_STEP_ACTOR, details: { credentials: true, connections: 1 } });

    // A second run without it keeps the first date.
    await releaseConnectors([CRM_EU, maps]);
    const [{ value: still }] = await sql`select value from public.platform_settings where key = ${`connector.missing.${CRM}`}`;
    assert.equal(still, since);

    // Back, and gone again: the mark goes with an audit row, and comes back.
    const back = await releaseConnectors([CRM, CRM_EU]);
    assert.deepEqual(back.returned, [CRM]);
    const [returned] = await sql`
      select details from public.admin_audit_log where action = 'connector.returned' and target_id = ${CRM}
    `;
    assert.deepEqual(returned.details, { missingSince: since });
    await releaseConnectors([CRM_EU]);
  });

  test("a connector's data goes: its credentials, connections and keys, and nothing else", async () => {
    // Another build that has it refuses it, as for an app.
    const other = "build:unknown:fedcba9876543210";
    await recordBuildSeen(sql, { key: other, apps: [], connectors: [CRM, CRM_EU] });
    await refusedWith("carried-elsewhere", () => deleteExtensionData("connector", CRM, { ...asked(), actor: ADMIN }));
    await sql`delete from public.platform_builds_seen where build_key = ${other}`;

    const preview = await previewExtensionData("connector", CRM, asked());
    assert.equal(preview.refusal, null);
    assert.ok(preview.markedAt);
    const before = await snapshot();
    const result = await deleteExtensionData("connector", CRM, { ...asked(), actor: ADMIN });
    assert.deepEqual(result.counts, {
      credentials: 1,
      connections: 1,
      scopeStatus: 2,
      webhookEvents: 1,
      // Its own call, and the one NOTES made.
      telemetryEvents: 2,
      // The mark, its identity, the switch and the replaced mark.
      settings: 4,
    } satisfies ConnectorDataCounts);

    const changed = changes(before, await snapshot());
    for (const [table, column] of [
      ["public.connector_configs", "connector_name"],
      ["public.user_connector_oauth", "connector_name"],
      ["public.connector_scope_status", "connector_name"],
      ["public.connector_webhook_events", "connector_name"],
      ["public.telemetry_events", "source_slug"],
    ] as const) {
      const change = changed.get(table)!;
      assert.ok(change.removed.length > 0 && change.removed.every((r) => r[column] === CRM), table);
      assert.deepEqual(change.added, [], table);
      changed.delete(table);
    }
    const settings = changed.get("public.platform_settings")!;
    assert.deepEqual(
      settings.removed.map((r) => r.key).sort(),
      [`connector.disabled.${CRM}`, `connector.identity.${CRM}`, `connector.missing.${CRM}`, `connector.replaced.${CRM}`],
    );
    assert.deepEqual(settings.added, []);
    changed.delete("public.platform_settings");
    const audit = changed.get("public.admin_audit_log")!;
    assert.deepEqual(audit.added.map((r) => [r.action, r.target_id]), [["connector.data.delete", CRM]]);
    assert.deepEqual(audit.removed, []);
    changed.delete("public.admin_audit_log");
    assert.deepEqual([...changed.keys()], [], `more changed: ${JSON.stringify([...changed])}`);

    // CRM_EU, whose name starts with CRM's, keeps all of it.
    const [eu] = await sql`
      select
        (select count(*)::int from public.connector_configs where connector_name = ${CRM_EU}) as credentials,
        (select count(*)::int from public.user_connector_oauth where connector_name = ${CRM_EU}) as connections,
        (select count(*)::int from public.platform_settings where key like ${`connector.%.${CRM_EU}`}) as settings
    `;
    assert.deepEqual({ ...eu }, { credentials: 1, connections: 1, settings: 3 });
  });

  test("a build records what it carries at most every ten minutes, and builds unseen for 30 days are pruned", async () => {
    const key = `checkout:${"1".repeat(32)}`;
    assert.equal(await recordBuildSeen(sql, { key, apps: [ARCHIVE], connectors: [] }), true);
    assert.equal(await recordBuildSeen(sql, { key, apps: [ARCHIVE], connectors: [] }), false, "it wrote again");
    assert.equal(await recordBuildSeen(sql, { key, apps: [], connectors: [] }), true, "a change waited");

    const stale = "build:unknown:0000000000000000";
    await sql`
      insert into public.platform_builds_seen (build_key, apps, connectors, last_seen_at)
      values (${stale}, ${[ARCHIVE]}, ${[]}, now() - interval '31 days')
    `;
    await sql`update public.platform_builds_seen set last_seen_at = now() - interval '11 minutes' where build_key = ${key}`;
    assert.equal(await recordBuildSeen(sql, { key, apps: [], connectors: [] }), true, "ten minutes passed");
    const [{ count }] = await sql`select count(*)::int as count from public.platform_builds_seen where build_key = ${stale}`;
    assert.equal(count, 0, "a build unseen for 31 days was kept");
  });
});
