/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Grants and roles when release steps disagree about whether an app is global,
 * against a real Postgres: this build's release step
 * (scripts/sync-app-registry.ts) and the rule every access check applies
 * (./grant-rule.ts), on rows written as the grant paths write them.
 *
 * What it proves:
 *
 *   - the deploy that makes an app stop being global leaves nobody holding it
 *     through a role, and says it needs grants; a grant made before the app
 *     went global outlasts it;
 *   - a build that sees an app as global, sharing the database, demotes no
 *     grant, and when the app is back to not global nobody has lost it, so it
 *     needs no grants;
 *   - run again, the release step changes nothing.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database on. The database's name ends in this run's own suffix, and
 * it is dropped when the run finishes:
 *
 *   docker run -d --name roles -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test src/lib/apps/global-builds.integration.test.ts
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
const database = `mixos_global_${run}`;

/** Global, until a deploy makes it not global. */
const G = `g-${run}`;
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

describe("release steps that disagree about whether an app is global", { skip }, () => {
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

  /** Who holds what, as every access check decides it. */
  const holds = (who: string, slug: string) => p.access.hasAppGrant(u[who], slug);
  /** What each row is: true for only a role. */
  async function rows(slug: string) {
    const found = await sql`select user_id, role_only from public.user_app_grants where app_slug = ${slug}`;
    const name = (id: string) => Object.keys(u).find((k) => u[k] === id)!;
    return Object.fromEntries(found.map((r) => [name(r.user_id as string), r.role_only as boolean]));
  }
  /** An app's Needs grants mark: why, or null. */
  const needsGrants = async (slug: string) =>
    ((await sql`select needs_grants_reason from public.apps where slug = ${slug}`)[0]?.needs_grants_reason as string | null) ?? null;
  /** The release step, for a build that says whether each app is global. */
  const release = (apps: [string, boolean][]) => {
    const registry = p.registry.appRegistry;
    for (const [slug, global] of apps) {
      const at = registry.findIndex((r) => r.slug === slug);
      if (at >= 0) registry.splice(at, 1);
      registry.push(manifest(slug, global));
    }
    return p.sync.syncAppRegistry(
      sql,
      apps.map(([slug, global]) => ({ slug, name: slug, description: "", icon: "box", global })),
      appsDir,
      [],
    );
  };

  before(async () => {
    admin = postgres(serverUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${database}`);
    const url = new URL(serverUrl!);
    url.pathname = `/${database}`;
    sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
    const { migratePlatform } = await import("../../../scripts/platform-migrations");
    await migratePlatform(sql, MIGRATIONS, () => {});

    work = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-global-builds-"));
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

    appsDir = path.join(work, "apps");
    for (const slug of [G, P]) {
      fs.mkdirSync(path.join(appsDir, slug), { recursive: true });
      fs.writeFileSync(path.join(appsDir, slug, "app.json"), `{ "name": "${slug}" }\n`);
      await sql`
        insert into public.apps (slug, name, is_active, code_hash, identity)
        values (${slug}, ${slug}, true, ${appCodeHash(path.join(appsDir, slug))}, 'local')
      `;
    }
    for (const who of ["admin", "ua", "ub", "uf", "ui"]) {
      const [row] = await sql`
        insert into public.users (email, display_name, is_admin)
        values (${`${who}-${run}@example.com`}, ${who}, ${who === "admin"}) returning id
      `;
      u[who] = row.id as string;
    }

    // G, global: ua and uf were given roles, rows that record only the role,
    // and ub was granted it, by an admin, before it went global.
    await sql`
      insert into public.user_app_grants (user_id, app_slug, role, granted_by, role_only) values
        (${u.ua}, ${G}, 'lead', null, true),
        (${u.uf}, ${G}, 'lead', null, true),
        (${u.ub}, ${G}, 'member', ${u.admin}, false)
    `;
    // P: ui's admin grant.
    await sql`
      insert into public.user_app_grants (user_id, app_slug, role, granted_by, role_only)
      values (${u.ui}, ${P}, null, ${u.admin}, false)
    `;
  });

  after(async () => {
    try {
      if (p) {
        for (const slug of [G, P]) {
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

  test("while G is global, everyone has it and nothing needs grants", async () => {
    const first = await release([
      [G, true],
      [P, false],
    ]);
    assert.deepEqual(first.globalEnded, []);
    assert.equal(await holds("ua", G), true);
    assert.equal(await needsGrants(G), null);
  });

  test("the deploy that ends G's being global: roles grant nothing, grants stay, and it needs grants", async () => {
    const ended = await release([
      [G, false],
      [P, false],
    ]);
    assert.deepEqual(ended.globalEnded, [{ slug: G, roleOnly: 2, lost: 2 }]);
    assert.deepEqual(await rows(G), { ua: true, uf: true, ub: false });
    assert.equal(await holds("ua", G), false);
    assert.equal(await holds("uf", G), false);
    assert.equal(await holds("ub", G), true, "a grant from before G went global was lost");
    assert.equal(await needsGrants(G), "global-ended");
    assert.equal((await p.access.getAppBuildStatus()).needsGrants[G]?.reason, "global-ended");
  });

  test("a build that sees an app as global, on the same database, demotes no grant", async () => {
    // A preview whose manifest makes P global runs its release step.
    const preview = await release([
      [G, false],
      [P, true],
    ]);
    assert.deepEqual(preview.globalEnded, []);
    assert.deepEqual(await rows(P), { ui: false });
    // Production's release step again: P isn't global, and ui still has it.
    // Recorded as the end of a global phase; nobody lost anything, so P
    // doesn't need grants.
    const production = await release([
      [G, false],
      [P, false],
    ]);
    assert.deepEqual(await rows(P), { ui: false });
    assert.equal(await holds("ui", P), true, "a preview build's release step took a production grant");
    assert.deepEqual(production.globalEnded, [{ slug: P, roleOnly: 0, lost: 0 }]);
    assert.equal(await needsGrants(P), null);
  });

  test("run again, the release step changes nothing", async () => {
    const was = await sql`select slug, global, needs_grants_reason from public.apps where slug = any(${[G, P]}) order by slug`;
    const again = await release([
      [G, false],
      [P, false],
    ]);
    assert.deepEqual(again.globalEnded, []);
    const now = await sql`select slug, global, needs_grants_reason from public.apps where slug = any(${[G, P]}) order by slug`;
    assert.deepEqual(now.map((r) => ({ ...r })), was.map((r) => ({ ...r })));
  });
});
