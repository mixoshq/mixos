/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { connectionUrlName, createPgClient } from "./pg-options";

const VARS = ["DATABASE_URL", "POSTGRES_URL", "PGSSLMODE"] as const;

/** Run `fn` with exactly `vars` set among VARS; process.env is restored after. */
function withEnv(vars: Partial<Record<(typeof VARS)[number], string>>, fn: () => void) {
  const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  try {
    for (const k of VARS) delete process.env[k];
    Object.assign(process.env, vars);
    fn();
  } finally {
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

for (const [problem, url, secret] of [
  ["an unencoded # in the password", "postgres://owner:S3cret#pw@db.example.com/mixos", "S3cret#pw"],
  ["a port that is not a number", "postgres://owner:S3cretPw@db.example.com:port/mixos", "S3cretPw"],
  ["a malformed percent-escape", "postgres://owner:S3cret%zzPw@db.example.com/mixos", "S3cret%zzPw"],
] as const) {
  test(`a connection string with ${problem} is reported by name, never printed`, () => {
    for (const name of ["DATABASE_URL", "POSTGRES_URL"] as const) {
      withEnv({ [name]: url }, () => {
        let thrown: unknown;
        assert.throws(() => {
          try {
            createPgClient();
          } catch (err) {
            thrown = err;
            throw err;
          }
        });
        // What `console.error("...", err)` prints: the stack, own properties and
        // any cause.
        const printed = inspect(thrown, { depth: 5 });
        assert.ok(!printed.includes(secret), `the password was in:\n${printed}`);
        assert.ok(!printed.includes("db.example.com"), `the connection string was in:\n${printed}`);
        assert.match(printed, new RegExp(`${name} is not a valid connection URL`));
      });
    }
  });
}

test("connectionUrlName names the variable connectionUrl reads", () => {
  const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;
  assert.equal(connectionUrlName(env({ DATABASE_URL: "postgres://a", POSTGRES_URL: "postgres://b" })), "DATABASE_URL");
  assert.equal(connectionUrlName(env({ POSTGRES_URL: "postgres://b" })), "POSTGRES_URL");
  assert.equal(connectionUrlName(env({ PGHOST: "db.example.com" })), undefined);
  // An empty DATABASE_URL still shadows POSTGRES_URL, as it does in connectionUrl.
  assert.equal(connectionUrlName(env({ DATABASE_URL: "", POSTGRES_URL: "postgres://b" })), undefined);
});
