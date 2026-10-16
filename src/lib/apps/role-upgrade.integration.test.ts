/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Grants and roles across an upgrade, against a real Postgres: a database at
 * 0012 with rows written exactly as the code before migration 0013 wrote them,
 * then this build's migrations and release step (scripts/sync-app-registry.ts),
 * and the rule every access check applies (./grant-rule.ts).
 *
 * What it proves:
 *
 *   - a row is a grant when someone is recorded granting it, an admin in
 *     `granted_by` or the CLI in its own `user.grant.add` audit row, from the
 *     row's time on; anything else is only a role. A grant revoked long ago,
 *     then a role, is only a role, and so is a role with an admin's audit row
 *     and no `granted_by`;
 *   - the deploy that first applies 0013 and makes an app stop being global
 *     leaves nobody holding it through a role, and Admin > Apps says it needs
 *     grants; a grant made before the app went global outlasts it;
 *   - an app missing from that deploy is decided when it returns, and says it
 *     needs grants then;
 *   - a row an older build writes after a host rolls back to it is decided by
 *     the same rule at once, before any release step, and by the next one;
 *   - a build that sees an app as global, sharing the database, demotes no
 *     grant, and when the app is back to not global nobody has lost it, so it
 *     needs no grants.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database on. The database's name ends in this run's own suffix, and
 * it is dropped when the run finishes:
 *
 *   docker run -d --name roles -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test src/lib/apps/role-upgrade.integration.test.ts
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import postgres, { type Sql } from "postgres";
import type { AppManifest } from "./types";

const REPO = path.resolve(__dirname, "..", "..", "..");
const MIGRATIONS = path.join(REPO, "supabase", "migrations");
const serverUrl = process.env.MIXOS_TEST_DATABASE_URL;
const skip = serverUrl ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres";

const run = randomBytes(3).toString("hex");
const database = `mixos_roles_${run}`;

/** Global under the old build, not under the new one. */
const G = `g-${run}`;
/** Never global. */
const N = `n-${run}`;
/** Global under the old build, missing from the first new release step. */
const A = `a-${run}`;
/** Not global in production; a preview build sharing the database says it is. */
const P = `p-${run}`;

const STUBS = new Map<string, string>([
  [
    "@/lib/auth/session",
    `export async function getReadOnlySession() { return null; }
export async function requireReadOnlySession() { throw new Error("no session in this test"); }
export const requireServerSession = requireReadOnlySession;
`,
  ],
  ["next/cache", `export function revalidatePath() {}\nexport function revalidateTag() {}\n`],
]);

function manifest(slug: string, global: boolean): AppManifest {
  return {
    slug,
    name: slug,
    description: "",
    tagline: null,
    icon: "box",
    connectors: [],
    optionalConnectors: [],
    database: false,
    updatedAt: [],
    notifications: false,
    hasPages: false,
    pageCount: 0,
    global,
    roles: [
      { key: "lead", label: "Lead" },
      { key: "member", label: "Member" },
    ],
    defaultRole: "member",
    hookCounts: { actions: 0, filters: 0 },
    hooks: { emits: { actions: [], filters: [] }, listens: { actions: [], filters: [] } },
    authors: [],
    keywords: [],
    screenshots: [],
    license: null,
    appUrl: null,
    appSupportUrl: null,
    lastUpdated: null,
    escapes: [],
    env: [],
    egress: [],
    sync: [],
    routes: [],
    widgets: [],
    schedules: [],
    telemetry: [],
    provides: [],
    consumes: [],
    emits: [],
    listensTo: [],
    branding: null,
    mcp: [],
  };
}

describe("grants and roles across the upgrade to 0013", { skip }, () => {
  let admin: Sql;
  let sql: Sql;
  let work: string;
  let appsDir: string;
  let resolver: ReturnType<typeof registerHooks> | undefined;
  let p: {
    access: typeof import("./access");
    sync: typeof import("../../../scripts/sync-app-registry");
    registry: typeof import("../../generated/app-registry");
    db: typeof import("../db/client");
  };
  const u: Record<string, string> = {};
  const adminEmail = `admin-${run}@example.com`;

  /** Who holds what, as every access check decides it. */
  const holds = (who: string, slug: string) => p.access.hasAppGrant(u[who], slug);
  /** What each row was decided to be: true for only a role, null for undecided. */
  async function decided(slug: string) {
    const rows = await sql`select user_id, role_only from public.user_app_grants where app_slug = ${slug}`;
    const name = (id: string) => Object.keys(u).find((k) => u[k] === id)!;
    return Object.fromEntries(rows.map((r) => [name(r.user_id as string), r.role_only as boolean | null]));
  }
  /** An app's Needs grants mark: why, or null. */
  const needsGrants = async (slug: string) =>
    ((await sql`select needs_grants_reason from public.apps where slug = ${slug}`)[0]?.needs_grants_reason as string | null) ?? null;
  /** The release step, for the apps this build carries, each global or not. */
  const release = (apps: [string, boolean][]) => {
    const registry = p.registry.appRegistry;
    for (const [slug, global] of apps) {
      const at = registry.findIndex((r) => r.slug === slug);
      if (at >= 0) registry.splice(at, 1);
      registry.push(manifest(slug, global));
    }
    for (const slug of [G, N, A, P]) {
      if (!apps.some(([s]) => s === slug)) {
        const at = registry.findIndex((r) => r.slug === slug);
        if (at >= 0) registry.splice(at, 1);
      }
    }
    return p.sync.syncAppRegistry(
      sql,
      apps.map(([slug, global]) => ({ slug, name: slug, description: "", icon: "box", global })),
      appsDir,
      [],
    );
  };
  /** As the code before 0013 audited, `ago` before now. */
  const audit = (action: string, actor: string | null, email: string, target: string, details: object, ago: string) =>
    sql`
      insert into public.admin_audit_log (actor_id, actor_email, action, target_type, target_id, details, created_at)
      values (${actor}, ${email}, ${action}, 'user', ${target}, ${sql.json(details as never)}, now() - ${ago}::interval)
    `;

  before(async () => {
    admin = postgres(serverUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${database}`);
    const url = new URL(serverUrl!);
    url.pathname = `/${database}`;
    sql = postgres(url.toString(), { max: 1, onnotice: () => {} });

    work = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-role-upgrade-"));
    const through12 = path.join(work, "migrations-0012");
    fs.mkdirSync(through12);
    for (const file of fs.readdirSync(MIGRATIONS).filter((f) => /^(000\d|001[0-2])_.*\.sql$/.test(f))) {
      fs.copyFileSync(path.join(MIGRATIONS, file), path.join(through12, file));
    }
    const { migratePlatform } = await import("../../../scripts/platform-migrations");
    await migratePlatform(sql, through12, () => {});

    const urls = new Map<string, string>();
    for (const [specifier, source] of STUBS) {
      const file = path.join(work, "stubs", `${specifier.replace(/[^a-z]+/g, "-")}.ts`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, source);
      urls.set(specifier, pathToFileURL(file).href);
    }
    resolver = registerHooks({
      resolve(specifier, context, nextResolve) {
        const stub = urls.get(specifier);
        return stub ? nextResolve(stub, context) : nextResolve(specifier, context);
      },
    });
    process.env.DATABASE_URL = url.toString();
    process.env.PGSSLMODE = url.searchParams.get("sslmode") ?? "disable";
    process.env.NEXTAUTH_URL ??= "http://localhost:3000";

    p = {
      access: await import("./access"),
      sync: await import("../../../scripts/sync-app-registry"),
      registry: await import("../../generated/app-registry"),
      db: await import("../db/client"),
    };
    const { appCodeHash } = await import("../../../scripts/app-code-hash");

    // The apps as the old build's release step left them: active, local.
    appsDir = path.join(work, "apps");
    for (const slug of [G, N, A, P]) {
      fs.mkdirSync(path.join(appsDir, slug), { recursive: true });
      fs.writeFileSync(path.join(appsDir, slug, "app.json"), `{ "name": "${slug}" }\n`);
      await sql`
        insert into public.apps (slug, name, is_active, code_hash, identity)
        values (${slug}, ${slug}, true, ${appCodeHash(path.join(appsDir, slug))}, 'local')
      `;
    }
    for (const who of ["admin", "ua", "ub", "uc", "ud", "ue", "uf", "ug", "uh", "ui", "uj", "uk", "ul", "um"]) {
      const [row] = await sql`
        insert into public.users (email, display_name, is_admin)
        values (${`${who}-${run}@example.com`}, ${who}, ${who === "admin"}) returning id
      `;
      u[who] = row.id as string;
    }

    // The rows, as the code before 0013 wrote them.
    // ua: a role on G, global then (setUserAppRole: no granted_by), audited as a role.
    await sql`insert into public.user_app_grants (user_id, app_slug, role, granted_at) values (${u.ua}, ${G}, 'lead', now() - interval '2 days')`;
    await audit("user.role.set", u.admin, adminEmail, u.ua, { appSlug: G, role: "lead" }, "2 days");
    // ub: an admin's grant of G, made before it was global.
    await sql`insert into public.user_app_grants (user_id, app_slug, role, granted_by, granted_at) values (${u.ub}, ${G}, 'member', ${u.admin}, now() - interval '20 days')`;
    await audit("user.grant.add", u.admin, adminEmail, u.ub, { appSlug: G }, "20 days");
    // uc: the CLI's smoke grant of N: no granted_by, audited as the CLI after the row.
    await sql`insert into public.user_app_grants (user_id, app_slug, role, granted_at) values (${u.uc}, ${N}, 'member', now() - interval '3 days')`;
    await audit("user.grant.add", null, "cli:someone@host", u.uc, { appSlug: N, via: "cli", smoke: true }, "3 days");
    // ud: an admin's grant of N.
    await sql`insert into public.user_app_grants (user_id, app_slug, role, granted_by, granted_at) values (${u.ud}, ${N}, 'member', ${u.admin}, now() - interval '4 days')`;
    await audit("user.grant.add", u.admin, adminEmail, u.ud, { appSlug: N }, "4 days");
    // ue: a role on A, global then.
    await sql`insert into public.user_app_grants (user_id, app_slug, role, granted_at) values (${u.ue}, ${A}, 'lead', now() - interval '2 days')`;
    await audit("user.role.set", u.admin, adminEmail, u.ue, { appSlug: A, role: "lead" }, "2 days");
    // uf: granted G long ago and revoked; G went global, and uf was given a role.
    await audit("user.grant.add", u.admin, adminEmail, u.uf, { appSlug: G }, "10 days");
    await audit("user.grant.revoke", u.admin, adminEmail, u.uf, { appSlug: G }, "9 days");
    await sql`insert into public.user_app_grants (user_id, app_slug, role, granted_at) values (${u.uf}, ${G}, 'lead', now() - interval '1 day')`;
    await audit("user.role.set", u.admin, adminEmail, u.uf, { appSlug: G, role: "lead" }, "1 day");
    // ui: an admin's grant of P.
    await sql`insert into public.user_app_grants (user_id, app_slug, granted_by, granted_at) values (${u.ui}, ${P}, ${u.admin}, now() - interval '5 days')`;
    await audit("user.grant.add", u.admin, adminEmail, u.ui, { appSlug: P }, "5 days");

    // This build's migrations, as its release step applies them.
    await migratePlatform(sql, MIGRATIONS, () => {});
  });

  after(async () => {
    try {
      if (p) {
        for (const slug of [G, N, A, P]) {
          const at = p.registry.appRegistry.findIndex((r) => r.slug === slug);
          if (at >= 0) p.registry.appRegistry.splice(at, 1);
        }
        await p.db.sql.end();
      }
      resolver?.deregister();
    } finally {
      await sql?.end();
      if (admin) {
        await admin.unsafe(`drop database if exists ${database} with (force)`);
        await admin.end();
      }
      if (work) fs.rmSync(work, { recursive: true, force: true });
    }
  });

  test("0013 decides nothing: every row is undecided until a release step", async () => {
    assert.deepEqual(await decided(G), { ua: null, ub: null, uf: null });
    assert.deepEqual(await decided(N), { uc: null, ud: null });
  });

  test("the deploy that applies 0013 and ends G's being global: roles grant nothing, grants stay", async () => {
    const first = await release([
      [G, false],
      [N, false],
      [P, false],
    ]);
    // ua's role and uf's role after a revoke are roles; the rest are grants.
    assert.deepEqual(await decided(G), { ua: true, ub: false, uf: true });
    assert.deepEqual(await decided(N), { uc: false, ud: false });
    assert.deepEqual(await decided(P), { ui: false });
    assert.deepEqual(first.marked, [{ slug: G, roleOnly: 2 }]);
    const [marked] = await sql`
      select details, actor_email from public.admin_audit_log where action = 'app.grants.marked' and target_id = ${G}
    `;
    assert.deepEqual([marked.details, marked.actor_email], [{ roleOnly: 2 }, "release-step"]);

    assert.equal(await holds("ua", G), false);
    assert.equal(await holds("uf", G), false);
    assert.equal(await holds("ub", G), true, "a grant from before G went global was lost");
    assert.equal(await holds("uc", N), true, "the CLI's grant was lost");
    assert.equal(await holds("ud", N), true);
    // Admin > Apps says G needs grants.
    assert.equal(await needsGrants(G), "roles-decided");
    assert.equal((await p.access.getAppBuildStatus()).needsGrants[G]?.reason, "roles-decided");
    assert.equal(await needsGrants(N), null);
    // A is missing from this build, and its row is left as it was.
    assert.deepEqual(await decided(A), { ue: null });
  });

  test("an app missing from that deploy is decided when it returns, and says it needs grants", async () => {
    const back = await release([
      [G, false],
      [N, false],
      [P, false],
      [A, false],
    ]);
    assert.deepEqual(back.marked, [{ slug: A, roleOnly: 1 }]);
    assert.deepEqual(await decided(A), { ue: true });
    // Back with the same files, so back active, as it left: held by nobody
    // through a role, and marked for the admin.
    const [row] = await sql`select is_active from public.apps where slug = ${A}`;
    assert.equal(row.is_active, true);
    assert.equal(await holds("ue", A), false);
    assert.equal(await needsGrants(A), "roles-decided");
  });

  test("a row an older build writes after a rollback is decided at once, and by the next release step", async () => {
    // As the code before 0013 writes them, while a host serves it again: a
    // role for ug, and an admin's grant for uh, on G, global to that build.
    await sql`insert into public.user_app_grants (user_id, app_slug, role) values (${u.ug}, ${G}, 'lead')`;
    await audit("user.role.set", u.admin, adminEmail, u.ug, { appSlug: G, role: "lead" }, "0 seconds");
    await sql`insert into public.user_app_grants (user_id, app_slug, granted_by) values (${u.uh}, ${G}, ${u.admin})`;
    await audit("user.grant.add", u.admin, adminEmail, u.uh, { appSlug: G }, "0 seconds");

    // This build again, before any release step.
    assert.equal(await holds("ug", G), false, "a role written during a rollback was access");
    assert.equal(await holds("uh", G), true, "a grant written during a rollback was lost");

    const next = await release([
      [G, false],
      [N, false],
      [P, false],
      [A, false],
    ]);
    assert.deepEqual(next.marked, [{ slug: G, roleOnly: 1 }]);
    assert.deepEqual(await decided(G), { ua: true, ub: false, uf: true, ug: true, uh: false });
    assert.equal(await holds("ug", G), false);
    assert.equal(await holds("uh", G), true);
  });

  test("a build that sees an app as global, on the same database, demotes no grant", async () => {
    // A preview whose manifest makes P global runs its release step.
    const preview = await release([
      [G, false],
      [N, false],
      [P, true],
      [A, false],
    ]);
    assert.deepEqual(preview.marked, []);
    assert.deepEqual(await decided(P), { ui: false });
    // Production's release step again: P isn't global, and ui still has it.
    // Recorded as the end of a global phase; nobody lost anything, so P
    // doesn't need grants.
    const production = await release([
      [G, false],
      [N, false],
      [P, false],
      [A, false],
    ]);
    assert.deepEqual(await decided(P), { ui: false });
    assert.equal(await holds("ui", P), true, "a preview build's release step took a production grant");
    assert.deepEqual(production.globalEnded, [{ slug: P, roleOnly: 0, lost: 0 }]);
    assert.equal(await needsGrants(P), null);
  });

  test("run again, the release step decides nothing more", async () => {
    const audits = (await sql`select count(*)::int as n from public.admin_audit_log where action = 'app.grants.marked'`)[0].n;
    const again = await release([
      [G, false],
      [N, false],
      [P, false],
      [A, false],
    ]);
    assert.deepEqual(again.marked, []);
    assert.equal((await sql`select count(*)::int as n from public.admin_audit_log where action = 'app.grants.marked'`)[0].n, audits);
  });

  test("only the CLI's own audit rows make an undecided row a grant", async () => {
    // Undecided rows on N, as an older build writes them, each with an audit
    // row written after it.
    for (const who of ["uj", "uk", "ul", "um"]) {
      await sql`insert into public.user_app_grants (user_id, app_slug, role) values (${u[who]}, ${N}, 'member')`;
    }
    // uj: an admin's user.grant.add, with no granted_by: no grant path writes
    // that, and it is no evidence.
    await audit("user.grant.add", u.admin, adminEmail, u.uj, { appSlug: N }, "0 seconds");
    // uk: the CLI's smoke grant. ul: the pull-request check's.
    await audit("user.grant.add", null, "cli:dev@laptop", u.uk, { appSlug: N, via: "cli", smoke: true }, "0 seconds");
    await audit("user.grant.add", null, "cli:runner@ci-host", u.ul, { appSlug: N, via: "ci" }, "0 seconds");
    // um: no admin, but not the CLI's either.
    await audit("user.grant.add", null, "release-step", u.um, { appSlug: N }, "0 seconds");

    assert.equal(await holds("uj", N), false, "an admin's audit row alone made a role a grant");
    assert.equal(await holds("uk", N), true, "the CLI's grant was lost");
    assert.equal(await holds("ul", N), true, "the pull-request check's grant was lost");
    assert.equal(await holds("um", N), false);

    const last = await release([
      [G, false],
      [N, false],
      [P, false],
      [A, false],
    ]);
    assert.deepEqual(last.marked, [{ slug: N, roleOnly: 2 }]);
    assert.deepEqual(await decided(N), { uc: false, ud: false, uj: true, uk: false, ul: false, um: true });
    assert.equal(await needsGrants(N), "roles-decided");
  });
});
