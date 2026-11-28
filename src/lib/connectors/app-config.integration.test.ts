/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An app's own credentials for a tenant connector, against a real Postgres:
 *
 *   - they win over the shared ones, for that app only, in its real context;
 *   - one that can't be read leaves the app unconfigured, never on the shared
 *     credential, and so does a table that can't be read;
 *   - the activation gate checks them, not the shared row;
 *   - Connect for an app carries its slug in the sealed cookie, uses its own
 *     client, asks for the write scopes only if the app may write, and stores
 *     the grant and its scopes on the app's row alone;
 *   - renewing an app's token never touches the shared row, or the reverse,
 *     and eight concurrent requests renew it once;
 *   - Verify, save and remove are audited with the app;
 *   - a rename of the app or the connector carries them.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database on. The database's name ends in this run's own suffix, and
 * it is dropped when the run finishes:
 *
 *   docker run -d --name own -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test src/lib/connectors/app-config.integration.test.ts
 *
 * The connectors are the two templates under connectors/, registered for this
 * run only, and the apps exist only in this process's registry. The provider
 * is a stubbed fetch, so nothing leaves the machine.
 */

import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import postgres, { type Sql } from "postgres";
import { migratePlatform } from "../../../scripts/platform-migrations";
import type { AppManifest } from "@/lib/apps/types";
import type { BaseConnector, ConnectorManifest } from "./types";

const REPO = path.resolve(__dirname, "../../..");
const serverUrl = process.env.MIXOS_TEST_DATABASE_URL;
const skip = serverUrl ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres";

const run = randomBytes(3).toString("hex");
const database = `mixos_own_${run}`;

/** API key, in the X-Api-Key header. */
const KEYED = "_template";
/** Three-legged OAuth, with `things:write` asked for only once changes are allowed. */
const OAUTH = "_template-oauth";
const TOKEN_URL = "https://provider.example.com/oauth/token";

/** Uses the shared credentials; only reads. */
const SHARED = `shared-${run}`;
/** Gets its own; asks to change data. */
const OWN = `own-${run}`;
/** Declares neither connector. */
const STRANGER = `stranger-${run}`;

async function loadPlatform() {
  return {
    ...(await import("@/generated/connector-registry")),
    ...(await import("@/generated/connector-loaders")),
    ...(await import("@/generated/app-registry")),
    ...(await import("./app-config")),
    ...(await import("./app-config-admin")),
    ...(await import("./config")),
    ...(await import("./oauth")),
    ...(await import("./oauth-flow")),
    ...(await import("./scope-status")),
    ...(await import("./writable-admin")),
    ...(await import("@/lib/apps/context")),
    ...(await import("@/lib/apps/connector-gates")),
    ...(await import("../../../scripts/sync-renames")),
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

const manifestOf = (name: string): ConnectorManifest => ({
  ...(JSON.parse(fs.readFileSync(path.join(REPO, "connectors", name, "connector.json"), "utf8")) as ConnectorManifest),
  name,
});

type Keyed = BaseConnector & { listItems(): Promise<unknown[]> };
type Things = BaseConnector & { listThings(): Promise<unknown[]> };

// ── the provider ────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;

/** What reached the provider. */
interface Seen {
  apiKeys: string[];
  bearers: string[];
  /** Each token request: its grant type, the refresh token sent, and the client in Basic auth. */
  tokens: Array<{ grant: string | null; refresh: string | null; client: string }>;
}
let seen: Seen;
let issued = 0;

function provider() {
  seen = { apiKeys: [], bearers: [], tokens: [] };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    if (url === TOKEN_URL) {
      const body = new URLSearchParams(String(init?.body ?? ""));
      const basic = headers.get("authorization")?.replace(/^Basic /, "") ?? "";
      seen.tokens.push({
        grant: body.get("grant_type"),
        refresh: body.get("refresh_token"),
        client: Buffer.from(basic, "base64").toString().split(":")[0],
      });
      // Slow enough that concurrent requests meet at the lock.
      await new Promise((r) => setTimeout(r, 30));
      issued += 1;
      return Response.json({
        access_token: `at-${issued}`,
        refresh_token: `rt-${issued}`,
        expires_in: 3600,
        token_type: "bearer",
        scope: "things:read",
      });
    }
    const key = headers.get("x-api-key");
    if (key) seen.apiKeys.push(key);
    const bearer = headers.get("authorization");
    if (bearer?.startsWith("Bearer ")) seen.bearers.push(bearer.slice(7));
    if (url.includes("/v1/me")) return Response.json({ account_name: "acme" });
    if (url.includes("/v1/things")) return Response.json({ data: [] });
    return Response.json({ data: [{ id: "1", name: "one" }], meta: {} });
  }) as typeof fetch;
}

describe("an app's own connector credentials", { skip }, () => {
  let admin: Sql;
  let sql: Sql;
  let p: Awaited<ReturnType<typeof loadPlatform>>;
  let actor: { id: string; email: string };
  let session: { user: { id: string; email: string; name: string; isAdmin: boolean } };

  const connectorOf = async <T extends BaseConnector>(slug: string, name: string) =>
    (await quietly(() => p.buildSystemAppContext(slug))).connectors[name] as T;

  async function audited(action: string, targetId: string) {
    const rows = await sql`
      select details from public.admin_audit_log
      where action = ${action} and target_id = ${targetId}
      order by created_at
    `;
    return rows.map((r) => r.details as Record<string, unknown>);
  }

  async function sharedRow(name: string) {
    const [row] = await sql`
      select encrypted_credentials, last_verified_at from public.connector_configs where connector_name = ${name}
    `;
    return row;
  }

  /** Expire a stored access token, the shared row's or one app's. */
  async function expire(name: string, appSlug: string | null) {
    const past = { oauth_expires_at: String(Date.now() - 60_000) };
    if (appSlug) await p.mutateAppConnectorCredentials(name, appSlug, () => past);
    else await p.mutateConnectorCredentials(name, () => past);
  }

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
    process.env.USER_OAUTH_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    process.env.NEXTAUTH_URL = "https://mixos.test";
    p = await loadPlatform();

    p.connectorRegistry.push(manifestOf(KEYED), manifestOf(OAUTH));
    p.connectorLoaders[`${KEYED}/index`] = () => import("@connectors/_template/index");
    p.connectorLoaders[`${OAUTH}/index`] = () => import("@connectors/_template-oauth/index");
    const base = p.appRegistry[0];
    assert.ok(base, "the registry needs one app to copy a manifest shape from");
    const app = (slug: string, access: "read" | "write" | null): AppManifest =>
      ({
        ...base,
        slug,
        name: slug,
        connectors: access ? [KEYED, OAUTH] : [],
        optionalConnectors: [],
        connectorRequirements: access
          ? [
              { name: KEYED, optional: false, access, version: "1.0.0" },
              { name: OAUTH, optional: false, access, version: "1.0.0" },
            ]
          : [],
        env: [],
        egress: [],
        database: false,
        notifications: false,
        consumes: [],
        telemetry: [],
      }) as AppManifest;
    p.appRegistry.push(app(SHARED, "read"), app(OWN, "write"), app(STRANGER, null));
    await sql`
      insert into public.apps (slug, name, is_active)
      values (${SHARED}, ${SHARED}, true), (${OWN}, ${OWN}, true), (${STRANGER}, ${STRANGER}, true)
    `;

    const [user] = await sql`
      insert into public.users (email, display_name, is_admin)
      values (${`admin-${run}@mixos.test`}, 'Admin', true)
      returning id, email
    `;
    actor = { id: user.id, email: user.email };
    session = { user: { id: user.id, email: user.email, name: "Admin", isAdmin: true } };

    await p.saveConnectorConfig(KEYED, { apiKey: "shared-key" }, actor.id);
    await p.saveConnectorConfig(OAUTH, { clientId: "shared-cid", clientSecret: "shared-secret" }, actor.id);
    await p.saveConnectorTokens(OAUTH, {
      accessToken: "shared-at",
      refreshToken: "shared-rt",
      expiresAt: Date.now() + 3_600_000,
      scope: "things:read",
    });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  after(async () => {
    globalThis.fetch = realFetch;
    await p?.platformSql.end();
    await sql?.end();
    if (admin) {
      await admin.unsafe(`drop database if exists ${database} with (force)`);
      await admin.end();
    }
  });

  test("they win over the shared ones, for that app only, and saving is audited with the app", async () => {
    assert.equal(await p.configureAppCredentials(actor, KEYED, OWN, { apiKey: "own-key", notAField: "x" }), true);
    assert.deepEqual(await audited("connector.configure", KEYED), [{ app: OWN, fields: ["apiKey"] }]);

    provider();
    await (await connectorOf<Keyed>(OWN, KEYED)).listItems();
    await (await connectorOf<Keyed>(SHARED, KEYED)).listItems();
    assert.deepEqual(seen.apiKeys, ["own-key", "shared-key"]);

    // Its gate reads its own: set up, and stopped only because it asks to
    // change data in a connector that is read-only, as the shared one would be.
    assert.deepEqual(
      (await p.getMissingTenantConfigConnectors(OWN)).find((m) => m.name === KEYED)?.state,
      "read-only",
    );
    // An app that doesn't declare the connector can't have its own.
    assert.equal(await p.configureAppCredentials(actor, KEYED, STRANGER, { apiKey: "x" }), false);
    assert.equal((await sql`select 1 from public.connector_app_configs where app_slug = ${STRANGER}`).length, 0);
  });

  test("a row that can't be read leaves the app unconfigured, never on the shared credential", async () => {
    const [good] = await sql`
      select encrypted_credentials from public.connector_app_configs
      where connector_name = ${KEYED} and app_slug = ${OWN}
    `;
    await sql`
      update public.connector_app_configs set encrypted_credentials = 'not-decryptable'
      where connector_name = ${KEYED} and app_slug = ${OWN}
    `;
    try {
      provider();
      const keyed = await connectorOf<Keyed>(OWN, KEYED);
      assert.equal(keyed.configured, false);
      await assert.rejects(async () => keyed.listItems(), (err: { category?: string }) => err.category === "unconfigured");
      assert.deepEqual(seen.apiKeys, [], "nothing reached the provider, with any key");
      assert.deepEqual(
        (await quietly(() => p.getMissingTenantConfigConnectors(OWN))).find((m) => m.name === KEYED)?.state,
        "unconfigured",
      );
      // The app next to it is untouched.
      await (await connectorOf<Keyed>(SHARED, KEYED)).listItems();
      assert.deepEqual(seen.apiKeys, ["shared-key"]);
    } finally {
      await sql`
        update public.connector_app_configs set encrypted_credentials = ${good.encrypted_credentials}
        where connector_name = ${KEYED} and app_slug = ${OWN}
      `;
    }
  });

  test("a table that can't be read: every tenant connector unconfigured, and the gate refuses", async () => {
    await sql`alter table public.connector_app_configs rename to connector_app_configs_away`;
    try {
      provider();
      assert.equal((await connectorOf<Keyed>(SHARED, KEYED)).configured, false);
      assert.equal((await connectorOf<Keyed>(OWN, KEYED)).configured, false);
      await assert.rejects(quietly(() => p.getMissingTenantConfigConnectors(SHARED)));
      const shown = await quietly(() => p.getMissingTenantConfigConnectors(SHARED, { forDisplay: true }));
      assert.deepEqual(shown.map((m) => [m.name, m.state]).sort(), [
        [KEYED, "unconfigured"],
        [OAUTH, "unconfigured"],
      ]);
      assert.deepEqual(seen.apiKeys, []);
    } finally {
      await sql`alter table public.connector_app_configs_away rename to connector_app_configs`;
    }
  });

  test("an admin entering them again starts over a row that can't be read", async () => {
    await sql`
      update public.connector_app_configs set encrypted_credentials = 'not-decryptable'
      where connector_name = ${KEYED} and app_slug = ${OWN}
    `;
    assert.equal(await p.configureAppCredentials(actor, KEYED, OWN, { apiKey: "own-key" }), true);
    provider();
    await (await connectorOf<Keyed>(OWN, KEYED)).listItems();
    assert.deepEqual(seen.apiKeys, ["own-key"]);
  });

  test("Connect for an app: its slug sealed in the cookie, its own client, writes only if it may", async () => {
    // Saved, as the shared save answers: a client, waiting for Connect.
    assert.equal(
      await p.configureAppCredentials(actor, OAUTH, OWN, { clientId: "own-cid", clientSecret: "own-secret" }),
      true,
    );
    assert.equal((await connectorOf<Things>(OWN, OAUTH)).configured, false, "no grant yet, so not usable");
    const returnTo = `/admin/connectors?connector=${OAUTH}&app=${OWN}`;

    const start = await p.startConnectorOAuth(OAUTH, session, returnTo, OWN);
    assert.ok(start.ok);
    const url = new URL(start.authorizeUrl);
    assert.equal(url.searchParams.get("client_id"), "own-cid");
    assert.ok(!start.authorizeUrl.includes(OWN), "the slug is in no part of what goes to the provider");
    const flow = p.openFlowState(start.sealedFlow);
    assert.equal(flow?.appSlug, OWN);
    assert.equal(flow?.writes, false, "read-only: no write scopes");
    assert.doesNotMatch(url.searchParams.get("scope") ?? "", /things:write/);

    // Changes allowed, and this app asks for them: the write scopes.
    await p.setConnectorChanges(OAUTH, true, actor);
    try {
      const writing = await p.startConnectorOAuth(OAUTH, session, returnTo, OWN);
      assert.ok(writing.ok);
      assert.equal(p.openFlowState(writing.sealedFlow)?.writes, true);
      assert.match(new URL(writing.authorizeUrl).searchParams.get("scope") ?? "", /things:write/);
      // An app that only reads gets no write scopes, whatever the connector allows.
      await p.configureAppCredentials(actor, OAUTH, SHARED, { clientId: "reader-cid", clientSecret: "reader-secret" });
      const reading = await p.startConnectorOAuth(OAUTH, session, returnTo, SHARED);
      assert.ok(reading.ok);
      assert.equal(p.openFlowState(reading.sealedFlow)?.writes, false);
      await p.removeAppCredentials(actor, OAUTH, SHARED);
    } finally {
      await p.setConnectorChanges(OAUTH, false, actor);
    }

    // An app that doesn't declare it can't start one.
    assert.deepEqual(await p.startConnectorOAuth(OAUTH, session, returnTo, STRANGER), {
      ok: false,
      outcome: "unsupported",
    });

    // The callback: the grant and its scopes on the app's row, and nowhere else.
    const sharedBefore = await sharedRow(OAUTH);
    provider();
    const params = new URLSearchParams({ code: "the-code", state: flow!.state });
    const done = await p.finishConnectorOAuth({ name: OAUTH, session, flow, params });
    assert.equal(done.outcome, "connected");
    assert.deepEqual(seen.tokens, [{ grant: "authorization_code", refresh: null, client: "own-cid" }]);
    const own = await p.getDecryptedAppConfig(OAUTH, OWN);
    assert.equal(own?.oauth_access_token, `at-${issued}`);
    assert.equal(own?.clientId, "own-cid");
    assert.equal((await sharedRow(OAUTH)).encrypted_credentials, sharedBefore.encrypted_credentials);

    assert.deepEqual(
      (await p.getScopeStatus(OAUTH, null, OWN)).map((r) => [r.scope, r.status]),
      [
        ["things:read", "granted"],
        ["things:write", "unknown"],
      ],
    );
    assert.deepEqual(await p.getScopeStatus(OAUTH), [], "the shared grant's record holds no app's rows");
    assert.deepEqual(await audited("connector.connect", OAUTH), [
      { scopes: ["things:read"], writes: false, app: OWN },
    ]);
  });

  test("renewing an app's token never touches the shared row, nor the reverse; eight at once renew once", async () => {
    await expire(OAUTH, OWN);
    const sharedBefore = await sharedRow(OAUTH);
    provider();
    await (await connectorOf<Things>(OWN, OAUTH)).listThings();
    assert.equal(seen.tokens.length, 1);
    assert.equal(seen.tokens[0].client, "own-cid");
    assert.match(seen.tokens[0].refresh ?? "", /^rt-/);
    assert.equal(seen.bearers.at(-1), `at-${issued}`);
    assert.equal((await sharedRow(OAUTH)).encrypted_credentials, sharedBefore.encrypted_credentials);

    const ownBefore = await p.getDecryptedAppConfig(OAUTH, OWN);
    await expire(OAUTH, null);
    provider();
    await (await connectorOf<Things>(SHARED, OAUTH)).listThings();
    assert.deepEqual(seen.tokens, [{ grant: "refresh_token", refresh: "shared-rt", client: "shared-cid" }]);
    assert.deepEqual(await p.getDecryptedAppConfig(OAUTH, OWN), ownBefore);

    await expire(OAUTH, OWN);
    provider();
    const eight = await Promise.all(Array.from({ length: 8 }, () => connectorOf<Things>(OWN, OAUTH)));
    await Promise.all(eight.map((c) => c.listThings()));
    assert.equal(seen.tokens.length, 1, "one renewal for eight requests");
  });

  test("Verify with an app's own credentials is recorded on its row, and audited with the app", async () => {
    provider();
    const outcome = await p.testAppCredentials(actor, OAUTH, OWN);
    assert.equal(outcome.ok, true);
    assert.deepEqual((await audited("connector.test", OAUTH)).at(-1), { ok: true, app: OWN });
    const [row] = await sql`
      select last_verified_at from public.connector_app_configs where connector_name = ${OAUTH} and app_slug = ${OWN}
    `;
    assert.ok(row.last_verified_at);
    assert.equal((await sharedRow(OAUTH)).last_verified_at, null);

    // An app with none fails, rather than testing the shared credentials.
    const none = await p.testAppCredentials(actor, KEYED, SHARED);
    assert.equal(none.ok, false);
    assert.ok(!none.ok && /no .* credentials of its own/.test(none.message));
  });

  test("a rename carries them, the app's and the connector's", async () => {
    const MOVED = `moved-${run}`;
    p.appRegistry.push({ ...p.appRegistry.find((a) => a.slug === OWN)!, slug: MOVED });
    const results = await quietly(() =>
      p.syncRenames(sql, [{ kind: "app", from: OWN, to: MOVED, date: "2026-11-28" }]),
    );
    assert.equal(results[0].outcome, "moved");
    const rows = async (slug: string) =>
      (await sql`select connector_name from public.connector_app_configs where app_slug = ${slug} order by 1`).map(
        (r) => r.connector_name,
      );
    assert.deepEqual(await rows(MOVED), [KEYED, OAUTH].sort());
    assert.deepEqual(await rows(OWN), []);
    const scopes = await sql`select count(*)::int as n from public.connector_scope_status where app_slug = ${MOVED}`;
    assert.equal(scopes[0].n, 2);

    const RENAMED = `renamed-${run}`;
    await quietly(() => p.syncRenames(sql, [{ kind: "connector", from: KEYED, to: RENAMED, date: "2026-11-28" }]));
    const moved = await sql`select app_slug from public.connector_app_configs where connector_name = ${RENAMED}`;
    assert.deepEqual(moved.map((r) => r.app_slug), [MOVED]);
    await quietly(() => p.syncRenames(sql, [{ kind: "connector", from: RENAMED, to: KEYED, date: "2026-11-28" }]));
    await quietly(() => p.syncRenames(sql, [{ kind: "app", from: MOVED, to: OWN, date: "2026-11-28" }]));
  });

  test("taking them away: the app uses the shared ones from its next request, audited, with its scopes gone", async () => {
    assert.equal(await p.removeAppCredentials(actor, KEYED, OWN), true);
    assert.equal(await p.removeAppCredentials(actor, OAUTH, OWN), true);
    assert.equal(await p.removeAppCredentials(actor, OAUTH, OWN), false, "nothing left to take");
    assert.deepEqual((await audited("connector.configure", KEYED)).at(-1), { app: OWN, removed: true });
    assert.equal(
      (await sql`select count(*)::int as n from public.connector_scope_status where app_slug = ${OWN}`)[0].n,
      0,
    );
    provider();
    await (await connectorOf<Keyed>(OWN, KEYED)).listItems();
    assert.deepEqual(seen.apiKeys, ["shared-key"]);
  });
});
