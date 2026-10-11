/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createCredentialsAuthorize, type CredentialsAccount } from "./config";
import { DUMMY_PASSWORD_HASH } from "./password";

// No database: the sign-in limit's Postgres charge throws and it falls back to
// its in-memory bucket (src/lib/rate-limit.ts). Each attempt below comes from
// an address of its own, so the limit never refuses one.
(globalThis as { __pg?: unknown }).__pg = () => {
  throw new Error("no database in this test");
};
const warn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  if (String(args[0]).startsWith("[rate-limit] postgres unavailable")) return;
  warn(...args);
};

const PASSWORD = "the right password";
const ACCOUNT: CredentialsAccount = {
  id: "8f6c1d0e-0000-4000-8000-000000000001",
  email: "ada@example.test",
  display_name: "Ada",
  password_hash: `hash:${PASSWORD}`,
};
/** An account with no password, as `password_hash` allows. */
const NO_PASSWORD: CredentialsAccount = {
  id: "8f6c1d0e-0000-4000-8000-000000000002",
  email: "grace@example.test",
  display_name: "Grace",
  password_hash: null,
};

/** A password check that records every hash it is asked to compare against. */
function countingCheck(matches: (plaintext: string, hash: string) => boolean) {
  const hashes: string[] = [];
  return {
    hashes,
    check: {
      async findAccount(email: string) {
        return [ACCOUNT, NO_PASSWORD].find((a) => a.email === email) ?? null;
      },
      async verifyPassword(plaintext: string, hash: string) {
        hashes.push(hash);
        return matches(plaintext, hash);
      },
    },
  };
}

let host = 0;
function fresh(): Request {
  host += 1;
  return new Request("http://localhost:3000/api/auth/callback/credentials", {
    method: "POST",
    headers: { "x-forwarded-for": `192.0.2.${host}` },
  });
}

test("a wrong password costs one hash, whether or not the email has an account", async () => {
  const { hashes, check } = countingCheck((p, h) => h === `hash:${p}`);
  const authorize = createCredentialsAuthorize(check);

  const hashesFor = async (email: string) => {
    hashes.length = 0;
    assert.equal(await authorize({ email, password: "wrong" }, fresh()), null);
    return [...hashes];
  };

  assert.deepEqual(await hashesFor(ACCOUNT.email), [ACCOUNT.password_hash]);
  assert.deepEqual(await hashesFor("nobody@example.test"), [DUMMY_PASSWORD_HASH]);
  assert.deepEqual(await hashesFor(NO_PASSWORD.email), [DUMMY_PASSWORD_HASH]);
});

test("the dummy hash never signs anyone in, even if it matched", async () => {
  // A check that says yes to everything: the answer is still no.
  const { hashes, check } = countingCheck(() => true);
  const authorize = createCredentialsAuthorize(check);
  assert.equal(await authorize({ email: "nobody@example.test", password: "x" }, fresh()), null);
  assert.equal(await authorize({ email: NO_PASSWORD.email, password: "x" }, fresh()), null);
  assert.deepEqual(hashes, [DUMMY_PASSWORD_HASH, DUMMY_PASSWORD_HASH]);
});

test("the right password still signs in, with one hash", async () => {
  const { hashes, check } = countingCheck((p, h) => h === `hash:${p}`);
  const authorize = createCredentialsAuthorize(check);
  const user = await authorize({ email: ` ${ACCOUNT.email.toUpperCase()} `, password: PASSWORD }, fresh());
  assert.deepEqual(user, { id: ACCOUNT.id, email: ACCOUNT.email, name: "Ada" });
  assert.deepEqual(hashes, [ACCOUNT.password_hash]);
});
