/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { describeDatabase, isLocalDatabaseHost } from "./locality";

test("loopback, a Unix socket and host.docker.internal are local", () => {
  for (const host of [
    "localhost",
    "LOCALHOST",
    "localhost.",
    "127.0.0.1",
    "127.1.2.3",
    "::1",
    "[::1]",
    "0:0:0:0:0:0:0:1",
    "::ffff:127.0.0.1",
    "host.docker.internal",
    "/var/run/postgresql",
    "/tmp",
  ]) {
    assert.equal(isLocalDatabaseHost(host), true, host);
  }
});

test("anything else is shared, a name that may resolve here included", () => {
  for (const host of [
    "",
    " ",
    "db",
    "postgres",
    "db.example.com",
    "aws-0-eu-west-1.pooler.supabase.com",
    "10.0.0.5",
    "192.168.65.254",
    "0.0.0.0",
    "128.0.0.1",
    "127.0.0.256",
    "localhost.example.com",
    "mylocalhost",
    "host.docker.internal.example.com",
    "[",
  ]) {
    assert.equal(isLocalDatabaseHost(host), false, JSON.stringify(host));
  }
});

test("every host a connection may use has to be local", () => {
  assert.deepEqual(describeDatabase({ host: ["127.0.0.1"] }), { hosts: ["127.0.0.1"], local: true });
  assert.deepEqual(describeDatabase({ host: ["127.0.0.1", "db.example.com"] }), {
    hosts: ["127.0.0.1", "db.example.com"],
    local: false,
  });
  assert.deepEqual(describeDatabase({ host: [] }), { hosts: [], local: false });
  assert.deepEqual(describeDatabase({}), { hosts: [], local: false });
  // A socket path postgres.js was handed directly.
  assert.equal(describeDatabase({ host: [], path: "/tmp/.s.PGSQL.5432" }).local, true);
});

// What postgres.js itself makes of the settings this server reads, so the
// decision follows the pool rather than a second parse of the URL.
const pools: postgres.Sql[] = [];
after(async () => {
  await Promise.all(pools.map((p) => p.end({ timeout: 0 })));
});
const optionsOf = (url: string) => {
  const pool = postgres(url, { max: 1 });
  pools.push(pool);
  return pool.options;
};

test("the pool's own options decide it", () => {
  assert.equal(describeDatabase(optionsOf("postgres://u:p@127.0.0.1:54322/postgres")).local, true);
  assert.equal(describeDatabase(optionsOf("postgres://u:p@localhost/mixos")).local, true);
  assert.equal(
    describeDatabase(optionsOf("postgresql://postgres:postgres@host.docker.internal:54322/postgres")).local,
    true,
  );
  const shared = describeDatabase(optionsOf("postgres://u:secret@db.example.com:6543/mixos"));
  assert.deepEqual(shared, { hosts: ["db.example.com"], local: false });
  // Names only: never the password or the database.
  assert.ok(!JSON.stringify(shared).includes("secret"));
  assert.equal(
    describeDatabase(optionsOf("postgres://u:p@127.0.0.1:5432,db.example.com:5432/mixos")).local,
    false,
  );
});
