/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The webhook route's body cap and per-IP limit, against a real Postgres.
 * Every statement the route runs is recorded, so a refused delivery can be
 * shown not to read the switch or the credentials, or to decrypt anything.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database on. The database's name ends in this run's own suffix, and
 * it is dropped when the run finishes:
 *
 *   docker run -d --name limits -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test src/lib/connectors/webhook-limits.integration.test.ts
 *
 * The connector is the OAuth template under connectors/, registered for this
 * run only, as in switch.integration.test.ts.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import postgres, { type Sql } from "postgres";
import { migratePlatform } from "../../../scripts/platform-migrations";
import type { ConnectorManifest } from "./types";

const REPO = path.resolve(__dirname, "../../..");
const serverUrl = process.env.MIXOS_TEST_DATABASE_URL;
const skip = serverUrl ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres";

const run = randomBytes(3).toString("hex");
const database = `mixos_webhooks_${run}`;
const NAME = "_template-oauth";
const SECRET = "whsec";
const MIB = 1024 * 1024;

/** Every statement the platform's pool runs, as its text. */
const statements: string[] = [];
/** The public tables a statement names, quoted (the query builder) or not. */
const tablesIn = (s: string) => [...s.matchAll(/"?public"?\."?(\w+)"?/g)].map((m) => m[1]);
/** The maintenance gate's own read, which comes before everything (src/lib/platform/maintenance.ts). */
const isGateRead = (s: string) =>
  s.includes("platform_schema_version") || tablesIn(s).includes("_migrations");
/** The tables a request read or wrote after the maintenance gate. */
const touched = () => [...new Set(statements.filter((s) => !isGateRead(s)).flatMap(tablesIn))];

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
    ...(await import("@/generated/connector-registry")),
    ...(await import("./config")),
    ...(await import("./switch")),
    ...(await import("./webhook")),
    POST: (await import("@/app/api/webhooks/[name]/route")).POST,
  };
}

/** Silence the logs a refusal writes on purpose, for the length of `fn`. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const { warn, error } = console;
  console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, { warn, error });
  }
}

/** A body of `count` chunks of `size` bytes that records how many were pulled. */
function countedBody(count: number, size: number) {
  const pulled = { chunks: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled.chunks === count) return controller.close();
      pulled.chunks += 1;
      controller.enqueue(new Uint8Array(size).fill(0x61));
    },
  });
  return { pulled, stream };
}

describe("webhook body cap and per-IP limit", { skip }, () => {
  let admin: Sql;
  let sql: Sql;
  let p: Awaited<ReturnType<typeof loadPlatform>>;

  async function deliver(ip: string, body: BodyInit, headers: Record<string, string> = {}) {
    const request = new Request(`https://mixos.test/api/webhooks/${NAME}`, {
      method: "POST",
      body,
      headers: { "content-type": "application/json", "x-forwarded-for": ip, ...headers },
      duplex: "half",
    } as RequestInit);
    const res = await quietly(() => p.POST(request, { params: Promise.resolve({ name: NAME }) }));
    return { res, text: await res.text() };
  }

  /** A delivery signed as the template's policy says. */
  function signed(data: unknown) {
    const body = JSON.stringify({ type: "thing.created", data });
    const ts = String(Math.floor(Date.now() / 1000));
    return {
      body,
      headers: {
        "X-Provider-Timestamp": ts,
        "X-Provider-Signature": createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex"),
      },
    };
  }

  const claims = async () =>
    (await sql`select count(*)::int as n from public.connector_webhook_events`)[0].n as number;

  before(async () => {
    admin = postgres(serverUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${database}`);
    const u = new URL(serverUrl!);
    u.pathname = `/${database}`;
    sql = postgres(u.toString(), { max: 2, onnotice: () => {} });
    await migratePlatform(sql, path.join(REPO, "supabase", "migrations"), () => {});

    process.env.CONNECTOR_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    process.env.NEXTAUTH_URL = "https://mixos.test";
    (globalThis as { __pg?: Sql }).__pg = recording(postgres(u.toString(), { max: 8, onnotice: () => {} }));
    p = await loadPlatform();

    p.connectorRegistry.push(
      JSON.parse(
        fs.readFileSync(path.join(REPO, "connectors", NAME, "connector.json"), "utf8"),
      ) as ConnectorManifest,
    );
    const [user] = await sql`
      insert into public.users (email, display_name, is_admin)
      values (${`hooks-${run}@mixos.test`}, 'Admin', true) returning id
    `;
    await p.saveConnectorConfig(NAME, { clientId: "cid", clientSecret: "sec", webhookSecret: SECRET }, user.id);
  });

  after(async () => {
    await (globalThis as { __pg?: Sql }).__pg?.end();
    await sql?.end();
    if (admin) {
      await admin.unsafe(`drop database if exists ${database} with (force)`);
      await admin.end();
    }
  });

  test("a signed delivery under the cap is served, a large one included", async () => {
    const small = signed({ n: 1 });
    const { res } = await deliver("192.0.2.10", small.body, small.headers);
    assert.equal(res.status, 200);

    const large = signed({ blob: "x".repeat(4 * MIB) });
    const big = await deliver("192.0.2.10", large.body, large.headers);
    assert.equal(big.res.status, 200);
    assert.deepEqual(JSON.parse(big.text), { ok: true });
    assert.equal(await claims(), 2);
  });

  test("a body over the cap is answered 413, read no further than the cap, before anything is read or decrypted", async () => {
    const before = await claims();

    // Declared: refused on the header, before a byte is read.
    const declared = countedBody(1000, 64 * 1024);
    statements.length = 0;
    const first = await deliver("192.0.2.20", declared.stream, {
      "content-length": String(p.MAX_WEBHOOK_BODY_BYTES + 1),
    });
    assert.equal(first.res.status, 413);
    assert.ok(declared.pulled.chunks <= 1, `pulled ${declared.pulled.chunks} chunks`);
    // The limiter's charge, and nothing else: no switch, no credentials.
    assert.deepEqual(touched(), ["rate_buckets"]);

    // Undeclared: read until it passes the cap, and not a chunk after.
    const streamed = countedBody(1000, 64 * 1024);
    statements.length = 0;
    const second = await deliver("192.0.2.21", streamed.stream);
    assert.equal(second.res.status, 413);
    assert.equal(second.res.headers.get("connection"), "close");
    const atCap = p.MAX_WEBHOOK_BODY_BYTES / (64 * 1024);
    assert.ok(streamed.pulled.chunks <= atCap + 2, `pulled ${streamed.pulled.chunks} of 1000 chunks`);
    assert.deepEqual(touched(), ["rate_buckets"]);

    assert.equal(await claims(), before, "nothing was recorded as seen");
  });

  test("a burst from one address is answered 429 with Retry-After past the budget", async () => {
    const started = Date.now();
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) => deliver("192.0.2.30", JSON.stringify({ i }))),
    );
    const seconds = (Date.now() - started) / 1000;
    const statuses = results.map((r) => r.res.status);
    const served = statuses.filter((s) => s === 401).length;
    const refused = results.filter((r) => r.res.status === 429);
    assert.equal(served + refused.length, 100, statuses.join(","));
    // 60 at once, then 10 a second while the burst lasted.
    assert.ok(served >= 60 && served <= 60 + Math.ceil(seconds * 10) + 1, `${served} in ${seconds}s`);
    assert.ok(refused.length > 0);
    for (const r of refused) assert.ok(Number(r.res.headers.get("retry-after")) >= 1);
  });

  test("an address whose budget is spent is refused before the database is read or anything decrypted", async () => {
    // Spent on another instance: this one's memory has seen nothing of it.
    const ip = "192.0.2.40";
    await sql`
      insert into public.rate_buckets (scope, subject, tokens, last_refill)
      values ('ip', ${`connector-webhooks::${ip}`}, 0, now())
    `;
    const before = await claims();
    const delivery = signed({ n: 2 });
    statements.length = 0;
    const { res } = await deliver(ip, delivery.body, delivery.headers);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "1");
    // The limiter's own charge is the only table touched.
    assert.deepEqual(touched(), ["rate_buckets"]);
    assert.equal(await claims(), before);
  });

  test("the cap and the limit answer the same for a connector that is turned off", async () => {
    await p.setConnectorDisabled(NAME, true);
    try {
      const over = await deliver("192.0.2.50", "x".repeat(p.MAX_WEBHOOK_BODY_BYTES + 1));
      assert.equal(over.res.status, 413);

      const ip = "192.0.2.51";
      await sql`
        insert into public.rate_buckets (scope, subject, tokens, last_refill)
        values ('ip', ${`connector-webhooks::${ip}`}, 0, now())
      `;
      const delivery = signed({ n: 3 });
      assert.equal((await deliver(ip, delivery.body, delivery.headers)).res.status, 429);

      // Within budget and under the cap, the switch answers as it did.
      const allowed = signed({ n: 4 });
      assert.equal((await deliver("192.0.2.52", allowed.body, allowed.headers)).res.status, 401);
    } finally {
      await p.setConnectorDisabled(NAME, false);
    }
  });
});
