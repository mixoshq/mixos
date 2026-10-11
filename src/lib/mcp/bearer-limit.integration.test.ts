/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The MCP route's limit on failed bearer-token checks, against a real
 * Postgres: real tokens from the token store, and every statement the route
 * runs recorded, so a refused request can be shown not to reach the store.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database on. The database's name ends in this run's own suffix, and
 * it is dropped when the run finishes:
 *
 *   docker run -d --name limits -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test src/lib/mcp/bearer-limit.integration.test.ts
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import path from "node:path";
import postgres, { type Sql } from "postgres";
import type { NextRequest } from "next/server";
import { migratePlatform } from "../../../scripts/platform-migrations";

const REPO = path.resolve(__dirname, "../../..");
const serverUrl = process.env.MIXOS_TEST_DATABASE_URL;
const skip = serverUrl ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres";

const run = randomBytes(3).toString("hex");
const database = `mixos_bearer_${run}`;

/** Every statement the platform's pool runs, as its text. */
const statements: string[] = [];
const tokenLookups = () => statements.filter((s) => s.includes("oauth_tokens")).length;

function recording(pool: Sql): Sql {
  return new Proxy(pool, {
    apply(target, thisArg, args) {
      if (Array.isArray(args[0]) && "raw" in args[0]) statements.push(args[0].join("?"));
      return Reflect.apply(target, thisArg, args);
    },
    get(target, prop) {
      if (prop === "unsafe") {
        return (text: string, ...rest: unknown[]) => {
          statements.push(text);
          return (target.unsafe as (...a: unknown[]) => unknown)(text, ...rest);
        };
      }
      return Reflect.get(target, prop);
    },
  });
}

async function loadPlatform() {
  return {
    ...(await import("./store")),
    ...(await import("./bearer-limit")),
    ...(await import("@/lib/rate-limit")),
    POST: (await import("@/app/api/mcp/route")).POST,
  };
}

describe("failed MCP bearer checks", { skip }, () => {
  let admin: Sql;
  let sql: Sql;
  let p: Awaited<ReturnType<typeof loadPlatform>>;
  let valid: string;

  /** A ping to the MCP route from `ip`, bearing `token`. */
  async function ping(ip: string, token: string) {
    const request = new Request("https://mos.test/api/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-forwarded-for": ip,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    const res = await p.POST(request as unknown as NextRequest);
    await res.arrayBuffer();
    return res;
  }

  const guess = () => `ros_at_${randomBytes(32).toString("base64url")}`;

  before(async () => {
    admin = postgres(serverUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${database}`);
    const u = new URL(serverUrl!);
    u.pathname = `/${database}`;
    sql = postgres(u.toString(), { max: 2, onnotice: () => {} });
    await migratePlatform(sql, path.join(REPO, "supabase", "migrations"), () => {});

    process.env.MCP_TOKEN_KEY = randomBytes(32).toString("hex");
    process.env.NEXTAUTH_URL = "https://mos.test";
    (globalThis as { __pg?: Sql }).__pg = recording(postgres(u.toString(), { max: 4, onnotice: () => {} }));
    p = await loadPlatform();

    const [user] = await sql`
      insert into public.users (email, display_name) values (${`mcp-${run}@mos.test`}, 'MCP')
      returning id
    `;
    const client = await p.registerClient({
      clientName: "Test client",
      redirectUris: ["https://client.test/callback"],
    });
    valid = (await p.issueTokens({ clientId: client.clientId, userId: user.id, grantedApps: [] }))
      .accessToken;
  });

  after(async () => {
    await (globalThis as { __pg?: Sql }).__pg?.end();
    await sql?.end();
    if (admin) {
      await admin.unsafe(`drop database if exists ${database} with (force)`);
      await admin.end();
    }
  });

  test("past the budget, a failed check is answered 429 without the token store being read", async () => {
    const ip = "192.0.2.1";
    for (let i = 1; i <= p.BEARER_FAILURE_LIMIT.maxTokens; i++) {
      statements.length = 0;
      const res = await ping(ip, guess());
      assert.equal(res.status, 401);
      assert.match(res.headers.get("www-authenticate") ?? "", /^Bearer .*resource_metadata=/);
      assert.equal(tokenLookups(), 1);
    }

    statements.length = 0;
    const refused = await ping(ip, guess());
    assert.equal(refused.status, 429);
    assert.ok(Number(refused.headers.get("retry-after")) >= 1);
    assert.equal(tokenLookups(), 0, "a refused check reads no token");

    // Only the lookup could tell a valid token apart, so it waits too.
    assert.equal((await ping(ip, valid)).status, 429);
    assert.equal(tokenLookups(), 0);

    // Another address is served.
    assert.equal((await ping("192.0.2.2", valid)).status, 200);
  });

  test("a valid token is never charged to its address", async () => {
    const ip = "192.0.2.3";
    for (let i = 0; i < 40; i++) assert.equal((await ping(ip, valid)).status, 200);
    for (let i = 1; i <= p.BEARER_FAILURE_LIMIT.maxTokens; i++) {
      assert.equal((await ping(ip, guess())).status, 401);
    }
    assert.equal((await ping(ip, guess())).status, 429);
  });

  test("another server instance refuses an address whose budget was spent here", async () => {
    const ip = "192.0.2.4";
    for (let i = 1; i <= p.BEARER_FAILURE_LIMIT.maxTokens; i++) await ping(ip, guess());

    let lookups = 0;
    const elsewhere = p.createBearerCheck(async (token) => {
      lookups += 1;
      return p.resolveAccessToken(token);
    }, p.createRateLimiter(p.BEARER_FAILURE_LIMIT));
    const request = new Request("https://mos.test/api/mcp", { headers: { "x-forwarded-for": ip } });
    assert.equal((await elsewhere(valid, request)).status, "limited");
    assert.equal(lookups, 0);
  });
});
