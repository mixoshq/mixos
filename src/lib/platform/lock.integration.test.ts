/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The platform lock against a real Postgres. Skipped unless
 * MIXOS_TEST_DATABASE_URL names a database it may create
 * `public._platform_locks` in and write `test.*` lock rows to — never point it
 * at one that matters:
 *
 *   docker run -d --name locks -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test src/lib/platform/lock.integration.test.ts
 *
 * A holder paused past the TTL is simulated by ageing its row, which is all a
 * pause does to the lock: the row stops being renewed while the clock moves on.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import { LockLostError, LockUnavailableError, withPlatformLock, type LockName } from "./lock";

const url = process.env.MIXOS_TEST_DATABASE_URL;
const skip = url ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres";

let sql: Sql;
let createdTable = false;

/** A lock of each test's own, so no test can see another's row. */
const lockName = (label: string) => `test.${label}.${randomUUID()}` as LockName;

/** Make `name`'s lease `seconds` older, as a holder paused that long would leave it. */
async function age(name: LockName, seconds: number): Promise<void> {
  await sql`
    update public._platform_locks
    set acquired_at = acquired_at - make_interval(secs => ${seconds})
    where name = ${name}
  `;
}

/** Holds a holder mid-operation until `open()`. */
function gate(): { open: () => void; opened: Promise<void> } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  if (!url) return;
  sql = postgres(url, { prepare: false, max: 4, onnotice: () => {} });
  // lock.ts reaches the database through the lazy pool in
  // src/lib/db/client.ts, which uses globalThis.__pg once it is set.
  (globalThis as { __pg?: Sql }).__pg = sql;

  const [{ present }] = await sql<{ present: boolean }[]>`
    select to_regclass('public._platform_locks') is not null as present
  `;
  if (!present) {
    // As supabase/migrations/0001_platform_schema.sql creates it.
    await sql`
      create table public._platform_locks (
        name        text primary key,
        holder      text not null,
        acquired_at timestamptz not null default now()
      )
    `;
    createdTable = true;
  }
});

after(async () => {
  if (!url) return;
  if (createdTable) await sql`drop table public._platform_locks`;
  else await sql`delete from public._platform_locks where name like 'test.%'`;
  await sql.end();
});

// ── the try-lock ────────────────────────────────────────────────────────────

test("a held lock refuses a second holder without running it, and is free once released", { skip }, async () => {
  const name = lockName("try");
  let ran = false;
  await withPlatformLock(name, async () => {
    await assert.rejects(
      withPlatformLock(name, async () => {
        ran = true;
      }),
      LockUnavailableError,
    );
  });
  assert.equal(ran, false);
  assert.equal(await withPlatformLock(name, async () => "free"), "free");
});

test("a holder that throws still releases", { skip }, async () => {
  const name = lockName("throws");
  await assert.rejects(
    withPlatformLock(name, async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(await withPlatformLock(name, async () => "free"), "free");
});

// ── a holder paused past the TTL ────────────────────────────────────────────

test("a holder paused past the TTL loses the lock, stops at assertHeld(), and leaves the new holder's row", { skip }, async () => {
  const name = lockName("takeover");
  const changes: string[] = [];

  const firstIn = gate();
  const paused = gate();
  const first = withPlatformLock(name, async (lease) => {
    firstIn.open();
    await paused.opened;
    // Its next disk change, once it wakes up.
    await lease.assertHeld();
    changes.push("first");
  });
  await firstIn.opened;

  // Sixteen minutes without a renewal, then someone else asks.
  await age(name, 16 * 60);
  const secondIn = gate();
  const secondGo = gate();
  const second = withPlatformLock(name, async (lease) => {
    secondIn.open();
    await secondGo.opened;
    await lease.assertHeld();
    changes.push("second");
  });
  await secondIn.opened;

  paused.open();
  await assert.rejects(first, LockLostError);
  assert.deepEqual(changes, []);

  // The first holder's release on its way out was scoped to its own token, so
  // the lock is still the second's, and still refuses a third.
  await assert.rejects(withPlatformLock(name, async () => {}), LockUnavailableError);
  secondGo.open();
  await second;
  assert.deepEqual(changes, ["second"]);
});

test("a lapsed lease nobody took is still the holder's, and assertHeld() renews it", { skip }, async () => {
  const name = lockName("lapsed");
  await withPlatformLock(name, async (lease) => {
    await age(name, 16 * 60);
    await lease.assertHeld();
    await assert.rejects(withPlatformLock(name, async () => {}), LockUnavailableError);
  });
});

// ── renewal ─────────────────────────────────────────────────────────────────

test("renewal keeps a holder that runs past the TTL", { skip }, async () => {
  const name = lockName("renewed");
  const options = { ttlSeconds: 1, renewEveryMs: 100 };
  await withPlatformLock(
    name,
    async (lease) => {
      // Three TTLs, with someone asking every half second.
      for (let i = 0; i < 6; i++) {
        await sleep(500);
        await assert.rejects(withPlatformLock(name, async () => {}, options), LockUnavailableError);
      }
      await lease.assertHeld();
    },
    options,
  );
});

test("without renewal, the same wait loses it", { skip }, async () => {
  const name = lockName("unrenewed");
  const options = { ttlSeconds: 1, renewEveryMs: 60_000 };
  await withPlatformLock(
    name,
    async (lease) => {
      await sleep(1_500);
      assert.equal(await withPlatformLock(name, async () => "taken", options), "taken");
      await assert.rejects(lease.assertHeld(), LockLostError);
    },
    options,
  );
});
