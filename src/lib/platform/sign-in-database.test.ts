/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { databaseReadyForSignIn, type SignInDatabaseChecks } from "./sign-in-database";

function checks(over: Partial<SignInDatabaseChecks> = {}): SignInDatabaseChecks {
  return {
    ping: async () => [{ "?column?": 1 }],
    platformBehind: async () => false,
    ...over,
  };
}

/** Run the check, collecting what it logs instead of printing it. */
async function check(c: SignInDatabaseChecks) {
  const logged: string[] = [];
  const ready = await databaseReadyForSignIn(c, {
    pingTimeoutMs: 5,
    log: (...args) => logged.push(args.map(String).join(" ")),
  });
  return { ready, logged: logged.join("\n") };
}

test("a reachable database with the schema this build expects is ready", async () => {
  assert.deepEqual(await check(checks()), { ready: true, logged: "" });
});

test("no database configured is not ready, though the pool throws before a promise", async () => {
  const { ready, logged } = await check(
    checks({
      ping: () => {
        throw new Error("No Postgres connection configured. Set DATABASE_URL.");
      },
    }),
  );
  assert.equal(ready, false);
  assert.match(logged, /No Postgres connection configured/);
});

test("a database that refuses the connection is not ready", async () => {
  const { ready, logged } = await check(
    checks({ ping: async () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:5432")) }),
  );
  assert.equal(ready, false);
  assert.match(logged, /ECONNREFUSED/);
});

test("a database that doesn't answer in time is not ready", async () => {
  const { ready, logged } = await check(checks({ ping: () => new Promise(() => {}) }));
  assert.equal(ready, false);
  assert.match(logged, /db check timeout/);
});

test("a database behind this build's schema, a fresh one included, is not ready", async () => {
  assert.equal((await check(checks({ platformBehind: async () => true }))).ready, false);
});

test("the schema isn't asked about a database that can't be reached", async () => {
  let asked = 0;
  await check(
    checks({
      ping: async () => Promise.reject(new Error("connect ECONNREFUSED")),
      platformBehind: async () => {
        asked++;
        return false;
      },
    }),
  );
  assert.equal(asked, 0);
});
