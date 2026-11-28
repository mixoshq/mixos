/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Approving capabilities, not just apps, against a real Postgres:
 *
 *   - the release step records a local app's set the first time, silently;
 *   - growth flags it; a Registry app is also switched off, a local one stays
 *     on; shrinking and reordering are no change;
 *   - approving, or activating, clears it, audited;
 *   - each capability an admin turns off is absent at runtime, and unreadable
 *     denials turn all of them off;
 *   - unused write access expires at 90 days, and not before, or while used.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database on:
 *
 *   docker run -d --name caps -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test src/lib/apps/capability-approvals.integration.test.ts
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import postgres, { type Sql } from "postgres";
import { migratePlatform } from "../../../scripts/platform-migrations";
import type { AppManifest } from "@/lib/apps/types";
import type { ConnectorManifest } from "@/lib/connectors/types";
import type { RegistryInstall } from "@/lib/repository/install-record";

const REPO = path.resolve(__dirname, "../../..");
const serverUrl = process.env.MIXOS_TEST_DATABASE_URL;
const skip = serverUrl ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres";

const run = randomBytes(3).toString("hex");
const database = `mixos_caps_${run}`;
const KEYED = "_template";
const LOCAL = `local-${run}`;
const THIRD = `third-${run}`;
const PROVIDER = `prov-${run}`;
const DAY = 86_400_000;

async function loadPlatform() {
  return {
    ...(await import("@/generated/connector-registry")),
    ...(await import("@/generated/connector-loaders")),
    ...(await import("@/generated/app-registry")),
    ...(await import("@/lib/connectors/config")),
    ...(await import("@/lib/connectors/switch-keys")),
    ...(await import("./capability-approvals")),
    ...(await import("./capabilities")),
    ...(await import("./context")),
    ...(await import("./services")),
    ...(await import("../../../scripts/sync-capabilities")),
    platformSql: (await import("@/lib/db/client")).sql,
  };
}

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, { log, warn, error });
  }
}

describe("capability approvals", { skip }, () => {
  let admin: Sql;
  let sql: Sql;
  let p: Awaited<ReturnType<typeof loadPlatform>>;
  let actor: { id: string; email: string };
  const third: RegistryInstall = {
    kind: "app",
    slug: THIRD,
    version: "1.0.0",
    gitTag: null,
    commitSha: "c".repeat(40),
    source: "https://mixos.org",
    repository: { owner: "acme", name: "third", subpath: null },
    requiresMixOS: null,
    modified: false,
  };

  const manifest = (slug: string) => p.appRegistry.find((a) => a.slug === slug)!;
  const release = () => quietly(() => p.syncCapabilities(sql, [manifest(LOCAL), manifest(THIRD)], [third]));
  const row = async (slug: string) =>
    (await sql`select is_active, capabilities_pending_since from public.apps where slug = ${slug}`)[0];
  const audited = async (action: string) =>
    (await sql`select target_id, details from public.admin_audit_log where action = ${action} order by created_at`).map(
      (r) => ({ target: r.target_id as string, details: r.details as Record<string, unknown> }),
    );

  before(async () => {
    admin = postgres(serverUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${database}`);
    const u = new URL(serverUrl!);
    u.pathname = `/${database}`;
    sql = postgres(u.toString(), { max: 1, onnotice: () => {} });
    await quietly(() => migratePlatform(sql, path.join(REPO, "supabase", "migrations")));
    process.env.DATABASE_URL = u.toString();
    process.env.PGSSLMODE = u.searchParams.get("sslmode") ?? "disable";
    process.env.CONNECTOR_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    p = await loadPlatform();

    p.connectorRegistry.push({
      ...(JSON.parse(fs.readFileSync(path.join(REPO, "connectors", KEYED, "connector.json"), "utf8")) as ConnectorManifest),
      name: KEYED,
    });
    p.connectorLoaders[`${KEYED}/index`] = () => import("@connectors/_template/index");
    const base = p.appRegistry[0];
    assert.ok(base);
    const app = (slug: string, extra: Partial<AppManifest>): AppManifest =>
      ({
        ...base,
        slug,
        name: slug,
        global: false,
        connectors: [],
        optionalConnectors: [],
        connectorRequirements: [],
        env: [],
        egress: [],
        database: false,
        notifications: false,
        consumes: [],
        provides: [],
        listensTo: [],
        mcp: [],
        search: [],
        schedules: [],
        routes: [],
        branding: null,
        ...extra,
      }) as AppManifest;
    p.appRegistry.push(
      app(LOCAL, {
        egress: ["api.example.com", "denied.example.com"],
        optionalConnectors: [KEYED],
        connectorRequirements: [{ name: KEYED, optional: true, access: "write", version: "1.0.0" }],
        notifications: true,
        consumes: [{ app: PROVIDER, service: "svc" }],
      }),
      app(THIRD, { egress: ["api.example.com"] }),
      app(PROVIDER, { provides: [{ name: "svc", consumers: "*", audience: "app" } as never] }),
    );
    for (const slug of [LOCAL, THIRD, PROVIDER]) {
      await sql`insert into public.apps (slug, name, is_active) values (${slug}, ${slug}, true)`;
    }
    const [user] = await sql`
      insert into public.users (email, display_name, is_admin) values (${`admin-${run}@mixos.test`}, 'Admin', true)
      returning id, email
    `;
    actor = { id: user.id, email: user.email };
    await p.saveConnectorConfig(KEYED, { apiKey: "k" }, actor.id);
  });

  after(async () => {
    await p?.platformSql.end();
    await sql?.end();
    if (admin) {
      await admin.unsafe(`drop database if exists ${database} with (force)`);
      await admin.end();
    }
  });

  test("the first release records a local app's set silently; a Registry app on with none is switched off", async () => {
    const result = await release();
    assert.deepEqual(result.baselined, [LOCAL]);
    assert.equal((await row(LOCAL)).is_active, true);
    assert.equal((await row(LOCAL)).capabilities_pending_since, null);
    // On with nothing approved: no grandfathering, so it waits for an admin.
    assert.deepEqual(result.grew.map((g) => [g.slug, g.deactivated]), [[THIRD, true]]);
    assert.equal((await row(THIRD)).is_active, false);
  });

  test("growth flags a local app and leaves it on; shrinking and reordering are no change", async () => {
    manifest(LOCAL).egress.push("new.example.com");
    let result = await release();
    assert.deepEqual(result.grew, [{ slug: LOCAL, added: ["egress:new.example.com"], deactivated: false }]);
    const r = await row(LOCAL);
    assert.equal(r.is_active, true);
    assert.ok(r.capabilities_pending_since instanceof Date);
    assert.deepEqual(
      (await audited("app.capabilities.grew")).filter((a) => a.target === LOCAL).at(-1)?.details,
      { added: ["egress:new.example.com"], deactivated: false },
    );

    // Taken out again: back within its approvals, so the flag goes.
    manifest(LOCAL).egress.pop();
    manifest(LOCAL).egress.reverse();
    result = await release();
    assert.deepEqual(result.grew.filter((g) => g.slug === LOCAL), []);
    assert.equal((await row(LOCAL)).capabilities_pending_since, null);
    manifest(LOCAL).egress.reverse();
  });

  test("approving what it newly asks for clears the flag, audited", async () => {
    manifest(LOCAL).egress.push("new.example.com");
    await release();
    const added = await p.approveCapabilities(actor, LOCAL);
    assert.deepEqual(added.map(p.capabilityKey), ["egress:new.example.com"]);
    assert.equal((await row(LOCAL)).capabilities_pending_since, null);
    assert.equal((await release()).grew.filter((g) => g.slug === LOCAL).length, 0);
    const [approve] = await audited("app.capabilities.approve");
    assert.deepEqual(approve.details, { added: ["egress:new.example.com"] });
    manifest(LOCAL).egress.pop();
    await release();
  });

  test("what an admin turns off is absent at runtime", async () => {
    await p.setCapabilityDenied(actor, LOCAL, "egress", "denied.example.com", true);
    await p.setCapabilityDenied(actor, LOCAL, "optional-connector", KEYED, true);
    await p.setCapabilityDenied(actor, LOCAL, "notifications", "", true);
    await p.setCapabilityDenied(actor, LOCAL, "consumes", `${PROVIDER}/svc`, true);
    const ctx = await quietly(() => p.buildSystemAppContext(LOCAL));
    await assert.rejects(ctx.http!.fetch("https://denied.example.com/"), /not allowed to reach denied\.example\.com/);
    assert.equal(ctx.connectors[KEYED], undefined);
    assert.equal(ctx.notifications, null);
    await assert.rejects(
      ctx.services!.request(PROVIDER, "svc"),
      (err: { code?: string }) => err.code === "NOT_ALLOWED",
    );
    // Back on, one at a time.
    await p.setCapabilityDenied(actor, LOCAL, "optional-connector", KEYED, false);
    assert.ok((await quietly(() => p.buildSystemAppContext(LOCAL))).connectors[KEYED]);
    assert.deepEqual((await audited("app.capability.deny")).length, 4);
    assert.deepEqual((await audited("app.capability.allow")).length, 1);

    // Only what it runs without, and only what it asks for.
    await assert.rejects(p.setCapabilityDenied(actor, LOCAL, "database", "", true), p.CapabilityError);
    await assert.rejects(p.setCapabilityDenied(actor, LOCAL, "egress", "other.example.com", true), p.CapabilityError);
  });

  test("denials that can't be read turn everything that can be turned off off", async () => {
    await sql`delete from public.app_capability_denials`;
    await sql`alter table public.app_capability_denials rename to app_capability_denials_away`;
    try {
      const ctx = await quietly(() => p.buildSystemAppContext(LOCAL));
      await assert.rejects(ctx.http!.fetch("https://api.example.com/"), /not allowed to reach/);
      assert.equal(ctx.connectors[KEYED], undefined);
      assert.equal(ctx.notifications, null);
    } finally {
      await sql`alter table public.app_capability_denials_away rename to app_capability_denials`;
    }
  });

  test("unused write access expires at 90 days, and not before, or while it is used", async () => {
    await sql`insert into public.platform_settings (key, value) values (${p.connectorWritableKey(KEYED)}, now()::text)`;
    const approvedAgo = async (days: number) =>
      sql`update public.app_capability_approvals set approved_at = now() - ${days} * interval '1 day'
          where app_slug = ${LOCAL} and kind = 'connector-write'`;

    await approvedAgo(30);
    assert.deepEqual(await p.expireUnusedWrites(), []);

    await approvedAgo(91);
    await sql`
      insert into public.telemetry_events (source_type, source_slug, caller_app_slug, event_name, outcome, created_at)
      values ('connector', ${KEYED}, ${LOCAL}, 'createItem', 'ok', now() - interval '10 days')
    `;
    assert.deepEqual(await p.expireUnusedWrites(), [], "a write ten days ago keeps it");

    await sql`delete from public.telemetry_events`;
    assert.deepEqual(await p.expireUnusedWrites(new Date(Date.now() + DAY)), [{ app: LOCAL, connector: KEYED }]);
    const [limit] = await sql`select writes, expired_at from public.connector_app_access where app_slug = ${LOCAL}`;
    assert.equal(limit.writes, "deny");
    assert.ok(limit.expired_at instanceof Date);
    const [expired] = await audited("app.capability.expired");
    assert.deepEqual(expired.details, { connector: KEYED, unusedDays: 90 });
    assert.deepEqual((await p.getExpiredWrites()).map((e) => [e.app, e.connector]), [[LOCAL, KEYED]]);
    // Expired once is enough.
    assert.deepEqual(await p.expireUnusedWrites(new Date(Date.now() + DAY)), []);
  });
});
