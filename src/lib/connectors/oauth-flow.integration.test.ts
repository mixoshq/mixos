/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the connector OAuth callback records in the admin audit log, against a
 * real Postgres. An admin connecting a tenant connector is recorded as
 * `connector.connect`, naming the admin and the scopes granted, with no token
 * in the row or in the logs. A round trip that stores no grant records
 * nothing, and a person's own connection, to a user-scoped connector, is
 * theirs and not an admin action.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database on. The database's name ends in this run's own suffix, and
 * it is dropped when the run finishes:
 *
 *   docker run -d --name oauth -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test src/lib/connectors/oauth-flow.integration.test.ts
 *
 * The connectors are the OAuth template under connectors/, registered for this
 * run only, and a user-scoped copy of it. The provider's token endpoint is a
 * stubbed fetch, so nothing leaves the machine.
 */

import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { inspect } from "node:util";
import postgres, { type Sql } from "postgres";
import { migratePlatform } from "../../../scripts/platform-migrations";
import type { ConnectorManifest } from "./types";

const REPO = path.resolve(__dirname, "../../..");
const serverUrl = process.env.MIXOS_TEST_DATABASE_URL;
const skip = serverUrl ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres";

const run = randomBytes(3).toString("hex");
const database = `mixos_oauth_${run}`;

/** Three-legged OAuth, connected once by an admin for everyone. */
const TENANT = "_template-oauth";
/** The same, but each person connects their own account. */
const MINE = `mine-${run}`;
const TOKEN_URL = "https://provider.example.com/oauth/token";

const ADMIN_EMAIL = `admin-${run}@mixos.test`;
const MEMBER_EMAIL = `member-${run}@mixos.test`;
const CLIENT_SECRET = `client-secret-${randomBytes(8).toString("hex")}`;

/** A token pair the provider hands out, unique enough to search the logs for. */
const tokenPair = () => ({
  access: `at-${randomBytes(12).toString("hex")}`,
  refresh: `rt-${randomBytes(12).toString("hex")}`,
});

async function loadPlatform() {
  return {
    ...(await import("@/generated/connector-registry")),
    ...(await import("./config")),
    ...(await import("./oauth")),
    ...(await import("./oauth-flow")),
    ...(await import("./switch")),
    ...(await import("./user-config")),
    platformSql: (await import("@/lib/db/client")).sql,
  };
}

const manifestOf = (name: string) =>
  JSON.parse(
    fs.readFileSync(path.join(REPO, "connectors", name, "connector.json"), "utf8"),
  ) as ConnectorManifest;

// ── the provider ────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;

/** Answer the token endpoint with `body` and `status`; anything else is a 404. */
function provider(body: unknown, status = 200) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return url === TOKEN_URL
      ? Response.json(body, { status })
      : Response.json({ error: "not stubbed" }, { status: 404 });
  }) as typeof fetch;
}

/** Everything written to the console while `fn` runs, as it would print, one string per call. */
async function logged<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const lines: string[] = [];
  const keep = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 8 }))).join(" "));
  };
  console.log = console.info = console.warn = console.error = keep;
  try {
    return { result: await fn(), lines };
  } finally {
    Object.assign(console, saved);
  }
}

describe("the connector OAuth callback's audit row", { skip }, () => {
  let admin: Sql;
  let sql: Sql;
  let p: Awaited<ReturnType<typeof loadPlatform>>;
  let adminId: string;
  let memberId: string;

  const sessionOf = (id: string, email: string, isAdmin: boolean) => ({
    user: { id, email, name: isAdmin ? "Admin" : "Member", isAdmin },
  });
  const adminSession = () => sessionOf(adminId, ADMIN_EMAIL, true);
  const memberSession = () => sessionOf(memberId, MEMBER_EMAIL, false);

  /** The provider's redirect back, for a flow started by `userId` (null for a tenant flow). */
  function roundTrip(name: string, userId: string | null) {
    const flow = p.newFlowState(name, "/admin/connectors", userId);
    const code = `code-${randomBytes(8).toString("hex")}`;
    return { flow, code, params: new URLSearchParams({ code, state: flow.state }) };
  }

  async function connectRows(targetId: string) {
    const rows = await sql`
      select actor_id, actor_email, target_type, target_id, details
      from public.admin_audit_log
      where action = 'connector.connect' and target_id = ${targetId}
      order by created_at
    `;
    return rows.map((r) => ({ ...r }));
  }

  /** The whole audit log, every column, as text. */
  async function wholeLog(): Promise<string> {
    const rows = await sql`select row_to_json(l)::text as row from public.admin_audit_log l`;
    return rows.map((r) => r.row as string).join("\n");
  }

  before(async () => {
    admin = postgres(serverUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${database}`);
    const u = new URL(serverUrl!);
    u.pathname = `/${database}`;
    sql = postgres(u.toString(), { max: 1, onnotice: () => {} });
    await migratePlatform(sql, path.join(REPO, "supabase", "migrations"), () => {});

    // The platform's own pool reads these on its first query.
    process.env.DATABASE_URL = u.toString();
    process.env.PGSSLMODE = u.searchParams.get("sslmode") ?? "disable";
    process.env.CONNECTOR_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    process.env.USER_OAUTH_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    process.env.NEXTAUTH_URL = "https://mixos.test";
    p = await loadPlatform();

    p.connectorRegistry.push(manifestOf(TENANT), {
      ...manifestOf(TENANT),
      name: MINE,
      userScoped: true,
    });

    const [a] = await sql`
      insert into public.users (email, display_name, is_admin)
      values (${ADMIN_EMAIL}, 'Admin', true) returning id
    `;
    const [m] = await sql`
      insert into public.users (email, display_name, is_admin)
      values (${MEMBER_EMAIL}, 'Member', false) returning id
    `;
    adminId = a.id;
    memberId = m.id;

    // The application registration, which an admin saves for both: a person
    // connecting their own account still uses the deployment's client.
    for (const name of [TENANT, MINE]) {
      await p.saveConnectorConfig(name, { clientId: "cid", clientSecret: CLIENT_SECRET }, adminId);
    }
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  after(async () => {
    try {
      if (p) {
        for (const name of [TENANT, MINE]) {
          const at = p.connectorRegistry.findIndex((c) => c.name === name);
          if (at >= 0) p.connectorRegistry.splice(at, 1);
        }
        await p.platformSql.end();
      }
    } finally {
      await sql?.end();
      if (admin) {
        await admin.unsafe(`drop database if exists ${database} with (force)`);
        await admin.end();
      }
    }
  });

  test("connecting a tenant connector records who connected it and the scopes granted, and no token", async () => {
    const tokens = tokenPair();
    provider({
      access_token: tokens.access,
      refresh_token: tokens.refresh,
      expires_in: 3600,
      scope: "things:read",
    });
    const { flow, code, params } = roundTrip(TENANT, null);

    const { result, lines } = await logged(() =>
      p.finishConnectorOAuth({ name: TENANT, session: adminSession(), flow, params }),
    );
    assert.deepEqual(result, { outcome: "connected", revalidate: "/admin/connectors" });
    // The grant itself is stored, as before.
    assert.equal((await p.getDecryptedConfig(TENANT))?.[p.TOKEN_KEYS.access], tokens.access);

    assert.deepEqual(await connectRows(TENANT), [
      {
        actor_id: adminId,
        actor_email: ADMIN_EMAIL,
        target_type: "connector",
        target_id: TENANT,
        details: { scopes: ["things:read"] },
      },
    ]);

    // Nothing secret, in any row or any column, or in anything logged.
    const log = await wholeLog();
    for (const secret of [tokens.access, tokens.refresh, CLIENT_SECRET, code, flow.codeVerifier, flow.state]) {
      assert.equal(log.includes(secret), false, "the audit log holds a secret");
      assert.equal(lines.some((line) => line.includes(secret)), false, "a secret was logged");
    }
  });

  test("a reconnect is recorded again, with the scopes the new grant has", async () => {
    const before = (await connectRows(TENANT)).length;
    const tokens = tokenPair();
    provider({
      access_token: tokens.access,
      refresh_token: tokens.refresh,
      expires_in: 3600,
      scope: "things:read things:write",
    });
    const { flow, params } = roundTrip(TENANT, null);

    const { result } = await logged(() =>
      p.finishConnectorOAuth({ name: TENANT, session: adminSession(), flow, params }),
    );
    assert.equal(result.outcome, "connected");

    const rows = await connectRows(TENANT);
    assert.equal(rows.length, before + 1);
    assert.deepEqual(rows.at(-1)?.details, { scopes: ["things:read", "things:write"] });
    assert.equal((await wholeLog()).includes(tokens.access), false);
  });

  test("a round trip that stores no grant records nothing", async () => {
    const before = await connectRows(TENANT);
    const finish = async (
      flow: ReturnType<typeof roundTrip>["flow"] | null,
      params: URLSearchParams,
      session = adminSession(),
    ) => (await logged(() => p.finishConnectorOAuth({ name: TENANT, session, flow, params }))).result.outcome;

    // Declined at the provider, a forged state, and a missing flow cookie.
    const declined = roundTrip(TENANT, null);
    assert.equal(await finish(declined.flow, new URLSearchParams({ error: "access_denied" })), "denied");
    const forged = roundTrip(TENANT, null);
    assert.equal(
      await finish(forged.flow, new URLSearchParams({ code: forged.code, state: "forged" })),
      "state",
    );
    assert.equal(await finish(null, roundTrip(TENANT, null).params), "expired");

    // Turned off since the round trip began.
    provider({ access_token: "unused", expires_in: 3600 });
    await p.setConnectorDisabled(TENANT, true);
    try {
      const off = roundTrip(TENANT, null);
      assert.equal(await finish(off.flow, off.params), "disabled");
    } finally {
      await p.setConnectorDisabled(TENANT, false);
    }

    // The provider refuses the code.
    provider({ error: "invalid_grant" }, 400);
    const refused = roundTrip(TENANT, null);
    assert.equal(await finish(refused.flow, refused.params), "exchange-failed");

    // Someone who isn't an admin can't finish a tenant connection at all.
    provider({ access_token: "unused", expires_in: 3600 });
    const member = roundTrip(TENANT, null);
    await assert.rejects(finish(member.flow, member.params, memberSession()), /Admin access required/);

    assert.deepEqual(await connectRows(TENANT), before);
  });

  test("a person's own connection, to a user-scoped connector, is theirs and isn't audited", async () => {
    const auditRows = async () =>
      (await sql`select count(*)::int as n from public.admin_audit_log`)[0].n as number;
    const before = await auditRows();

    // A member connecting their own account, and an admin connecting theirs.
    for (const [session, userId] of [
      [memberSession(), memberId],
      [adminSession(), adminId],
    ] as const) {
      const tokens = tokenPair();
      provider({
        access_token: tokens.access,
        refresh_token: tokens.refresh,
        expires_in: 3600,
        scope: "things:read",
      });
      const { flow, params } = roundTrip(MINE, userId);

      const { result } = await logged(() => p.finishConnectorOAuth({ name: MINE, session, flow, params }));
      assert.deepEqual(result, { outcome: "connected", revalidate: "/account/connections" });
      assert.equal((await p.getUserTokens(userId, MINE))?.[p.TOKEN_KEYS.access], tokens.access);
    }

    assert.equal(await auditRows(), before);
    assert.deepEqual(await connectRows(MINE), []);
  });
});
