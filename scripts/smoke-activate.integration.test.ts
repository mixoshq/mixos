/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Activating and granting an app for a smoke test, against a real Postgres:
 *
 *   - `npm run register -- app/<slug> --smoke` (scripts/smoke-activate.ts):
 *     Activate's checks and audit rows as the CLI, the grant as Admin > Users
 *     makes it, nothing done twice, and an app that replaces a different
 *     extension activated only with its slug typed;
 *   - the pull-request check (scripts/ci-extensions.ts `activate`): by SQL, on
 *     the job's own database, each grant audited as the CLI.
 *
 * Both write their grants as grants (src/lib/apps/grant-rule.ts) and record
 * who granted them, so a release step after either leaves them grants.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database on. Its name ends in this run's own suffix, and it is
 * dropped when the run finishes:
 *
 *   docker run -d --name smoke -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test scripts/smoke-activate.integration.test.ts
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres, { type Sql } from "postgres";
import { activateAndGrant } from "./ci-extensions";
import { migratePlatform } from "./platform-migrations";
import type { SmokeActivationDeps } from "./smoke-activate";

const REPO = path.resolve(__dirname, "..");
const serverUrl = process.env.MIXOS_TEST_DATABASE_URL;
const skip = serverUrl ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres";

const run = randomBytes(3).toString("hex");
const database = `mixos_smoke_${run}`;
const ACTOR = { id: null, email: "cli:tester@test-host" };
const EMAIL = "smoke@example.com";

describe("activating an app for a smoke test", { skip }, () => {
  let admin: Sql;
  let sql: Sql;
  let userId: string;

  const plain = `plain-${run}`;
  const global = `global-${run}`;
  const replaced = `replaced-${run}`;
  const needsCrm = `crm-${run}`;
  const wasGlobal = `was-global-${run}`;
  const roles = [
    { key: "editor", label: "Editor" },
    { key: "viewer", label: "Viewer" },
  ];
  const deps: SmokeActivationDeps = {
    apps: [
      { slug: plain, global: false, roles },
      { slug: global, global: true, roles: [] },
      { slug: replaced, global: false, roles: [] },
      { slug: needsCrm, global: false, roles: [] },
      { slug: wasGlobal, global: false, roles },
    ],
    missingConnectors: async (slug) => (slug === needsCrm ? [{ name: "crm", displayName: "Acme CRM", state: "unconfigured" as const }] : []),
  };

  async function activate(slug: string, typedSlug?: string, email = EMAIL) {
    const { activateForSmoke } = await import("./smoke-activate");
    return activateForSmoke({ slug, email, typedSlug, actor: ACTOR }, deps);
  }

  async function row(slug: string) {
    const [r] = await sql`
      select is_active, identity_changed_at, replaced_identity from public.apps where slug = ${slug}
    `;
    return r ? { ...r } : undefined;
  }

  async function grants(slug: string) {
    return (await sql`select user_id, role, granted_by from public.user_app_grants where app_slug = ${slug}`).map((r) => ({ ...r }));
  }

  async function audited(slug: string) {
    const rows = await sql`
      select actor_id, actor_email, action, target_type, target_id, details
      from public.admin_audit_log
      where target_id = ${slug} or details->>'appSlug' = ${slug}
      order by created_at, id
    `;
    return rows.map((r) => ({ ...r }));
  }

  before(async () => {
    admin = postgres(serverUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${database}`);
    const u = new URL(serverUrl!);
    u.pathname = `/${database}`;
    sql = postgres(u.toString(), { max: 1, onnotice: () => {} });
    const log = console.log;
    console.log = () => {};
    try {
      await migratePlatform(sql, path.join(REPO, "supabase", "migrations"));
    } finally {
      console.log = log;
    }

    [{ id: userId }] = await sql`
      insert into public.users (email, display_name) values (${EMAIL}, 'Smoke') returning id
    `;
    for (const slug of [plain, global, needsCrm, wasGlobal]) {
      await sql`insert into public.apps (slug, name, is_active, identity) values (${slug}, ${slug}, false, 'local')`;
    }
    // What the release step leaves for a local app reinstalled from the Registry,
    // with the review Register records (src/lib/apps/app-review.ts): a
    // Registry app activates only with one of its code.
    await sql`
      insert into public.apps (slug, name, is_active, identity, identity_changed_at, replaced_identity, code_hash)
      values (${replaced}, ${replaced}, false, ${`https://mixos.org app/${replaced} acme/mixos-files`}, now(), 'local',
              'sha256-smoke')
    `;
    await sql`insert into public.app_reviews (app_slug, code_hash) values (${replaced}, 'sha256-smoke')`;

    process.env.DATABASE_URL = u.toString();
    process.env.PGSSLMODE = u.searchParams.get("sslmode") ?? "disable";
  });

  after(async () => {
    const { sql: platformSql } = await import("../src/lib/db/client");
    await platformSql.end();
    await sql?.end();
    if (admin) {
      await admin.unsafe(`drop database if exists ${database} with (force)`);
      await admin.end();
    }
  });

  test("activates and grants, with no role of its own, and audits both as the CLI", async () => {
    assert.deepEqual(await activate(plain), { ok: true, activated: true, replaced: null, grant: "added" });
    assert.equal((await row(plain))?.is_active, true);
    // Null: the user follows the app's defaultRole, whatever it becomes.
    assert.deepEqual(await grants(plain), [{ user_id: userId, role: null, granted_by: null }]);
    assert.deepEqual(await audited(plain), [
      {
        actor_id: null,
        actor_email: ACTOR.email,
        action: "app.activate",
        target_type: "app",
        target_id: plain,
        details: { via: "cli", smoke: true },
      },
      {
        actor_id: null,
        actor_email: ACTOR.email,
        action: "user.grant.add",
        target_type: "user",
        target_id: userId,
        details: { appSlug: plain, via: "cli", smoke: true },
      },
    ]);
  });

  test("run again, it changes nothing and audits nothing", async () => {
    assert.deepEqual(await activate(plain), { ok: true, activated: false, replaced: null, grant: "existing" });
    assert.equal((await audited(plain)).length, 2);
  });

  test("a global app is activated, and has nothing to grant", async () => {
    assert.deepEqual(await activate(global), { ok: true, activated: true, replaced: null, grant: "global" });
    assert.deepEqual(await grants(global), []);
  });

  test("a role kept from when the app was global becomes a grant, with the role while it is declared", async () => {
    const other = (
      await sql`insert into public.users (email, display_name) values (${`other-${run}@example.com`}, 'Other') returning id`
    )[0].id as string;
    // What the release step leaves for an app that was global: roles, not grants.
    await sql`
      insert into public.user_app_grants (user_id, app_slug, role, role_only)
      values (${userId}, ${wasGlobal}, 'editor', true), (${other}, ${wasGlobal}, 'retired', true)
    `;
    assert.deepEqual(await activate(wasGlobal), { ok: true, activated: true, replaced: null, grant: "added" });
    const [mine] = await sql`
      select role, role_only from public.user_app_grants where app_slug = ${wasGlobal} and user_id = ${userId}
    `;
    assert.deepEqual({ ...mine }, { role: "editor", role_only: false });
    assert.deepEqual(
      (await audited(wasGlobal)).map((r) => r.action),
      ["app.activate", "user.grant.add"],
    );

    // A role the app no longer declares falls back to the default.
    await sql`update public.apps set is_active = false where slug = ${wasGlobal}`;
    const { activateForSmoke } = await import("./smoke-activate");
    const result = await activateForSmoke(
      { slug: wasGlobal, email: `other-${run}@example.com`, actor: ACTOR },
      deps,
    );
    assert.deepEqual(result, { ok: true, activated: true, replaced: null, grant: "added" });
    const [theirs] = await sql`
      select role, role_only from public.user_app_grants where app_slug = ${wasGlobal} and user_id = ${other}
    `;
    assert.deepEqual({ ...theirs }, { role: null, role_only: false });
  });

  test("an app whose connector isn't configured is refused, as Activate refuses it", async () => {
    assert.deepEqual(await activate(needsCrm), {
      ok: false,
      code: "connectors",
      message: "Configure Acme CRM before activating this app.",
    });
    assert.equal((await row(needsCrm))?.is_active, false);
    assert.deepEqual(await audited(needsCrm), []);
  });

  test("an app that replaces a different extension is refused without its slug typed", async () => {
    for (const typed of [undefined, "", `${replaced}x`]) {
      const result = await activate(replaced, typed);
      assert.equal(result.ok, false);
      assert.ok(!result.ok && result.code === "replaces");
      assert.match(!result.ok ? result.message : "", /replaces a different extension with the same slug\. Type its slug to activate it\./);
    }
    assert.equal((await row(replaced))?.is_active, false);
    assert.deepEqual(await audited(replaced), []);
  });

  test("with its slug typed, it is activated, its flag cleared, and the audit row says what it replaced", async () => {
    assert.deepEqual(await activate(replaced, replaced), { ok: true, activated: true, replaced: "local", grant: "added" });
    assert.deepEqual(await row(replaced), { is_active: true, identity_changed_at: null, replaced_identity: null });
    const [activation] = await audited(replaced);
    assert.equal(activation.action, "app.activate");
    assert.deepEqual(activation.details, { via: "cli", smoke: true, replaced: "local" });
  });

  test("a user or an app it doesn't know is refused before anything changes", async () => {
    assert.deepEqual(await activate(plain, undefined, "nobody@example.com"), {
      ok: false,
      code: "no-user",
      message: "nobody@example.com isn't a user in this checkout's database.",
    });
    const unknown = await activate(`unknown-${run}`);
    assert.ok(!unknown.ok && unknown.code === "not-in-build");
  });

  test("the pull-request check's activate: by SQL, with a grant, and a failure for an app the build left out", async () => {
    await sql`insert into public.apps (slug, name, is_active) values (${`ci-${run}`}, 'CI', false)`;
    const problems = await activateAndGrant(sql, [`ci-${run}`, `left-out-${run}`], EMAIL);
    assert.deepEqual(problems, [
      `apps/left-out-${run}/ is in this pull request, but not in the build: the registry generator left it out. ` +
        "The release step's output says why.",
    ]);
    assert.equal((await row(`ci-${run}`))?.is_active, true);
    assert.deepEqual(await grants(`ci-${run}`), [{ user_id: userId, role: null, granted_by: null }]);
    assert.deepEqual(await activateAndGrant(sql, [`ci-${run}`], "nobody@example.com"), [
      "No user nobody@example.com to grant the apps to. Did the release step create the first admin?",
    ]);
    assert.deepEqual(await activateAndGrant(sql, ["Bad Slug"], EMAIL), ['"Bad Slug" isn\'t an app slug.']);
  });

  test("the pull-request check's grant makes a kept role a grant, and grants nothing for a global app", async () => {
    const kept = `ci-kept-${run}`;
    const everyone = `ci-global-${run}`;
    await sql`insert into public.apps (slug, name, is_active, global) values (${kept}, 'Kept', false, false), (${everyone}, 'Everyone', false, true)`;
    await sql`insert into public.user_app_grants (user_id, app_slug, role, role_only) values (${userId}, ${kept}, 'editor', true)`;
    assert.deepEqual(await activateAndGrant(sql, [kept, everyone], EMAIL), []);
    assert.deepEqual(
      (await sql`select role, role_only from public.user_app_grants where app_slug = ${kept}`).map((r) => ({ ...r })),
      [{ role: "editor", role_only: false }],
    );
    assert.deepEqual(await grants(everyone), []);
  });

  test("grants from both outlast a release step, each audited as the CLI", async () => {
    const ci = `ci-${run}`;
    const [audit] = await sql`
      select actor_id, actor_email, details from public.admin_audit_log
       where action = 'user.grant.add' and target_id = ${userId} and details->>'appSlug' = ${ci}
    `;
    assert.equal(audit.actor_id, null);
    assert.match(audit.actor_email as string, /^cli:/);
    assert.deepEqual(audit.details, { appSlug: ci, via: "ci" });

    // The release step, carrying both apps, leaves both grants as they are.
    const appsDir = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-smoke-release-"));
    try {
      for (const slug of [plain, ci]) {
        fs.mkdirSync(path.join(appsDir, slug));
        fs.writeFileSync(path.join(appsDir, slug, "app.json"), `{ "name": "${slug}" }\n`);
      }
      const { syncAppRegistry } = await import("./sync-app-registry");
      const mirror = (slug: string) => ({ slug, name: slug, description: "", icon: "box", global: false });
      const result = await syncAppRegistry(sql, [mirror(plain), mirror(ci)], appsDir, []);
      assert.deepEqual(result.globalEnded, []);
    } finally {
      fs.rmSync(appsDir, { recursive: true, force: true });
    }
    const rows = await sql`
      select app_slug, role_only from public.user_app_grants
       where user_id = ${userId} and app_slug = any(${[plain, ci]}::text[]) order by app_slug
    `;
    assert.deepEqual(rows.map((r) => ({ ...r })), [
      { app_slug: ci, role_only: false },
      { app_slug: plain, role_only: false },
    ]);
    // The check grants again on its next run: still a grant, nothing more recorded.
    assert.deepEqual(await activateAndGrant(sql, [ci], EMAIL), []);
    const [{ n }] = await sql`
      select count(*)::int as n from public.admin_audit_log
       where action = 'user.grant.add' and target_id = ${userId} and details->>'appSlug' = ${ci}
    `;
    assert.equal(n, 1);
  });
});
