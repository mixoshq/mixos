/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import {
  BCRYPT_ROUNDS,
  DUMMY_PASSWORD_HASH,
  hashPassword,
  verifyPassword,
} from "./password";

// Sign-in compares against the dummy hash when an email has no account, so
// that answer costs what a wrong password costs. It does only while the dummy
// is the same kind of hash as a real one: same cost, same format.
test("the dummy hash has the cost and format hashPassword() produces", async () => {
  const real = await hashPassword("a password for this test");
  assert.equal(bcrypt.getRounds(DUMMY_PASSWORD_HASH), BCRYPT_ROUNDS);
  assert.equal(bcrypt.getRounds(real), BCRYPT_ROUNDS);
  assert.equal(DUMMY_PASSWORD_HASH.slice(0, 7), real.slice(0, 7), "`$2a$` and the cost");
  assert.equal(DUMMY_PASSWORD_HASH.length, real.length);
});

test("the dummy hash checks without error and matches none of these", async () => {
  for (const attempt of ["", "password", "a password for this test"]) {
    assert.equal(await verifyPassword(attempt, DUMMY_PASSWORD_HASH), false);
  }
});
