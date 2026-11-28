/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * App migrations against a real Postgres, run as a role that is not a
 * superuser: the shape of a hosted database (Neon, Supabase, RDS), where the
 * role in DATABASE_URL owns the database and may create roles, and no more.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database and roles on. Every name it creates ends in this run's own
 * suffix, and it drops them all when it finishes:
 *
 *   docker run -d --name appmig -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test scripts/app-migrations.integration.test.ts
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres, { type Sql } from "postgres";
import { appRoleName, appSchemaName } from "../src/lib/apps/app-identifiers";
import { DbClient } from "../src/lib/db/query";
import {
  applyMigration,
  ensureAppDatabase,
  migrateAppSchemas,
  ensureAppRunner,
  probeAppRunner,
  type MigratedApp,
} from "./app-migrations";
import { migratePlatform } from "./platform-migrations";

const REPO = path.resolve(__dirname, "..");
const serverUrl = process.env.MIXOS_TEST_DATABASE_URL;
const skip = serverUrl ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres";

// Roles belong to the server, not to a database, so every name is this run's.
const run = randomBytes(3).toString("hex");
const database = `mixos_appmig_${run}`;
const owner = `mixos_appmig_owner_${run}`;
const password = randomBytes(12).toString("hex");

const appsDir = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-app-migrations-it-"));
const usedSlugs = new Set<string>();

function app(slug: string, extra: Partial<MigratedApp> = {}): MigratedApp {
  usedSlugs.add(slug);
  return {
    slug,
    name: slug,
    description: "",
    icon: "box",
    database: true,
    updatedAt: [],
    sync: [],
    ...extra,
  };
}

function migrations(slug: string, files: Record<string, string>): void {
  const dir = path.join(appsDir, slug, "migrations");
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), text);
}

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

describe("app migrations against a real database", { skip }, () => {
  let admin: Sql;
  /** The release step's connection: the database's owner, not a superuser. */
  let sql: Sql;

  const notes = app(`notes-${run}`, { updatedAt: [{ table: "notes", column: "updated_at" }] });
  const schema = appSchemaName(notes.slug);
  const role = appRoleName(notes.slug);

  before(async () => {
    admin = postgres(serverUrl!, { max: 1, onnotice: () => {} });
    const [{ superuser }] = await admin<{ superuser: boolean }[]>`
      select rolsuper as superuser from pg_roles where rolname = current_user
    `;
    await admin.unsafe(`create role ${owner} login createrole password '${password}'`);
    // Giving a database to a role needs membership of it, unless you are a superuser.
    if (!superuser) await admin.unsafe(`grant ${owner} to current_user`);
    await admin.unsafe(`create database ${database} owner ${owner}`);

    const url = new URL(serverUrl!);
    url.username = owner;
    url.password = password;
    url.pathname = `/${database}`;
    sql = postgres(url.toString(), { max: 1, onnotice: () => {} });

    await quietly(() => migratePlatform(sql, path.join(REPO, "supabase", "migrations")));
    // What the escalations go after.
    await sql`
      insert into public.users (email, display_name, is_admin, password_hash)
      values ('owner@example.com', 'Owner', false, 'HASH')
    `;

    migrations(notes.slug, {
      "001_notes.sql": [
        "-- Notes — one table, its tags, and a settings row.",
        "create table notes (",
        "  id uuid primary key default gen_random_uuid(),",
        "  user_id uuid not null,",
        "  body text not null default '',",
        "  created_at timestamptz not null default now(),",
        "  updated_at timestamptz not null default now()",
        ");",
        "create table tags (",
        "  note_id uuid not null references notes(id) on delete cascade,",
        "  tag text not null,",
        "  primary key (note_id, tag)",
        ");",
        "create index notes_body on notes (lower(body));",
        "create table settings (id int primary key default 1, value text);",
        "-- RA-40: the prefix rewrite broke this.",
        "insert into settings (id, value) values (1, 'seed') on conflict (id) do nothing;",
        "insert into settings (id, value) values (1, 'again') on conflict (id) do nothing;",
      ].join("\n"),
      "002_pinned.sql":
        "alter table notes add column if not exists pinned boolean not null default false;\n" +
        "create view pinned_notes as select id, body from notes where pinned;\n",
    });
  });

  after(async () => {
    await sql?.end();
    if (admin) {
      await admin.unsafe(`drop database if exists ${database} with (force)`);
      for (const slug of usedSlugs) await admin.unsafe(`drop role if exists ${appRoleName(slug)}`);
      await admin.unsafe(`drop role if exists ${owner}`);
      await admin.end();
    }
    fs.rmSync(appsDir, { recursive: true, force: true });
  });

  test("an app's migrations build its own schema, owned by its own role, and nothing in public", async () => {
    await quietly(() => migrateAppSchemas(sql, { apps: [notes], appsDir }));

    const [r] = await sql`
      select rolcanlogin, rolsuper, rolcreaterole, rolbypassrls,
             (select count(*)::int from pg_auth_members m where m.member = r.oid) as member_of
      from pg_roles r where rolname = ${role}
    `;
    assert.deepEqual(
      { ...r },
      { rolcanlogin: false, rolsuper: false, rolcreaterole: false, rolbypassrls: false, member_of: 0 },
    );

    const [ns] = await sql`select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = ${schema}`;
    assert.equal(ns.owner, role);

    const objects = await sql<{ relname: string; owner: string; rls: boolean; relkind: string }[]>`
      select c.relname, pg_get_userbyid(c.relowner) as owner, c.relrowsecurity as rls, c.relkind
      from pg_class c
      where c.relnamespace = ${schema}::regnamespace and c.relkind in ('r', 'v')
      order by c.relname
    `;
    assert.deepEqual(
      objects.map((o) => o.relname),
      ["notes", "pinned_notes", "settings", "tags"],
    );
    for (const o of objects) assert.equal(o.owner, role, o.relname);
    for (const o of objects.filter((o) => o.relkind === "r")) assert.equal(o.rls, true, `${o.relname} has RLS off`);

    const elsewhere = await sql<{ name: string }[]>`
      select schemaname || '.' || tablename as name from pg_tables
      where (schemaname = 'public' and tablename in ('notes', 'tags', 'settings'))
         or tablename like '\\_app\\_%'
    `;
    assert.deepEqual(elsewhere.map((t) => t.name), []);

    const ledger = await sql`
      select migration_file from public._migrations where app_slug = ${notes.slug} order by migration_file
    `;
    assert.deepEqual(
      ledger.map((l) => l.migration_file),
      ["001_notes.sql", "002_pinned.sql"],
    );
    const [setting] = await sql.unsafe(`select value from "${schema}".settings`);
    assert.equal(setting.value, "seed");
  });

  test("context.db reaches the app's tables, and updatedAt keeps its column current", async () => {
    // What createScopedClient builds, on this test's connection: every
    // statement runs through the app's runner, as the app's role, the trigger
    // and the view included.
    const db = new DbClient(sql).schema(schema).confined();
    const user = "00000000-0000-0000-0000-000000000001";

    const created = await db.from("notes").insert({ user_id: user, body: "hello" }).select("id, updated_at").single();
    assert.equal(created.error, null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const updated = await db
      .from("notes")
      .update({ body: "changed", pinned: true })
      .eq("id", created.data.id)
      .select("updated_at")
      .single();
    assert.equal(updated.error, null);
    assert.ok(updated.data.updated_at > created.data.updated_at, "updated_at did not move on update");

    // The upsert target is the table's primary key, looked up in the app's schema.
    assert.equal((await db.from("settings").upsert({ id: 1, value: "upserted" })).error, null);
    assert.equal((await db.from("tags").insert({ note_id: created.data.id, tag: "a" })).error, null);
    const pinned = await db.from("pinned_notes").select("body");
    assert.deepEqual(pinned.data, [{ body: "changed" }]);

    // The platform's own client still means public.
    const platform = await new DbClient(sql).from("users").select("email");
    assert.deepEqual(platform.data, [{ email: "owner@example.com" }]);

    // The admin viewer's function lists the app's tables by schema.
    const columns = await sql<{ table_name: string; column_name: string; foreign_table: string | null }[]>`
      select table_name, column_name, foreign_table from public.get_app_schema(${[schema]})
      where table_name = 'tags' order by ordinal_position
    `;
    assert.deepEqual(
      columns.map((c) => [c.column_name, c.foreign_table]),
      [
        ["note_id", "notes"],
        ["tag", null],
      ],
    );
  });

  test("a second run applies nothing and adds no second trigger", async () => {
    await quietly(() => migrateAppSchemas(sql, { apps: [notes], appsDir }));
    const [{ files }] = await sql`select count(*)::int as files from public._migrations where app_slug = ${notes.slug}`;
    const [{ triggers }] = await sql.unsafe(
      `select count(*)::int as triggers from pg_trigger where tgrelid = '"${schema}".notes'::regclass and not tgisinternal`,
    );
    assert.deepEqual([files, triggers], [2, 1]);
  });

  test("the plan's escalations are refused before anything runs, and public.users is untouched", async () => {
    const evil = app(`evil-${run}`);
    migrations(evil.slug, {
      "001_trojans.sql": [
        "create table notes (id int primary key, x xml default query_to_xml('select email, password_hash from public.users', true, true, ''));",
        "create function promote() returns trigger language plpgsql as $$ begin update public.users set is_admin = true; return new; end $$;",
        "create trigger promote after insert on notes for each row execute function promote();",
        "update public.users set is_admin = true;",
        "create view leak as select email, password_hash from public.users;",
      ].join("\n"),
    });

    await assert.rejects(
      quietly(() => migrateAppSchemas(sql, { apps: [notes, evil], appsDir })),
      (err: Error) => {
        const file = `apps/${evil.slug}/migrations/001_trojans.sql`;
        assert.match(err.message, /none applied/);
        assert.ok(err.message.includes(`${file}:1: query_to_xml() is not allowed`), err.message);
        assert.ok(err.message.includes(`${file}:2: CREATE FUNCTION`), err.message);
        assert.ok(err.message.includes(`${file}:3: CREATE TRIGGER`), err.message);
        assert.ok(err.message.includes(`${file}:4: "public.users" is outside`), err.message);
        assert.ok(err.message.includes(`${file}:5: "public.users" is outside`), err.message);
        return true;
      },
    );

    const [user] = await sql`select is_admin, password_hash from public.users where email = 'owner@example.com'`;
    assert.deepEqual({ ...user }, { is_admin: false, password_hash: "HASH" });
    const [{ ledger }] = await sql`select count(*)::int as ledger from public._migrations where app_slug = ${evil.slug}`;
    const [{ schemas }] = await sql`select count(*)::int as schemas from pg_namespace where nspname = ${appSchemaName(evil.slug)}`;
    assert.deepEqual([ledger, schemas], [0, 0]);
  });

  test("with the check skipped, the app's role still holds a migration inside its schema", async () => {
    // applyMigration is what runs a file once the check has passed it. Calling
    // it directly shows the second layer on its own.
    for (const [i, [text, refusal]] of (
      [
        ["update public.users set is_admin = true", /permission denied for table users/],
        ["insert into notes (user_id, body) select id, password_hash from public.users", /permission denied for table users/],
        ["drop table public._migrations", /must be owner of table _migrations/],
        [`set role ${owner}`, /cannot set parameter "role" within security-definer function/],
        ["reset role", /cannot set parameter "role" within security-definer function/],
        [`set session authorization ${owner}`, /cannot set parameter "session_authorization" within security-definer function/],
        [`select set_config('role', '${owner}', false)`, /cannot set parameter "role" within security-definer function/],
      ] as const
    ).entries()) {
      await assert.rejects(applyMigration(sql, notes.slug, `9${i}_unchecked.sql`, text), refusal, text);
    }

    const [user] = await sql`select is_admin from public.users where email = 'owner@example.com'`;
    assert.equal(user.is_admin, false);
    const [{ functions }] = await sql`
      select count(*)::int as functions from pg_proc
      where pronamespace = ${schema}::regnamespace and proname = 'mixos_apply_migration'
    `;
    assert.equal(functions, 0, "the function a migration runs through outlived it");
  });

  test("a runtime error names the file and line it came from", async () => {
    const text = "create table fine (id int);\n-- — —\ninsert into missing_table values (1);\n";
    await assert.rejects(
      applyMigration(sql, notes.slug, "98_broken.sql", text),
      new RegExp(`^Error: apps/${notes.slug}/migrations/98_broken\\.sql:3: relation "missing_table" does not exist`),
    );
    const [{ fine }] = await sql`select count(*)::int as fine from pg_class where relname = 'fine'`;
    assert.equal(fine, 0, "a failed file left part of itself behind");
  });

  test("an app with migrations and no database, and a folder outside the registry, run no SQL", async () => {
    const nodb = app(`nodb-${run}`, { database: false });
    migrations(nodb.slug, { "001_x.sql": "create table nodb_table (id int);" });
    await assert.rejects(
      quietly(() => migrateAppSchemas(sql, { apps: [notes, nodb], appsDir })),
      /apps\/nodb-.*\/migrations\/ holds 001_x\.sql, but .* does not set "database": true/,
    );

    // A folder the registry generator did not accept: it is simply not in `apps`.
    migrations(`stray-${run}`, { "001_x.sql": "create table stray_table (id int);" });
    await quietly(() => migrateAppSchemas(sql, { apps: [notes], appsDir }));

    const [{ tables }] = await sql`
      select count(*)::int as tables from pg_class where relname in ('nodb_table', 'stray_table')
    `;
    const [{ ledger }] = await sql`
      select count(*)::int as ledger from public._migrations where app_slug in (${nodb.slug}, ${`stray-${run}`})
    `;
    assert.deepEqual([tables, ledger], [0, 0]);
  });

  test("my-app and my_app, which the prefix merged, keep their own tables", async () => {
    const hyphen = app(`crm-${run}`);
    const underscore = app(`crm_${run}`);
    for (const a of [hyphen, underscore]) {
      migrations(a.slug, {
        "001_deals.sql": `create table deals (id int primary key, app text);\ninsert into deals values (1, '${a.slug}');\n`,
      });
    }
    await quietly(() => migrateAppSchemas(sql, { apps: [notes, hyphen, underscore], appsDir }));

    assert.notEqual(appSchemaName(hyphen.slug), appSchemaName(underscore.slug));
    for (const a of [hyphen, underscore]) {
      const rows = await new DbClient(sql).schema(appSchemaName(a.slug)).from("deals").select("app");
      assert.deepEqual(rows.data, [{ app: a.slug }]);
    }
  });

  test("an updatedAt column that is not a timestamp stops the release", async () => {
    const wrong = app(`wrong-${run}`, { updatedAt: [{ table: "items", column: "label" }] });
    migrations(wrong.slug, { "001_items.sql": "create table items (id int primary key, label text);" });
    await assert.rejects(
      quietly(() => migrateAppSchemas(sql, { apps: [notes, wrong], appsDir })),
      /lists items\.label under "updatedAt", but it is not a timestamptz or timestamp column/,
    );
  });

  test("an app role that already exists with more than NOLOGIN, or a membership, is refused", async () => {
    const preset = app(`preset-${run}`);
    const presetRole = appRoleName(preset.slug);

    await admin.unsafe(`create role ${presetRole} login`);
    await assert.rejects(quietly(() => ensureAppDatabase(sql, preset.slug)), /has LOGIN/);

    await admin.unsafe(`alter role ${presetRole} nologin`);
    await admin.unsafe(`grant ${owner} to ${presetRole}`);
    await assert.rejects(quietly(() => ensureAppDatabase(sql, preset.slug)), /is a member of/);
    await admin.unsafe(`revoke ${owner} from ${presetRole}`);
  });

  test("an app role another database on the server already uses is refused", async () => {
    const shared = app(`shared-${run}`);
    const sharedRole = appRoleName(shared.slug);
    const other = `${database}_other`;

    await quietly(() => ensureAppDatabase(sql, shared.slug));
    // A second database on the same server, where the same role owns something.
    await admin.unsafe(`create database ${other}`);
    await admin.unsafe(`grant create on database ${other} to ${owner}`);
    const url = new URL(serverUrl!);
    url.username = owner;
    url.password = password;
    url.pathname = `/${other}`;
    const elsewhere = postgres(url.toString(), { max: 1, onnotice: () => {} });
    try {
      await elsewhere.unsafe(`create schema somewhere_else authorization ${sharedRole}`);
      await assert.rejects(quietly(() => ensureAppDatabase(sql, shared.slug)), new RegExp(`is also used in ${other}`));
    } finally {
      await elsewhere.end();
      await admin.unsafe(`drop database if exists ${other} with (force)`);
    }
  });

  test("each release puts the app's runner in place, and fails on one that was changed", async () => {
    await quietly(() => migrateAppSchemas(sql, { apps: [notes], appsDir }));
    await probeAppRunner(sql, notes.slug);
    const fn = `${schema}.mixos_run(text, json, boolean)`;

    // Each change that would let the runner run an app's statements as
    // someone else, or let someone else run them.
    const changes: [string, string, RegExp][] = [
      ["security invoker", `alter function ${fn} security invoker`, /isn't SECURITY DEFINER/],
      ["another owner", `alter function ${fn} owner to ${owner}`, new RegExp(`belongs to ${owner}, not ${role}`)],
      ["executable by everyone", `grant execute on function ${fn} to public`, /may be executed by PUBLIC/],
      ["another search path", `alter function ${fn} set search_path = public`, /has settings/],
    ];
    for (const [what, change, refusal] of changes) {
      await sql.unsafe(change);
      await assert.rejects(probeAppRunner(sql, notes.slug), refusal, what);
      // The next release puts it back.
      await quietly(() => migrateAppSchemas(sql, { apps: [notes], appsDir }));
      await probeAppRunner(sql, notes.slug);
    }

    // Gone, it fails the probe, and the app's queries run nothing.
    await sql.unsafe(`drop function ${fn}`);
    await assert.rejects(probeAppRunner(sql, notes.slug), /is missing/);
    const missing = await new DbClient(sql).schema(schema).confined().from("notes").select("id");
    assert.equal(missing.error?.code, "42883");
    await ensureAppRunner(sql, notes.slug);
    await probeAppRunner(sql, notes.slug);
  });

  test("the release fails for a login that can't run the app's queries", async () => {
    // A login that can connect but is no member of the role: what a host
    // that drops or limits the membership looks like.
    const stranger = `mixos_appmig_stranger_${run}`;
    await admin.unsafe(`create role ${stranger} login password '${password}'`);
    const url = new URL(serverUrl!);
    url.username = stranger;
    url.password = password;
    url.pathname = `/${database}`;
    const as = postgres(url.toString(), { max: 1, onnotice: () => {} });
    try {
      await assert.rejects(
        probeAppRunner(as, notes.slug),
        new RegExp(`${notes.slug}: this database login can't run queries through ${schema}\\.mixos_run`),
      );
    } finally {
      await as.end();
      await admin.unsafe(`drop role ${stranger}`);
    }
  });

  test("the sync watermark table is the platform's: the app's role can't read or write it", async () => {
    const synced = app(`synced-${run}`, {
      sync: [
        {
          name: "items",
          schedule: { everyMinutes: 60 },
          source: "mixos",
          window: { coldStartDays: 3, defaultDays: 7, minDays: 1 },
          budgetMs: 1000,
        },
      ],
    });
    migrations(synced.slug, { "001_items.sql": "create table items (id int primary key);" });
    await quietly(() => migrateAppSchemas(sql, { apps: [notes, synced], appsDir }));

    const table = `${appSchemaName(synced.slug)}._sync_state`;
    const [privileges] = await sql`
      select pg_get_userbyid(c.relowner) as owner,
             has_table_privilege(${appRoleName(synced.slug)}, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') as app
      from pg_class c where c.oid = to_regclass(${table})
    `;
    assert.deepEqual({ ...privileges }, { owner, app: false });
    const read = await new DbClient(sql).schema(appSchemaName(synced.slug)).confined().from("_sync_state").select("*");
    assert.equal(read.error?.code, "42501");
  });

  test("every role's CREATE on public is taken away where this login may, and reported where not", async () => {
    const open = async () => {
      const [{ open }] = await sql<{ open: boolean }[]>`select has_schema_privilege('public', 'public', 'CREATE') as open`;
      return open;
    };
    const warnings = async () => {
      const seen: string[] = [];
      const { log, warn } = console;
      console.log = () => {};
      console.warn = (...args: unknown[]) => seen.push(args.join(" "));
      try {
        await migrateAppSchemas(sql, { apps: [notes], appsDir });
      } finally {
        Object.assign(console, { log, warn });
      }
      return seen.filter((w) => /may create tables in the public schema/.test(w));
    };

    // What Postgres before 15 gives every role, granted by the server's
    // superuser in this test's database.
    const url = new URL(serverUrl!);
    url.pathname = `/${database}`;
    const superuser = postgres(url.toString(), { max: 1, onnotice: () => {} });
    try {
      await superuser.unsafe("grant create on schema public to public");
      assert.equal(await open(), true);
      assert.equal((await warnings()).length, 1);

      const migration = fs.readFileSync(path.join(REPO, "supabase", "migrations", "0004_public_schema_create.sql"), "utf8");
      await sql.unsafe(migration);
      const [{ may }] = await sql<{ may: boolean }[]>`
        select pg_has_role(current_user, (select nspowner from pg_namespace where nspname = 'public'), 'USAGE') as may
      `;
      if (may) {
        assert.equal(await open(), false, "0004 left CREATE on public with every role");
        assert.deepEqual(await warnings(), []);
      } else {
        // Before Postgres 15 a new database's public belongs to the bootstrap
        // superuser: only it can revoke, so the release keeps saying so.
        assert.equal(await open(), true);
        assert.equal((await warnings()).length, 1);
        await superuser.unsafe("revoke create on schema public from public");
      }
    } finally {
      await superuser.end();
    }
  });
});
