/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The two analytics ingestion routes, `/api/analytics/track` and
 * `/api/analytics/app-open`, sent real requests against a real Postgres. An
 * event is recorded only for an app the user holds, while its code may run. A
 * user without the grant, a switched-off app and an app being updated are each
 * refused by both routes with the answer an app that doesn't exist gets, and
 * nothing is recorded.
 *
 * Being updated as the app gate reads it: this build carries a migration of
 * the app's that the ledger lacks. The test adds it to the generated
 * `EXPECTED_APP_MIGRATIONS`, as the registry generator would for an app in the
 * build. A resolve hook stands in for the session, which needs a Next request.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database on. The database's name ends in this run's own suffix, and
 * it is dropped when the run finishes:
 *
 *   docker run -d --name analytics -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test src/lib/analytics/ingest.integration.test.ts
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
import type { AppManifest } from "@/lib/apps/types";

const REPO = path.resolve(__dirname, "..", "..", "..");
const serverUrl = process.env.MIXOS_TEST_DATABASE_URL;
const skip = serverUrl ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres";

const run = randomBytes(3).toString("hex");
const database = `mixos_analytics_${run}`;
const USER_EMAIL = `user-${run}@example.com`;

/** Granted, active and up to date: its events are recorded. */
const HELD = `held-${run}`;
/** Global, so everyone holds it without a grant row. */
const GLOBAL = `global-${run}`;
/** Active and up to date, and the user holds no grant to it. */
const UNGRANTED = `ungranted-${run}`;
/** Granted, and switched off by an admin. */
const INACTIVE = `inactive-${run}`;
/** Granted and active, with a migration of its own the database hasn't applied. */
const UPDATING = `updating-${run}`;
/** No app at all. */
const UNKNOWN = `unknown-${run}`;

const EVENT = "clicked";
const MIGRATION = "0001_items.sql";

/** What the gateway answers for an app that isn't there. */
const NOT_FOUND = { status: 404, body: JSON.stringify({ error: "Not found", code: "NOT_FOUND" }) };

/** Made in `before`, so a skipped run leaves nothing behind. */
let work: string;

/** The runner, the gate and the routes log as they go; the tests read the database. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, { log, warn, error });
  }
}

/**
 * Drop every kept answer to "is the database behind", so the next request
 * reads the ledger. They live on globalThis (`src/lib/platform/maintenance.ts`
 * and `src/lib/platform/schema-version.ts`).
 */
function forgetMaintenanceAnswers(): void {
  const g = globalThis as {
    __maintenanceState?: { kept?: unknown };
    __appMigrationCache?: unknown;
    __schemaVersionCache?: unknown;
  };
  delete g.__appMigrationCache;
  delete g.__schemaVersionCache;
  if (g.__maintenanceState) delete g.__maintenanceState.kept;
}

/** The session the routes read, standing in for Auth.js. */
const SESSION_STUB = `export async function getReadOnlySession() {
  return (globalThis as { __analyticsSession?: unknown }).__analyticsSession ?? null;
}
export async function requireReadOnlySession() {
  throw new Error("not used by the analytics routes");
}
export const requireServerSession = requireReadOnlySession;
`;

async function loadPlatform() {
  return {
    track: (await import("@/app/api/analytics/track/route")).POST,
    appOpen: (await import("@/app/api/analytics/app-open/route")).POST,
    gate: await import("@/lib/apps/app-gate"),
    access: await import("@/lib/apps/access"),
    registry: await import("@/generated/app-registry"),
    buildInfo: await import("@/generated/build-info"),
    db: await import("@/lib/db/client"),
  };
}

describe("analytics ingestion", { skip }, () => {
  let admin: Sql;
  let sql: Sql;
  let resolver: ReturnType<typeof registerHooks> | undefined;
  let p: Awaited<ReturnType<typeof loadPlatform>>;
  let userId: string;

  const request = (route: string, body: unknown) =>
    new Request(`http://localhost/api/analytics/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  /** Status and body: everything a caller can tell one answer from another by. */
  async function answer(res: Response) {
    return { status: res.status, body: await res.text() };
  }

  const track = (appSlug: string, extra: Record<string, unknown> = {}) =>
    quietly(async () => answer(await p.track(request("track", { appSlug, event: EVENT, ...extra }))));
  const appOpen = (appSlug: string) =>
    quietly(async () => answer(await p.appOpen(request("app-open", { appSlug }))));

  /** Every row either route has written, for any app or user. */
  async function recorded() {
    const [row] = await sql`
      select (select count(*)::int from public.telemetry_events) as events,
             (select count(*)::int from public.app_open_events) as opens
    `;
    return { events: row.events as number, opens: row.opens as number };
  }

  before(async () => {
    admin = postgres(serverUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${database}`);
    const u = new URL(serverUrl!);
    u.pathname = `/${database}`;
    sql = postgres(u.toString(), { max: 1, onnotice: () => {} });
    work = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-analytics-"));

    const { migratePlatform } = await import("../../../scripts/platform-migrations");
    await quietly(() => migratePlatform(sql, path.join(REPO, "supabase", "migrations")));

    const stub = path.join(work, "session.ts");
    fs.writeFileSync(stub, SESSION_STUB);
    const stubUrl = pathToFileURL(stub).href;
    resolver = registerHooks({
      resolve(specifier, context, nextResolve) {
        return nextResolve(specifier === "@/lib/auth/session" ? stubUrl : specifier, context);
      },
    });

    // The platform's own client, pointed at this database.
    process.env.DATABASE_URL = u.toString();
    process.env.PGSSLMODE = u.searchParams.get("sslmode") ?? "disable";
    process.env.NEXTAUTH_URL ??= "http://localhost:3000";
    p = await loadPlatform();

    // The apps, as the registry generator would emit them, each declaring the
    // one event the tests send.
    const base = p.registry.appRegistry[0];
    assert.ok(base, "the registry needs one app to copy a manifest shape from");
    for (const slug of [HELD, GLOBAL, UNGRANTED, INACTIVE, UPDATING]) {
      p.registry.appRegistry.push({
        ...base,
        slug,
        name: slug,
        global: slug === GLOBAL,
        telemetry: [{ name: EVENT, description: "Clicked" }],
      } as AppManifest);
    }
    (p.buildInfo.EXPECTED_APP_MIGRATIONS as { slug: string; file: string }[]).push({
      slug: UPDATING,
      file: MIGRATION,
    });
    forgetMaintenanceAnswers();

    await sql`
      insert into public.apps (slug, name, is_active) values
        (${HELD}, ${HELD}, true),
        (${GLOBAL}, ${GLOBAL}, true),
        (${UNGRANTED}, ${UNGRANTED}, true),
        (${INACTIVE}, ${INACTIVE}, false),
        (${UPDATING}, ${UPDATING}, true)
    `;
    const [user] = await sql`
      insert into public.users (email, display_name) values (${USER_EMAIL}, 'User') returning id
    `;
    userId = user.id;
    await sql`
      insert into public.user_app_grants (user_id, app_slug) values
        (${userId}, ${HELD}), (${userId}, ${INACTIVE}), (${userId}, ${UPDATING})
    `;
    (globalThis as { __analyticsSession?: unknown }).__analyticsSession = {
      user: { id: userId, email: USER_EMAIL, name: "User", isAdmin: false },
    };
  });

  after(async () => {
    try {
      if (p) {
        const registry = p.registry.appRegistry;
        for (const slug of [HELD, GLOBAL, UNGRANTED, INACTIVE, UPDATING]) {
          const at = registry.findIndex((a) => a.slug === slug);
          if (at >= 0) registry.splice(at, 1);
        }
        const expected = p.buildInfo.EXPECTED_APP_MIGRATIONS as { slug: string; file: string }[];
        const at = expected.findIndex((m) => m.slug === UPDATING);
        if (at >= 0) expected.splice(at, 1);
        await p.db.sql.end();
      }
      resolver?.deregister();
      delete (globalThis as { __analyticsSession?: unknown }).__analyticsSession;
    } finally {
      await sql?.end();
      if (admin) {
        await admin.unsafe(`drop database if exists ${database} with (force)`);
        await admin.end();
      }
      if (work) fs.rmSync(work, { recursive: true, force: true });
    }
  });

  // ── refused ───────────────────────────────────────────────────────────────

  test("an app that doesn't exist gets the gateway's 404 from both, and nothing is recorded", async () => {
    const was = await recorded();
    assert.deepEqual(await track(UNKNOWN), NOT_FOUND);
    assert.deepEqual(await appOpen(UNKNOWN), NOT_FOUND);
    assert.deepEqual(await track(""), NOT_FOUND);
    assert.deepEqual(await recorded(), was);
  });

  test("a user without the grant is refused by both as if the app didn't exist, and nothing is recorded", async () => {
    // Only the grant is missing: the app is active and up to date.
    assert.equal(await p.access.hasAppGrant(userId, UNGRANTED), false);
    assert.deepEqual(await quietly(() => p.gate.checkAppGate(UNGRANTED)), { open: true });

    const was = await recorded();
    assert.deepEqual(await track(UNGRANTED), NOT_FOUND);
    // An event the app doesn't declare gets the same answer, so the event
    // check can't tell an app the user doesn't hold from one that isn't there.
    assert.deepEqual(await track(UNGRANTED, { event: "not-declared" }), NOT_FOUND);
    assert.deepEqual(await appOpen(UNGRANTED), NOT_FOUND);
    assert.deepEqual(await recorded(), was);
  });

  test("a switched-off app is refused by both as if it didn't exist, and nothing is recorded", async () => {
    assert.deepEqual(await quietly(() => p.gate.checkAppGate(INACTIVE)), {
      open: false,
      reason: "inactive",
    });

    const was = await recorded();
    assert.deepEqual(await track(INACTIVE), NOT_FOUND);
    assert.deepEqual(await appOpen(INACTIVE), NOT_FOUND);
    assert.deepEqual(await recorded(), was);
  });

  test("an app being updated is refused by both as if it didn't exist, and nothing is recorded", async () => {
    // Held, so what refuses it is the gate.
    assert.equal(await p.access.hasAppGrant(userId, UPDATING), true);
    assert.deepEqual(await quietly(() => p.gate.checkAppGate(UPDATING)), {
      open: false,
      reason: "updating",
    });

    const was = await recorded();
    assert.deepEqual(await track(UPDATING), NOT_FOUND);
    assert.deepEqual(await appOpen(UPDATING), NOT_FOUND);
    assert.deepEqual(await recorded(), was);
  });

  test("signed out is a 401 from both, and nothing is recorded", async () => {
    const g = globalThis as { __analyticsSession?: unknown };
    const session = g.__analyticsSession;
    delete g.__analyticsSession;
    try {
      const was = await recorded();
      assert.equal((await track(HELD)).status, 401);
      assert.equal((await appOpen(HELD)).status, 401);
      assert.deepEqual(await recorded(), was);
    } finally {
      g.__analyticsSession = session;
    }
  });

  // ── recorded ──────────────────────────────────────────────────────────────

  test("an app the user holds, while it runs, is recorded by both, a global app included", async () => {
    for (const slug of [HELD, GLOBAL]) {
      assert.deepEqual(await track(slug, { properties: { n: 1 } }), { status: 204, body: "" }, slug);
      assert.deepEqual(await appOpen(slug), { status: 204, body: "" }, slug);

      const events = await sql`
        select source_type, source_slug, event_name, user_id, properties
        from public.telemetry_events where source_slug = ${slug}
      `;
      assert.deepEqual(
        events.map((r) => ({ ...r })),
        [{ source_type: "app", source_slug: slug, event_name: EVENT, user_id: userId, properties: { n: 1 } }],
        slug,
      );
      const opens = await sql`
        select user_id, app_slug from public.app_open_events where app_slug = ${slug}
      `;
      assert.deepEqual(opens.map((r) => ({ ...r })), [{ user_id: userId, app_slug: slug }], slug);
    }
  });

  test("the limits are as they were: an undeclared event is a 400, and an oversize bag is dropped", async () => {
    const was = await recorded();
    assert.deepEqual(await track(HELD, { event: "not-declared" }), {
      status: 400,
      body: JSON.stringify({ error: "Undeclared event" }),
    });
    assert.deepEqual(await recorded(), was);

    const big = { blob: "x".repeat(5000) };
    assert.equal((await track(HELD, { properties: big })).status, 204);
    const [row] = await sql`
      select properties from public.telemetry_events
      where source_slug = ${HELD} order by created_at desc limit 1
    `;
    assert.deepEqual(row.properties, {});
  });
});
