/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Same slug, different extension, against a real Postgres: the release step's
 * registry sync records each app's identity, switches off one that is a
 * different extension than the one recorded, revokes its API keys and keeps
 * everything else, and leaves an update from the same repository alone.
 * Activating such an app needs its slug typed.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database on. Its name ends in this run's own suffix, and it is
 * dropped when the run finishes:
 *
 *   docker run -d --name identity -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test scripts/app-identity.integration.test.ts
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres, { type Sql } from "postgres";
import type { RegistryInstall } from "../src/lib/repository/install-record";
import { migrateAppSchemas, type MigratedApp } from "./app-migrations";
import { migratePlatform } from "./platform-migrations";
import { RELEASE_STEP_ACTOR } from "./sync-app-registry";

const REPO = path.resolve(__dirname, "..");
const MIGRATIONS = path.join(REPO, "supabase", "migrations");
const serverUrl = process.env.MIXOS_TEST_DATABASE_URL;
const skip = serverUrl ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres";

const run = randomBytes(3).toString("hex");
const database = `mixos_identity_${run}`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-app-identity-"));
const appsDir = path.join(scratch, "apps");

/** What the release step printed while `fn` ran; the tests read the database instead. */
async function quietly<T>(fn: () => Promise<T>): Promise<{ value: T; printed: string }> {
  const log = console.log;
  let printed = "";
  console.log = (...args: unknown[]) => {
    printed += `${args.join(" ")}\n`;
  };
  try {
    return { value: await fn(), printed };
  } finally {
    console.log = log;
  }
}

function app(slug: string): MigratedApp {
  return { slug, name: "Files", description: "", icon: "folder", database: false, updatedAt: [], sync: [] };
}

function installOf(slug: string, fields: Partial<RegistryInstall> = {}): RegistryInstall {
  return {
    kind: "app",
    slug,
    version: "1.2.0",
    gitTag: "v1.2.0",
    commitSha: "a".repeat(40),
    source: "https://mixos.org",
    repository: { owner: "acme", name: "mixos-files", subpath: null },
    requiresMixOS: null,
    modified: false,
    ...fields,
  };
}

function writeApp(slug: string, route = "export const GET = defineRoute({});\n"): void {
  fs.mkdirSync(path.join(appsDir, slug, "api", "files"), { recursive: true });
  fs.writeFileSync(path.join(appsDir, slug, "app.json"), '{ "name": "Files" }\n');
  fs.writeFileSync(path.join(appsDir, slug, "api", "files", "route.ts"), route);
}

describe("an app under a slug a different extension had", { skip }, () => {
  let admin: Sql;
  let sql: Sql;
  let url: string;

  /** Recorded as local by an earlier release step, active, with a grant, settings and two API keys. */
  const files = `files-${run}`;
  /** Activated before any release step recorded its identity. */
  const early = `early-${run}`;
  /** New to the database. */
  const fresh = `fresh-${run}`;

  /** One release step, for a build that carries `apps` and installed `installs` from a Registry. */
  const release = (apps: MigratedApp[], installs: RegistryInstall[]) =>
    quietly(() => migrateAppSchemas(sql, { apps, appsDir, installs }));

  async function row(slug = files) {
    const [r] = await sql`
      select is_active, identity, identity_changed_at, replaced_identity, returned_changed_at
      from public.apps where slug = ${slug}
    `;
    return r ? { ...r } : undefined;
  }

  async function liveKeys(slug = files): Promise<number> {
    const [{ n }] = await sql`
      select count(*)::int as n from public.app_api_keys where app_slug = ${slug} and revoked_at is null
    `;
    return n;
  }

  async function audited(action: string, slug = files) {
    const rows = await sql`
      select actor_id, actor_email, target_type, details
      from public.admin_audit_log
      where action = ${action} and target_id = ${slug}
      order by created_at
    `;
    return rows.map((r) => ({ ...r }));
  }

  async function addKey(slug = files): Promise<void> {
    await sql`
      insert into public.app_api_keys (app_slug, label, digest, hint)
      values (${slug}, 'CI', ${randomBytes(16).toString("hex")}, 'mixk_abc')
    `;
  }

  /**
   * What an admin's Activate does, through the platform's own client. A
   * Registry app activates only with a review of its code (src/lib/apps/
   * app-review.ts), which an admin records first: this records one for the
   * code the last release step saw.
   */
  async function activate(slug: string, typedSlug?: string) {
    await sql`
      insert into public.app_reviews (app_slug, code_hash)
      select slug, code_hash from public.apps where slug = ${slug} and code_hash is not null
      on conflict do nothing
    `;
    const access = await import("../src/lib/apps/access");
    return access.setAppActive(slug, true, typedSlug);
  }

  before(async () => {
    admin = postgres(serverUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${database}`);
    const u = new URL(serverUrl!);
    u.pathname = `/${database}`;
    url = u.toString();
    sql = postgres(url, { max: 1, onnotice: () => {} });

    // The schema, and an app a release step has already recorded as local.
    await quietly(() => migratePlatform(sql, MIGRATIONS));
    await sql`insert into public.apps (slug, name, is_active, identity) values (${files}, 'Files', true, 'local')`;
    const [{ id: user }] = await sql`
      insert into public.users (email, display_name) values ('user@example.com', 'User') returning id
    `;
    await sql`insert into public.user_app_grants (user_id, app_slug, role, role_only) values (${user}, ${files}, 'editor', false)`;
    await sql`insert into public.app_settings (app_slug, key, value) values (${files}, 'region', 'eu')`;
    await addKey();
    // Revoked long ago: it keeps its own date.
    await sql`
      insert into public.app_api_keys (app_slug, label, digest, hint, revoked_at)
      values (${files}, 'Old', ${randomBytes(16).toString("hex")}, 'mixk_old', '2026-01-01T00:00:00Z')
    `;

    writeApp(files);
    writeApp(early);
    writeApp(fresh);

    process.env.DATABASE_URL = url;
    process.env.PGSSLMODE = new URL(url).searchParams.get("sslmode") ?? "disable";
  });

  after(async () => {
    const { sql: platformSql } = await import("../src/lib/db/client");
    await platformSql.end();
    await sql?.end();
    if (admin) {
      await admin.unsafe(`drop database if exists ${database} with (force)`);
      await admin.end();
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  test("the same local app, released again, is left as it was", async () => {
    await release([app(files)], []);
    assert.equal((await row())?.is_active, true);
    assert.equal((await row())?.identity_changed_at, null);
    assert.equal(await liveKeys(), 1);
    assert.deepEqual(await audited("app.identity.changed"), []);
  });

  test("reinstalled from the Registry, it is switched off and flagged, and loses its API keys, tool switches and own connector credentials and nothing else", async () => {
    // Two tools an admin turned on for the extension before it.
    await sql`
      insert into public.app_mcp_tool_settings (app_slug, tool_name, enabled)
      values (${files}, 'search', true), (${files}, 'peek', false)
    `;
    // Its own credentials for a connector, and what their grant held: given
    // to the extension before it, so never passed to this one.
    await sql`
      insert into public.connector_app_configs (connector_name, app_slug, encrypted_credentials)
      values ('crm', ${files}, 'SEALED')
    `;
    await sql`
      insert into public.connector_scope_status (connector_name, app_slug, scope, status)
      values ('crm', ${files}, 'read', 'granted')
    `;
    const { printed } = await release([app(files)], [installOf(files)]);
    const identity = `https://mixos.org app/${files} acme/mixos-files`;

    const r = await row();
    assert.equal(r?.is_active, false);
    assert.equal(r.identity, identity);
    assert.ok(r.identity_changed_at instanceof Date, "identity_changed_at was not set");
    assert.equal(r.replaced_identity, "local");
    assert.equal(r.returned_changed_at, null, "it never left the build");

    assert.equal(await liveKeys(), 0);
    const [old] = await sql`select revoked_at from public.app_api_keys where app_slug = ${files} and label = 'Old'`;
    assert.equal(old.revoked_at.toISOString(), "2026-01-01T00:00:00.000Z");
    const [kept] = await sql`
      select
        (select count(*)::int from public.user_app_grants where app_slug = ${files}) as grants,
        (select count(*)::int from public.app_settings where app_slug = ${files}) as settings
    `;
    assert.deepEqual({ ...kept }, { grants: 1, settings: 1 });
    const [{ switches }] = await sql`
      select count(*)::int as switches from public.app_mcp_tool_settings where app_slug = ${files}
    `;
    assert.equal(switches, 0, "the tool switches of the extension before it were kept");
    const [own] = await sql`
      select
        (select count(*)::int from public.connector_app_configs where app_slug = ${files}) as credentials,
        (select count(*)::int from public.connector_scope_status where app_slug = ${files}) as scopes
    `;
    assert.deepEqual({ ...own }, { credentials: 0, scopes: 0 }, "the credentials given to the extension before it were kept");

    assert.deepEqual(await audited("app.identity.changed"), [
      {
        actor_id: null,
        actor_email: RELEASE_STEP_ACTOR,
        target_type: "app",
        details: {
          previous: "local",
          identity: {
            source: "https://mixos.org",
            kind: "app",
            slug: files,
            repository: { owner: "acme", name: "mixos-files" },
          },
          deactivated: true,
          apiKeysRevoked: 1,
          mcpToolSwitchesReset: 2,
          connectorCredentialsDeleted: 1,
        },
      },
    ]);
    assert.match(
      printed,
      new RegExp(
        `${files}: a different extension than before \\(was local, with no install record; now from mixos\\.org, ` +
          `acme/mixos-files\\) — inactive, with 1 API key\\(s\\) revoked and 2 MCP tool switch\\(es\\) reset, ` +
          `and its own credentials for 1 connector\\(s\\) deleted, until an admin activates it by typing its slug`,
      ),
    );

    // Released again with the same build: it is recorded, so nothing more happens.
    await release([app(files)], [installOf(files)]);
    assert.deepEqual(await row(), r);
    assert.equal((await audited("app.identity.changed")).length, 1);
  });

  test("activating it needs its slug typed, and clears the flag", async () => {
    for (const typed of [undefined, "", "files", `${files}x`]) {
      await assert.rejects(activate(files, typed), /replaces a different extension with the same slug\. Type its slug to activate it\./);
    }
    assert.equal((await row())?.is_active, false);

    assert.deepEqual(await activate(files, ` ${files} `), { replaced: "local" });
    const r = await row();
    assert.deepEqual([r?.is_active, r?.identity_changed_at, r?.replaced_identity], [true, null, null]);
    // Nothing to confirm now.
    assert.equal(await activate(files), null);
  });

  test("a new version from the same repository is an update: nothing is flagged or revoked, and it waits for a review", async () => {
    await addKey();
    const update = installOf(files, {
      version: "2.0.0",
      gitTag: "v2.0.0",
      commitSha: "b".repeat(40),
      // GitHub matches names without case, and so does the identity.
      repository: { owner: "Acme", name: "MixOS-Files", subpath: "apps/files" },
    });
    // Different files, as an update that Register swapped in leaves them.
    writeApp(files, "export const GET = defineRoute({ roles: [] });\n");
    await release([app(files)], [update]);

    const r = await row();
    // The same extension, so no identity flag and no revoked key; new code no
    // admin here has reviewed, so it is off until one does (app-review.ts).
    assert.deepEqual([r?.is_active, r?.identity_changed_at, r?.returned_changed_at], [false, null, null]);
    assert.equal((await audited("app.update.unreviewed")).length, 1);
    assert.equal(await liveKeys(), 1);
    assert.equal((await audited("app.identity.changed")).length, 1);
    // Its grant and its settings belong to the slug, and are as they were.
    const [kept] = await sql`
      select
        (select count(*)::int from public.user_app_grants where app_slug = ${files}) as grants,
        (select count(*)::int from public.app_settings where app_slug = ${files}) as settings
    `;
    assert.deepEqual({ ...kept }, { grants: 1, settings: 1 });
  });

  test("a release from another repository is a different extension", async () => {
    await release([app(files)], [installOf(files, { repository: { owner: "mallory", name: "mixos-files", subpath: null } })]);

    const r = await row();
    assert.equal(r?.is_active, false);
    assert.equal(r.replaced_identity, `https://mixos.org app/${files} acme/mixos-files`);
    assert.equal(await liveKeys(), 0);
    const changes = await audited("app.identity.changed");
    assert.equal(changes.length, 2);
    assert.deepEqual(
      [changes[1].details.previous.repository, changes[1].details.identity.repository, changes[1].details.apiKeysRevoked],
      [{ owner: "acme", name: "mixos-files" }, { owner: "mallory", name: "mixos-files" }, 1],
    );
  });

  test("a second change before an admin answers keeps what it first replaced", async () => {
    const { identity_changed_at: first } = (await row())!;
    // Its record deleted: local again, which is a third extension.
    await release([app(files)], []);
    const r = await row();
    assert.equal(r?.identity, "local");
    assert.equal(r.replaced_identity, `https://mixos.org app/${files} acme/mixos-files`);
    assert.deepEqual(r.identity_changed_at, first);
    assert.equal((await audited("app.identity.changed")).length, 3);
  });

  test("one that comes back as a different extension gets one flag and one line, not two", async () => {
    await activate(files, files);
    await release([], []);
    writeApp(files, "export const GET = defineRoute({ roles: ['viewer'] });\n");
    const { printed } = await release([app(files)], [installOf(files, { repository: { owner: "third", name: "files", subpath: null } })]);

    const r = await row();
    assert.equal(r?.is_active, false);
    assert.ok(r.identity_changed_at instanceof Date, "identity_changed_at was not set");
    assert.equal(r.returned_changed_at, null, "it was flagged twice");

    const [returned] = (await audited("app.returned")).slice(-1);
    assert.deepEqual(
      [returned.details.codeChanged, returned.details.identityChanged, returned.details.deactivated],
      [true, true, true],
    );
    assert.equal((await audited("app.identity.changed")).length, 4);
    const lines = printed.split("\n").filter((line) => line.includes(`${files}:`));
    assert.deepEqual(lines.length, 1, printed);
    assert.match(lines[0], /back in the build, and a different extension than before \(was local, with no install record; now from mixos\.org, third\/files\)/);
  });

  test("a row activation wrote before any release step is recorded, not flagged, and switched off until reviewed", async () => {
    await activate(early);
    assert.equal((await row(early))?.identity, null);
    await release([app(early)], [installOf(early)]);
    const r = await row(early);
    // Recorded as the extension it is, and not flagged as a different one. A
    // Registry app nobody here reviewed, so nothing grandfathers it on.
    assert.deepEqual([r?.is_active, r?.identity, r?.identity_changed_at], [false, `https://mixos.org app/${early} acme/mixos-files`, null]);
    assert.equal((await audited("app.review.required", early)).length, 1);
  });

  test("an app new to the database arrives inactive with its identity recorded", async () => {
    await release([app(fresh)], [installOf(fresh)]);
    const r = await row(fresh);
    assert.deepEqual([r?.is_active, r?.identity, r?.identity_changed_at], [false, `https://mixos.org app/${fresh} acme/mixos-files`, null]);
    assert.deepEqual(await audited("app.identity.changed", fresh), []);
  });
});
