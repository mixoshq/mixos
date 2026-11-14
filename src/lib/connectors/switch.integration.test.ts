/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The connector switch against a real Postgres: where it is stored, every
 * place it is enforced, what Disable and Enable record, and that neither
 * touches the credentials.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database on. The database's name ends in this run's own suffix, and
 * it is dropped when the run finishes:
 *
 *   docker run -d --name switch -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test src/lib/connectors/switch.integration.test.ts
 *
 * The connectors are the two templates under connectors/, registered for this
 * run only, and the app declaring them exists only in this process's registry.
 * Upstream calls go to a stubbed fetch, so nothing leaves the machine.
 */

import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
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
const database = `mixos_switch_${run}`;

/** API key; required by the app below. */
const KEYED = "_template";
/** Three-legged OAuth with a webhook; optional for the app below. */
const OAUTH = "_template-oauth";
const APP = `switch-${run}`;
const APP_NAME = "Switch Test";

/** Everything the tests reach, loaded once the environment points at the test database. */
async function loadPlatform() {
  return {
    ...(await import("@/generated/connector-registry")),
    ...(await import("@/generated/app-registry")),
    ...(await import("./switch")),
    ...(await import("./switch-admin")),
    ...(await import("./config")),
    ...(await import("./oauth")),
    ...(await import("./oauth-flow")),
    ...(await import("./test-connection")),
    ...(await import("@/lib/apps/context")),
    ...(await import("@/lib/apps/read-only")),
    webhook: (await import("@/app/api/webhooks/[name]/route")).POST,
    platformSql: (await import("@/lib/db/client")).sql,
  };
}

/** Silence the logs a refusal writes on purpose, for the length of `fn`. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, { log, warn, error });
  }
}

/** Its registry entry, named after its folder as the generator names it. */
const manifestOf = (name: string): ConnectorManifest => ({
  ...(JSON.parse(fs.readFileSync(path.join(REPO, "connectors", name, "connector.json"), "utf8")) as ConnectorManifest),
  name,
});

/** The connector methods the tests call, as an app would cast them. */
type Keyed = BaseConnector & {
  listItems(): Promise<{ id: string; name: string }[]>;
  createItem(data: Record<string, unknown>): Promise<unknown>;
};

// ── the upstream ────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
/** Every upstream request made, as "METHOD url". */
let sent: string[] = [];

/** Answer each URL starting with a key with that key's JSON. */
function upstream(routes: Record<string, unknown>) {
  sent = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    sent.push(`${init?.method ?? "GET"} ${url}`);
    const match = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    return match
      ? Response.json(routes[match])
      : Response.json({ error: "not stubbed" }, { status: 404 });
  }) as typeof fetch;
}

const ITEMS = "https://api.example.com/items";
const ME = "https://api.example.com/me";
const TOKEN = "https://provider.example.com/oauth/token";

describe("the connector switch", { skip }, () => {
  let admin: Sql;
  let sql: Sql;
  let p: Awaited<ReturnType<typeof loadPlatform>>;
  let actor: { id: string; email: string };
  let session: { user: { id: string; email: string; name: string; isAdmin: boolean } };
  let dbUser: { id: string; email: string; display_name: string; is_admin: boolean };

  /** Turn a connector off or on without an audit row, to set up a case. */
  const setOff = (name: string, off: boolean) => p.setConnectorDisabled(name, off);

  async function credentialsRow(name: string) {
    const [row] = await sql`
      select encrypted_credentials, configured_by, configured_at, updated_at, last_verified_at
      from public.connector_configs where connector_name = ${name}
    `;
    return row ? { ...row } : undefined;
  }

  async function audited(action: string, targetId: string) {
    const rows = await sql`
      select actor_id, actor_email, target_type, target_id, details
      from public.admin_audit_log
      where action = ${action} and target_id = ${targetId}
      order by created_at
    `;
    return rows.map((r) => ({ ...r }));
  }

  before(async () => {
    admin = postgres(serverUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${database}`);
    const u = new URL(serverUrl!);
    u.pathname = `/${database}`;
    sql = postgres(u.toString(), { max: 1, onnotice: () => {} });
    await quietly(() => migratePlatform(sql, path.join(REPO, "supabase", "migrations")));

    // The platform's own pool reads these on its first query.
    process.env.DATABASE_URL = u.toString();
    process.env.PGSSLMODE = u.searchParams.get("sslmode") ?? "disable";
    process.env.CONNECTOR_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    process.env.NEXTAUTH_URL = "https://mixos.test";
    p = await loadPlatform();

    p.connectorRegistry.push(manifestOf(KEYED), manifestOf(OAUTH));
    const base = p.appRegistry[0];
    assert.ok(base, "the registry needs one app to copy a manifest shape from");
    p.appRegistry.push({
      ...base,
      slug: APP,
      name: APP_NAME,
      connectors: [KEYED],
      optionalConnectors: [OAUTH],
      connectorRequirements: [
        { name: KEYED, optional: false, access: "read", version: "1.0.0" },
        { name: OAUTH, optional: true, access: "read", version: "1.0.0" },
      ],
      env: [],
      egress: [],
      database: false,
      notifications: false,
      consumes: [],
      telemetry: [],
    } as AppManifest);

    const [user] = await sql`
      insert into public.users (email, display_name, is_admin)
      values (${`admin-${run}@mixos.test`}, 'Admin', true)
      returning id, email, display_name, is_admin
    `;
    actor = { id: user.id, email: user.email };
    session = { user: { id: user.id, email: user.email, name: "Admin", isAdmin: true } };
    dbUser = { id: user.id, email: user.email, display_name: "Admin", is_admin: true };

    await p.saveConnectorConfig(KEYED, { apiKey: "key-1" }, actor.id);
    await p.saveConnectorConfig(
      OAUTH,
      { clientId: "cid", clientSecret: "sec", webhookSecret: "whsec" },
      actor.id,
    );
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  after(async () => {
    await p?.platformSql.end();
    await sql?.end();
    if (admin) {
      await admin.unsafe(`drop database if exists ${database} with (force)`);
      await admin.end();
    }
  });

  // ── where it is stored ────────────────────────────────────────────────────

  test("off is a platform_settings row holding when, and on is no row", async () => {
    const key = p.connectorSwitchKey(KEYED);
    const row = async () => (await sql`select value from public.platform_settings where key = ${key}`)[0];

    assert.equal(await p.isConnectorDisabled(KEYED), false);
    assert.equal(await row(), undefined);

    const before = Date.now();
    await setOff(KEYED, true);
    const first = (await row())?.value as string;
    assert.ok(Date.parse(first) >= before - 1000 && Date.parse(first) <= Date.now() + 1000, first);
    assert.equal(await p.isConnectorDisabled(KEYED), true);
    assert.deepEqual([...(await p.getDisabledConnectors([KEYED, OAUTH])).keys()], [KEYED]);

    // Off again keeps the time it first went off.
    await setOff(KEYED, true);
    assert.equal((await row())?.value, first);

    await setOff(KEYED, false);
    assert.equal(await row(), undefined);
    assert.equal(await p.isConnectorDisabled(KEYED), false);
  });

  // ── loadTenantConnectors ──────────────────────────────────────────────────

  test("the app context builds an enabled connector and hands apps a refusal for a disabled one", async () => {
    upstream({ [ITEMS]: { data: [{ id: "1", name: "one" }], meta: {} } });

    const on = await p.buildSystemAppContext(APP);
    const keyed = on.connectors[KEYED] as Keyed;
    assert.equal(p.isDisabledConnector(keyed), false);
    assert.equal(keyed.configured, true);
    assert.deepEqual(await keyed.listItems(), [{ id: "1", name: "one" }]);
    assert.equal(sent.length, 1);

    await setOff(KEYED, true);
    try {
      sent = [];
      // Every surface builds its connectors through the same loader.
      for (const ctx of [
        await p.buildSystemAppContext(APP),
        await p.buildPublicAppContext(APP),
        await p.buildAppContext(APP, dbUser),
      ]) {
        const off = ctx.connectors[KEYED] as Keyed;
        assert.equal(p.isDisabledConnector(off), true);
        assert.equal(off.configured, false);
        await assert.rejects(off.listItems(), (err: unknown) => {
          assert.ok(err instanceof p.ConnectorDisabledError);
          assert.equal(err.userMessage, "Template Connector has been disabled by an administrator.");
          return true;
        });
        // The connector beside it is untouched: still the real one.
        assert.equal(p.isDisabledConnector(ctx.connectors[OAUTH]), false);
      }
      assert.deepEqual(sent, [], "a disabled connector reached its upstream");
    } finally {
      await setOff(KEYED, false);
    }
  });

  test("when the switch cannot be read, no connector is loaded", async () => {
    await sql`alter table public.platform_settings rename to platform_settings_away`;
    try {
      const ctx = await quietly(() => p.buildSystemAppContext(APP));
      assert.deepEqual(Object.keys(ctx.connectors), []);
    } finally {
      await sql`alter table public.platform_settings_away rename to platform_settings`;
    }
  });

  // ── the MCP read-only wrapper ─────────────────────────────────────────────

  test("an MCP tool's connectors refuse a disabled connector and serve an enabled one", async () => {
    upstream({ [ITEMS]: { data: [{ id: "1", name: "one" }], meta: {} } });
    // As the MCP broker builds a tool's connectors: the app's own context,
    // then narrowed to declared reads.
    const toolConnectors = async () =>
      p.readOnlyConnectors((await p.buildAppContext(APP, dbUser)).connectors, p.connectorRegistry);

    const on = (await toolConnectors())[KEYED] as Keyed;
    assert.deepEqual(await on.listItems(), [{ id: "1", name: "one" }]);
    assert.throws(() => on.createItem({}), p.ReadOnlyError);

    await setOff(KEYED, true);
    try {
      sent = [];
      const off = (await toolConnectors())[KEYED] as Keyed;
      for (const call of [() => off.listItems(), () => off.createItem({})]) {
        const err = await call().then(
          () => assert.fail("a disabled connector answered"),
          (e: unknown) => e,
        );
        assert.ok(err instanceof p.ConnectorDisabledError, String(err));
        // What the broker hands the model in place of a generic failure.
        assert.equal(
          p.refusalMessage(err),
          "Template Connector has been disabled by an administrator.",
        );
      }
      assert.deepEqual(sent, []);
    } finally {
      await setOff(KEYED, false);
    }
  });

  // ── the webhook route ─────────────────────────────────────────────────────

  test("a webhook for a disabled connector is refused as one with no secret is, and served when enabled", async () => {
    let n = 0;
    /** A fresh delivery, signed with `secret` as the template's policy says. */
    const delivery = (secret: string) => {
      const body = JSON.stringify({ type: "thing.created", data: { n: ++n } });
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
      return new Request(`https://mixos.test/api/webhooks/${OAUTH}`, {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "X-Provider-Timestamp": ts,
          "X-Provider-Signature": sig,
        },
      });
    };
    const post = (req: Request) =>
      quietly(() => p.webhook(req, { params: Promise.resolve({ name: OAUTH }) }));
    const claimed = async () =>
      (await sql`select count(*)::int as n from public.connector_webhook_events where connector_name = ${OAUTH}`)[0].n;

    await sql`delete from public.connector_configs where connector_name = ${OAUTH}`;
    const unconfigured = await post(delivery("whsec"));
    assert.equal(unconfigured.status, 401);

    await p.saveConnectorConfig(OAUTH, { clientId: "cid", clientSecret: "sec", webhookSecret: "whsec" }, actor.id);
    await setOff(OAUTH, true);
    try {
      const refused = await post(delivery("whsec"));
      assert.equal(refused.status, unconfigured.status);
      assert.equal(await refused.text(), "");
      assert.equal(await claimed(), 0, "a refused delivery was marked as seen");
    } finally {
      await setOff(OAUTH, false);
    }

    const served = await post(delivery("whsec"));
    assert.equal(served.status, 200);
    assert.deepEqual(await served.json(), { ok: true });
    assert.equal(await claimed(), 1);
  });

  // ── OAuth start and callback ──────────────────────────────────────────────

  test("OAuth start refuses a disabled connector and starts for an enabled one", async () => {
    await p.saveConnectorConfig(OAUTH, { clientId: "cid", clientSecret: "sec" }, actor.id);
    const returnTo = `/admin/connectors?connector=${OAUTH}`;

    const on = await p.startConnectorOAuth(OAUTH, session, returnTo);
    assert.equal(on.ok, true);
    if (!on.ok) return;
    const url = new URL(on.authorizeUrl);
    assert.equal(url.origin + url.pathname, "https://provider.example.com/oauth/authorize");
    assert.equal(url.searchParams.get("client_id"), "cid");
    assert.equal(p.openFlowState(on.sealedFlow)?.connector, OAUTH);

    await setOff(OAUTH, true);
    try {
      assert.deepEqual(await p.startConnectorOAuth(OAUTH, session, returnTo), {
        ok: false,
        outcome: "disabled",
      });
    } finally {
      await setOff(OAUTH, false);
    }
  });

  test("the OAuth callback stores no grant for a disabled connector, and stores it once enabled", async () => {
    await p.saveConnectorConfig(OAUTH, { clientId: "cid", clientSecret: "sec" }, actor.id);
    upstream({
      [TOKEN]: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: "things:read" },
    });
    const flow = p.newFlowState(OAUTH, "/admin/connectors", null);
    const finish = () =>
      quietly(() =>
        p.finishConnectorOAuth({
          name: OAUTH,
          session,
          flow,
          params: new URLSearchParams({ code: "code-1", state: flow.state }),
        }),
      );

    await setOff(OAUTH, true);
    try {
      assert.deepEqual(await finish(), { outcome: "disabled", revalidate: null });
      assert.deepEqual(sent, [], "the code was exchanged for a disabled connector");
      assert.equal((await p.getDecryptedConfig(OAUTH))?.[p.TOKEN_KEYS.access], undefined);
    } finally {
      await setOff(OAUTH, false);
    }

    assert.deepEqual(await finish(), { outcome: "connected", revalidate: "/admin/connectors" });
    assert.deepEqual(sent, [`POST ${TOKEN}`]);
    const stored = await p.getDecryptedConfig(OAUTH);
    assert.equal(stored?.[p.TOKEN_KEYS.access], "at-1");
    assert.equal(stored?.clientId, "cid");
  });

  // ── Test Connection ───────────────────────────────────────────────────────

  test("Test Connection refuses a disabled connector and tests an enabled one", async () => {
    upstream({ [ME]: { name: "Acme" } });

    assert.deepEqual(await p.runConnectorTest(KEYED, { userId: actor.id }), {
      ok: true,
      detail: "Authenticated as Acme",
    });
    assert.deepEqual(sent, [`GET ${ME}`]);

    await setOff(KEYED, true);
    try {
      sent = [];
      assert.deepEqual(await p.runConnectorTest(KEYED, { userId: actor.id }), {
        ok: false,
        category: "disabled",
        message: "Template Connector is disabled. Enable it to test the connection.",
        adminHint: null,
        upstreamRequestId: null,
      });
      assert.deepEqual(sent, []);
    } finally {
      await setOff(KEYED, false);
    }
  });

  // ── Disable and Enable ────────────────────────────────────────────────────

  test("Disable and Enable are audited, naming the apps that use the connector", async () => {
    await p.setConnectorEnabled(KEYED, false, actor);
    assert.equal(await p.isConnectorDisabled(KEYED), true);
    await p.setConnectorEnabled(KEYED, true, actor);
    assert.equal(await p.isConnectorDisabled(KEYED), false);

    const row = {
      actor_id: actor.id,
      actor_email: actor.email,
      target_type: "connector",
      target_id: KEYED,
      details: { requiredBy: [APP_NAME], optionalFor: [] },
    };
    assert.deepEqual(await audited("connector.disable", KEYED), [row]);
    assert.deepEqual(await audited("connector.enable", KEYED), [row]);

    // An app that declares it as optional is named as such.
    await p.setConnectorEnabled(OAUTH, false, actor);
    await p.setConnectorEnabled(OAUTH, true, actor);
    assert.deepEqual(
      (await audited("connector.disable", OAUTH)).map((r) => r.details),
      [{ requiredBy: [], optionalFor: [APP_NAME] }],
    );

    // A name that is not a connector here changes nothing and records nothing.
    await assert.rejects(p.setConnectorEnabled("not-a-connector", false, actor), /not found/);
    assert.equal(await p.isConnectorDisabled("not-a-connector"), false);
    assert.deepEqual(await audited("connector.disable", "not-a-connector"), []);
  });

  test("credentials survive Disable and Enable, and the connector uses them again", async () => {
    const stored = await credentialsRow(KEYED);
    assert.ok(stored, "no credentials to keep");

    await p.setConnectorEnabled(KEYED, false, actor);
    assert.deepEqual(await credentialsRow(KEYED), stored, "Disable touched the credentials");
    await p.setConnectorEnabled(KEYED, true, actor);
    assert.deepEqual(await credentialsRow(KEYED), stored, "Enable touched the credentials");
    assert.deepEqual(await p.getDecryptedConfig(KEYED), { apiKey: "key-1" });

    upstream({ [ME]: { name: "Acme" } });
    assert.equal((await p.runConnectorTest(KEYED)).ok, true);
  });
});
