/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The search behind Grant access (`searchUsersForGrant`, ./grant-actions.ts) on
 * connections where `standard_conforming_strings` is off.
 *
 * With it off, a backslash inside a string literal in the SQL is an escape, so
 * a LIKE clause written `escape '\'` stops parsing. The search's escape
 * character is `!`, which means the same with the setting either way, and the
 * pattern itself is a bind parameter. This runs it where the setting is off,
 * for the whole platform pool, and expects the same answers as with it on.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database on. The database's name ends in this run's own suffix, and
 * it is dropped when the run finishes:
 *
 *   docker run -d --name search -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test src/lib/apps/grant-search.integration.test.ts
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
const serverUrl = process.env.MIXOS_TEST_DATABASE_URL;
const skip = serverUrl ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres";

const run = randomBytes(3).toString("hex");
const database = `mixos_search_${run}`;
const SLUG = `files-${run}`;

const STUBS = new Map<string, string>([
  [
    "@/lib/auth/session",
    `const current = () => (globalThis as { __searchSession?: unknown }).__searchSession ?? null;
export async function getReadOnlySession() { return current(); }
export async function requireReadOnlySession() {
  const session = current();
  if (!session) throw new Error("no session in this test");
  return session;
}
export const requireServerSession = requireReadOnlySession;
`,
  ],
  ["next/cache", `export function revalidatePath() {}\nexport function revalidateTag() {}\n`],
]);

const APP = {
  slug: SLUG,
  name: "Files",
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
  global: false,
  roles: [],
  defaultRole: null,
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
} satisfies AppManifest;

describe("the Grant access search, with standard_conforming_strings off", { skip }, () => {
  let admin: Sql;
  let sql: Sql;
  let work: string;
  let resolver: ReturnType<typeof registerHooks> | undefined;
  let p: {
    grants: typeof import("./grant-actions");
    registry: typeof import("../../generated/app-registry");
    db: typeof import("../db/client");
  };

  before(async () => {
    admin = postgres(serverUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${database}`);
    const u = new URL(serverUrl!);
    u.pathname = `/${database}`;
    sql = postgres(u.toString(), { max: 1, onnotice: () => {} });
    const { migratePlatform } = await import("../../../scripts/platform-migrations");
    await migratePlatform(sql, path.join(REPO, "supabase", "migrations"), () => {});

    work = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-grant-search-"));
    const urls = new Map<string, string>();
    for (const [specifier, source] of STUBS) {
      const file = path.join(work, `${specifier.replace(/[^a-z]+/g, "-")}.ts`);
      fs.writeFileSync(file, source);
      urls.set(specifier, pathToFileURL(file).href);
    }
    resolver = registerHooks({
      resolve(specifier, context, nextResolve) {
        const stub = urls.get(specifier);
        return stub ? nextResolve(stub, context) : nextResolve(specifier, context);
      },
    });

    await sql`insert into public.apps (slug, name, is_active) values (${SLUG}, 'Files', true)`;
    const [{ id: adminId }] = await sql`
      insert into public.users (email, display_name, is_admin)
      values (${`admin-${run}@example.com`}, 'Admin', true) returning id
    `;
    for (const name of ["back\\slash", "Hey!", "100% Sure", "snake_case", "Plain"]) {
      await sql`
        insert into public.users (email, display_name)
        values (${`${name.toLowerCase().replace(/[^a-z0-9]+/g, ".")}-${run}@example.org`}, ${name})
      `;
    }
    (globalThis as { __searchSession?: unknown }).__searchSession = {
      user: { id: adminId, email: `admin-${run}@example.com`, name: "Admin", isAdmin: true },
    };

    // Every connection the platform pool opens starts with the setting off.
    u.searchParams.set("standard_conforming_strings", "off");
    process.env.DATABASE_URL = u.toString();
    process.env.PGSSLMODE = "disable";
    process.env.NEXTAUTH_URL ??= "http://localhost:3000";

    p = {
      grants: await import("./grant-actions"),
      registry: await import("../../generated/app-registry"),
      db: await import("../db/client"),
    };
    p.registry.appRegistry.push(APP);
  });

  after(async () => {
    try {
      if (p) {
        const at = p.registry.appRegistry.findIndex((r) => r.slug === SLUG);
        if (at >= 0) p.registry.appRegistry.splice(at, 1);
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

  test("the platform's connections have it off", async () => {
    const [{ standard_conforming_strings: setting }] = await p.db.sql`show standard_conforming_strings`;
    assert.equal(setting, "off");
  });

  test("the search parses, and matches every character literally", async () => {
    const names = async (q: string) => (await p.grants.searchUsersForGrant(SLUG, q)).map((u) => u.name);
    assert.deepEqual(await names("\\"), ["back\\slash"]);
    assert.deepEqual(await names("k\\s"), ["back\\slash"]);
    assert.deepEqual(await names("!"), ["Hey!"]);
    assert.deepEqual(await names("%"), ["100% Sure"]);
    assert.deepEqual(await names("e_c"), ["snake_case"]);
    assert.deepEqual(await names("_"), ["snake_case"]);
    assert.deepEqual(await names("'"), []);
    assert.deepEqual(await names("plain"), ["Plain"]);
  });
});
