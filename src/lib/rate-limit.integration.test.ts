/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The rate limiter against a real Postgres: `check` reads a bucket without
 * charging it, and the limits that keep a budget for a secret check hold it
 * across server instances, not per instance.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database on. The database's name ends in this run's own suffix, and
 * it is dropped when the run finishes:
 *
 *   docker run -d --name limits -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test src/lib/rate-limit.integration.test.ts
 *
 * A second `createRateLimiter` with the same options stands in for a second
 * server instance: its own memory, the same Postgres row.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import path from "node:path";
import postgres, { type Sql } from "postgres";
import { migratePlatform } from "../../scripts/platform-migrations";
import { RECHECK_LIMIT, recheckOwnPassword } from "./auth/recheck-limit";
import { BEARER_FAILURE_LIMIT } from "./mcp/bearer-limit";
import { createRateLimiter, type RateLimiterOptions } from "./rate-limit";

const REPO = path.resolve(__dirname, "../..");
const serverUrl = process.env.MIXOS_TEST_DATABASE_URL;
const skip = serverUrl ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres";

const run = randomBytes(3).toString("hex");
const database = `mixos_limits_${run}`;

/** Every statement the platform's pool runs, as its text. */
const statements: string[] = [];

/** The pool behind the lazy `sql` proxy (src/lib/db/client.ts), recording what it runs. */
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

describe("the rate limiter against Postgres", { skip }, () => {
  let admin: Sql;
  let sql: Sql;

  /** A limiter of this run's own, so no test sees another's rows. */
  const options = (label: string, maxTokens = 3, refillRatePerSecond = 0.01): RateLimiterOptions => ({
    scope: "ip",
    name: `test-${label}-${run}`,
    maxTokens,
    refillRatePerSecond,
  });

  const row = async (o: RateLimiterOptions, identity: string) =>
    (
      await sql`
        select tokens from public.rate_buckets
        where scope = ${o.scope} and subject = ${`${o.name}::${identity}`}
      `
    )[0] as { tokens: number } | undefined;

  before(async () => {
    admin = postgres(serverUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${database}`);
    const u = new URL(serverUrl!);
    u.pathname = `/${database}`;
    sql = postgres(u.toString(), { max: 2, onnotice: () => {} });
    await migratePlatform(sql, path.join(REPO, "supabase", "migrations"), () => {});
    (globalThis as { __pg?: Sql }).__pg = recording(postgres(u.toString(), { max: 4, onnotice: () => {} }));
  });

  after(async () => {
    await (globalThis as { __pg?: Sql }).__pg?.end();
    await sql?.end();
    if (admin) {
      await admin.unsafe(`drop database if exists ${database} with (force)`);
      await admin.end();
    }
  });

  test("check reads a bucket without charging it", async () => {
    const o = options("check");
    const limiter = createRateLimiter(o);
    for (let i = 0; i < 10; i++) {
      assert.deepEqual(await limiter.check("203.0.113.1"), {
        allowed: true,
        remaining: o.maxTokens,
        retryAfterMs: 0,
      });
    }
    assert.equal(await row(o, "203.0.113.1"), undefined, "no bucket was written");

    await limiter.consume("203.0.113.1");
    const charged = await row(o, "203.0.113.1");
    await limiter.check("203.0.113.1");
    assert.equal((await row(o, "203.0.113.1"))?.tokens, charged?.tokens);
  });

  test("once the budget is spent, check refuses on every instance", async () => {
    const o = options("spent");
    const first = createRateLimiter(o);
    const second = createRateLimiter(o);
    for (let i = 0; i < o.maxTokens; i++) assert.equal((await first.consume("203.0.113.2")).allowed, true);

    const here = await first.check("203.0.113.2");
    assert.equal(here.allowed, false);

    // The second instance's memory has seen nothing, so Postgres answers.
    const there = await second.check("203.0.113.2");
    assert.equal(there.allowed, false);
    assert.ok(there.retryAfterMs > 0 && there.retryAfterMs <= 100_000, `${there.retryAfterMs} ms`);
    assert.equal((await second.consume("203.0.113.2")).allowed, false);

    // Another identity is untouched.
    assert.equal((await second.check("203.0.113.3")).allowed, true);
  });

  test("an instance whose memory already refuses asks Postgres nothing", async () => {
    const o = options("memory");
    const limiter = createRateLimiter(o);
    for (let i = 0; i < o.maxTokens; i++) await limiter.consume("203.0.113.4");
    statements.length = 0;
    assert.equal((await limiter.check("203.0.113.4")).allowed, false);
    assert.equal((await limiter.consume("203.0.113.4")).allowed, false);
    assert.deepEqual(statements, []);
  });

  test("check lets a request through again once the bucket has refilled", async () => {
    const o = options("refill");
    const first = createRateLimiter(o);
    for (let i = 0; i < o.maxTokens; i++) await first.consume("203.0.113.5");
    assert.equal((await createRateLimiter(o).check("203.0.113.5")).allowed, false);

    // A minute and a half at 0.01 a second is one token's worth, and a bit.
    await sql`
      update public.rate_buckets set last_refill = last_refill - interval '150 seconds'
      where subject = ${`${o.name}::203.0.113.5`}
    `;
    assert.equal((await createRateLimiter(o).check("203.0.113.5")).allowed, true);
  });

  test("the password re-check budget is one per user, across instances", async () => {
    const user = `user-${run}`;
    const hashes: string[] = [];
    const verify = async (plaintext: string) => {
      hashes.push(plaintext);
      return false;
    };
    for (let i = 1; i <= RECHECK_LIMIT.maxTokens; i++) {
      assert.equal(await recheckOwnPassword(user, `guess ${i}`, "hash", verify), "wrong");
    }
    // Another instance, with nothing in memory, is refused by the shared row.
    const elsewhere = await createRateLimiter(RECHECK_LIMIT).consume(user);
    assert.equal(elsewhere.allowed, false);
    assert.ok(elsewhere.retryAfterMs > 0 && elsewhere.retryAfterMs <= 300_000, `${elsewhere.retryAfterMs} ms`);
    assert.equal(await recheckOwnPassword(user, "the right one", "hash", verify), "limited");
    assert.equal(hashes.length, RECHECK_LIMIT.maxTokens);
  });

  test("the MCP failure budget is one per address, across instances", async () => {
    const ip = `198.51.100.${Number.parseInt(run.slice(0, 2), 16)}`;
    const first = createRateLimiter(BEARER_FAILURE_LIMIT);
    for (let i = 0; i < BEARER_FAILURE_LIMIT.maxTokens; i++) await first.consume(ip);
    const elsewhere = await createRateLimiter(BEARER_FAILURE_LIMIT).check(ip);
    assert.equal(elsewhere.allowed, false);
    assert.ok(elsewhere.retryAfterMs > 0 && elsewhere.retryAfterMs <= 2_000, `${elsewhere.retryAfterMs} ms`);
  });
});
