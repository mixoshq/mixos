/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { RECHECK_LIMIT, recheckOwnPassword } from "./recheck-limit";

// No database: the limiter's Postgres charge throws, so it falls back to its
// in-memory bucket, which holds the same budget (src/lib/rate-limit.ts).
// rate-limit.integration.test.ts runs the same limit against a real Postgres.
(globalThis as { __pg?: unknown }).__pg = () => {
  throw new Error("no database in this test");
};
const warn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  if (String(args[0]).startsWith("[rate-limit] postgres unavailable")) return;
  warn(...args);
};

const PASSWORD = "the right password";
const HASH = `hash:${PASSWORD}`;
const BUDGET = RECHECK_LIMIT.maxTokens;

/** A stand-in for bcrypt that records each hash it runs. */
function countingVerify() {
  const runs: string[] = [];
  const verify = async (plaintext: string, hash: string) => {
    runs.push(plaintext);
    return hash === `hash:${plaintext}`;
  };
  return { runs, verify };
}

test("a re-check past the budget is refused without running the hash", async () => {
  const { runs, verify } = countingVerify();
  const user = "user-a";

  for (let i = 1; i <= BUDGET; i++) {
    assert.equal(await recheckOwnPassword(user, `guess ${i}`, HASH, verify), "wrong");
  }
  assert.equal(runs.length, BUDGET);

  // Refused even with the right password, and the hash doesn't run.
  assert.equal(await recheckOwnPassword(user, PASSWORD, HASH, verify), "limited");
  assert.equal(runs.length, BUDGET, "a refused re-check runs no hash");

  // Another person's budget is their own.
  assert.equal(await recheckOwnPassword("user-b", PASSWORD, HASH, verify), "ok");
});

test("the right password is charged too, as at sign-in", async () => {
  const { runs, verify } = countingVerify();
  for (let i = 1; i <= BUDGET; i++) {
    assert.equal(await recheckOwnPassword("user-c", PASSWORD, HASH, verify), "ok");
  }
  assert.equal(await recheckOwnPassword("user-c", PASSWORD, HASH, verify), "limited");
  assert.equal(runs.length, BUDGET);
});

test("one more re-check is let through every five minutes", async (t) => {
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.after(() => mock.timers.reset());
  const { runs, verify } = countingVerify();
  const user = "user-d";

  for (let i = 1; i <= BUDGET; i++) await recheckOwnPassword(user, "guess", HASH, verify);
  assert.equal(await recheckOwnPassword(user, PASSWORD, HASH, verify), "limited");

  mock.timers.tick(4 * 60 * 1000);
  assert.equal(await recheckOwnPassword(user, PASSWORD, HASH, verify), "limited");

  mock.timers.tick(60 * 1000);
  assert.equal(await recheckOwnPassword(user, PASSWORD, HASH, verify), "ok");
  assert.equal(await recheckOwnPassword(user, PASSWORD, HASH, verify), "limited");
  assert.equal(runs.length, BUDGET + 1);
});
