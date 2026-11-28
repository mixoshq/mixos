/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { connectionUrlName, createPgClient, isSupabaseTransactionPooler } from "./pg-options";

const VARS = [
  "DATABASE_URL",
  "POSTGRES_URL",
  "PGSSLMODE",
  "PGHOST",
  "PGPORT",
  "PGUSER",
  "PGPASSWORD",
  "PGDATABASE",
] as const;

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

// postgres.js doesn't throw on these: it misreads them and would connect to
// the wrong host. createPgClient catches them, and says which variable.
for (const [problem, url, secret] of [
  ["a port that is not a number", "postgres://owner:S3cretPw@db.example.com:port/mixos", "S3cretPw"],
  ["an unencoded / in the password", "postgres://owner:S3cret/pw@db.example.com/mixos", "S3cret/pw"],
  ["an unencoded ? in the password", "postgres://owner:S3cret?pw@db.example.com/mixos", "S3cret?pw"],
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

// What postgres.js reads as written: no need to percent-encode these.
for (const [problem, password] of [
  ["an unencoded # in the password", "S3cret#pw"],
  ["an unencoded @ in the password", "S3cret@pw"],
  ["an unencoded : in the password", "S3cret:pw"],
  ["a % that starts no escape", "S3cret%zzPw"],
] as const) {
  test(`a connection string with ${problem} connects as written`, async () => {
    let client: ReturnType<typeof createPgClient> | undefined;
    withEnv({ DATABASE_URL: `postgres://owner:${password}@db.example.com:6543/mixos`, PGSSLMODE: "disable" }, () => {
      client = createPgClient();
    });
    assert.ok(client);
    assert.equal(client.options.pass, password);
    assert.deepEqual(client.options.host, ["db.example.com"]);
    assert.deepEqual(client.options.port, [6543]);
    assert.equal(client.options.database, "mixos");
    await client.end({ timeout: 0 });
  });
}

test("an IPv6 host and a host list are not taken for a misread port", async () => {
  for (const url of [
    "postgres://owner:pw@[::1]:5432/mixos",
    "postgres://owner:pw@db1.example.com:5432,db2.example.com:5433/mixos",
  ]) {
    let client: ReturnType<typeof createPgClient> | undefined;
    withEnv({ DATABASE_URL: url, PGSSLMODE: "disable" }, () => {
      client = createPgClient();
    });
    assert.ok(client, url);
    await client.end({ timeout: 0 });
  }
});

test("through Supabase's transaction pooler, each connection sends one query at a time", async () => {
  // Supavisor before 2.10 never answers pipelined queries in transaction mode.
  const POOLER = "aws-0-eu-west-1.pooler.supabase.com";
  for (const [url, pipeline] of [
    [`postgres://postgres.ref:pw@${POOLER}:6543/postgres`, 1],
    [`postgres://postgres.ref:pw@${POOLER.toUpperCase()}:6543/postgres`, 1],
    // Session mode, on the same host, is not affected.
    [`postgres://postgres.ref:pw@${POOLER}:5432/postgres`, 100],
    // Nor is a direct connection, or another host.
    ["postgres://postgres:pw@db.ref.supabase.co:5432/postgres", 100],
    ["postgres://owner:pw@ep-x.eu-west-2.aws.neon.tech/neondb", 100],
    ["postgres://u:pw@pooler.supabase.com.example.org:6543/db", 100],
    // One pooler among several hosts is enough.
    [`postgres://u:pw@db.example.com:5432,${POOLER}:6543/db`, 1],
  ] as const) {
    let client: ReturnType<typeof createPgClient> | undefined;
    withEnv({ DATABASE_URL: url, PGSSLMODE: "require" }, () => {
      client = createPgClient();
    });
    assert.ok(client);
    assert.equal(client.options.max_pipeline, pipeline, url);
    await client.end({ timeout: 0 });
  }

  // The discrete PG* settings, the same.
  let discrete: ReturnType<typeof createPgClient> | undefined;
  withEnv({ PGHOST: POOLER, PGPORT: "6543", PGUSER: "postgres.ref", PGPASSWORD: "pw", PGDATABASE: "postgres" }, () => {
    discrete = createPgClient();
  });
  assert.equal(discrete?.options.max_pipeline, 1);
  await discrete?.end({ timeout: 0 });

  // A caller that sets max_pipeline itself keeps it.
  let explicit: ReturnType<typeof createPgClient> | undefined;
  withEnv({ DATABASE_URL: `postgres://postgres.ref:pw@${POOLER}:6543/postgres` }, () => {
    explicit = createPgClient({ max_pipeline: 4 });
  });
  assert.equal(explicit?.options.max_pipeline, 4);
  await explicit?.end({ timeout: 0 });
});

test("isSupabaseTransactionPooler knows the pooler by its host and its port", () => {
  assert.equal(isSupabaseTransactionPooler("aws-0-us-east-1.pooler.supabase.com", 6543), true);
  assert.equal(isSupabaseTransactionPooler("aws-0-us-east-1.pooler.supabase.com.", 6543), true);
  assert.equal(isSupabaseTransactionPooler("aws-0-us-east-1.pooler.supabase.com", 5432), false);
  assert.equal(isSupabaseTransactionPooler("notpooler.supabase.com", 6543), false);
  assert.equal(isSupabaseTransactionPooler("pooler.supabase.com.evil.example", 6543), false);
  assert.equal(isSupabaseTransactionPooler("localhost", 6543), false);
});

test("the explicit ssl option wins over the URL's sslmode", async () => {
  // postgres.js 4 reads sslmode from the URL and PGSSLMODE from the
  // environment, but an ssl option comes first, and createPgClient always
  // passes one, from PGSSLMODE: TLS stays MixOS's decision.
  for (const [mode, expected] of [["disable", false], ["require", "require"], ["verify-full", "verify-full"]] as const) {
    let client: ReturnType<typeof createPgClient> | undefined;
    withEnv({ DATABASE_URL: "postgres://owner:pw@db.example.com/mixos?sslmode=disable", PGSSLMODE: mode }, () => {
      client = createPgClient();
    });
    assert.ok(client);
    assert.equal(client.options.ssl, expected, mode);
    await client.end({ timeout: 0 });
  }
});

test("connectionUrlName names the variable connectionUrl reads", () => {
  const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;
  assert.equal(connectionUrlName(env({ DATABASE_URL: "postgres://a", POSTGRES_URL: "postgres://b" })), "DATABASE_URL");
  assert.equal(connectionUrlName(env({ POSTGRES_URL: "postgres://b" })), "POSTGRES_URL");
  assert.equal(connectionUrlName(env({ PGHOST: "db.example.com" })), undefined);
  // An empty DATABASE_URL still shadows POSTGRES_URL, as it does in connectionUrl.
  assert.equal(connectionUrlName(env({ DATABASE_URL: "", POSTGRES_URL: "postgres://b" })), undefined);
});
