/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The webhook route's maintenance response, against a real Postgres. The proxy
 * leaves `/api/webhooks/` out (src/proxy.ts), so the route runs the maintenance
 * gate itself, first. While the platform schema is behind, a delivery gets the
 * 503, and the gate's own read is the only statement run.
 *
 * A file of its own because the gate keeps its answer for 15 seconds in each
 * process, and the route's other tests need the answer "not behind".
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database on. The database's name ends in this run's own suffix, and
 * it is dropped when the run finishes:
 *
 *   docker run -d --name limits -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test src/lib/connectors/webhook-maintenance.integration.test.ts
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
const database = `mixos_hookmaint_${run}`;
const NAME = "_template-oauth";
const SECRET = "whsec";

/** Every statement the platform's pool runs, as its text. */
const statements: string[] = [];

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

/** The gate's own read: the schema version (src/lib/platform/schema-version.ts). */
const isGateRead = (s: string) => s.includes("platform_schema_version");

async function loadPlatform() {
  return {
    ...(await import("@/generated/connector-registry")),
    ...(await import("@/generated/build-info")),
    ...(await import("./config")),
    POST: (await import("@/app/api/webhooks/[name]/route")).POST,
  };
}

/** Silence the logs the maintenance response writes on purpose, for the length of `fn`. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const { warn, error } = console;
  console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, { warn, error });
  }
}

describe("the webhook route while the platform schema is behind", { skip }, () => {
  let admin: Sql;
  let sql: Sql;
  let p: Awaited<ReturnType<typeof loadPlatform>>;

  async function deliver(name: string, body: BodyInit, headers: Record<string, string> = {}) {
    const request = new Request(`https://mixos.test/api/webhooks/${name}`, {
      method: "POST",
      body,
      headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.60", ...headers },
      duplex: "half",
    } as RequestInit);
    const res = await quietly(() => p.POST(request, { params: Promise.resolve({ name }) }));
    return { res, text: await res.text() };
  }

  const count = async (table: string) =>
    (await sql.unsafe(`select count(*)::int as n from public.${table}`))[0].n as number;

  before(async () => {
    admin = postgres(serverUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${database}`);
    const u = new URL(serverUrl!);
    u.pathname = `/${database}`;
    sql = postgres(u.toString(), { max: 2, onnotice: () => {} });
    await migratePlatform(sql, path.join(REPO, "supabase", "migrations"), () => {});

    process.env.CONNECTOR_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    process.env.NEXTAUTH_URL = "https://mixos.test";
    (globalThis as { __pg?: Sql }).__pg = recording(postgres(u.toString(), { max: 4, onnotice: () => {} }));
    p = await loadPlatform();

    // A connector that would serve this delivery if the schema were current.
    p.connectorRegistry.push(
      JSON.parse(
        fs.readFileSync(path.join(REPO, "connectors", NAME, "connector.json"), "utf8"),
      ) as ConnectorManifest,
    );
    const [user] = await sql`
      insert into public.users (email, display_name, is_admin)
      values (${`maint-${run}@mixos.test`}, 'Admin', true) returning id
    `;
    await p.saveConnectorConfig(NAME, { clientId: "cid", clientSecret: "sec", webhookSecret: SECRET }, user.id);

    // The database one migration behind this build.
    await sql`
      update public.platform_settings set value = ${String(p.EXPECTED_SCHEMA_VERSION - 1)}
      where key = 'platform_schema_version'
    `;
  });

  after(async () => {
    await (globalThis as { __pg?: Sql }).__pg?.end();
    await sql?.end();
    if (admin) {
      await admin.unsafe(`drop database if exists ${database} with (force)`);
      await admin.end();
    }
  });

  test("a delivery gets the maintenance 503, and nothing past the gate is read, charged or recorded", async () => {
    const body = JSON.stringify({ type: "thing.created", data: { n: 1 } });
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex");

    statements.length = 0;
    const { res, text } = await deliver(NAME, body, {
      "X-Provider-Timestamp": ts,
      "X-Provider-Signature": signature,
    });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "30");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(JSON.parse(text), { error: "This instance is being updated. Try again shortly." });

    assert.ok(statements.some(isGateRead), "the gate read the schema version");
    assert.deepEqual(statements.filter((s) => !isGateRead(s)), [], "nothing past the gate");
    assert.equal(await count("rate_buckets"), 0, "the per-IP limit was not charged");
    assert.equal(await count("connector_webhook_events"), 0, "nothing was recorded as seen");
  });

  test("the body is not read, and an unknown connector gets the same 503", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled === 1000) return controller.close();
        pulled += 1;
        controller.enqueue(new Uint8Array(64 * 1024).fill(0x61));
      },
    });
    statements.length = 0;
    const big = await deliver(NAME, stream);
    assert.equal(big.res.status, 503);
    assert.ok(pulled <= 1, `pulled ${pulled} of 1000 chunks`);

    const unknown = await deliver("no-such-connector", "{}");
    assert.equal(unknown.res.status, 503);
    assert.equal(unknown.res.headers.get("retry-after"), "30");
    assert.deepEqual(statements.filter((s) => !isGateRead(s)), []);
  });
});
