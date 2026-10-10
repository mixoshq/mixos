/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppMigrationStatus } from "./app-migrations";
import { readiness, type ReadinessChecks } from "./readiness";
import type { SchemaVersionStatus } from "./schema-version";

const schemaCurrent: SchemaVersionStatus = { ok: true, expected: 4242, actual: 4242 };
const schemaBehind: SchemaVersionStatus = {
  ok: false,
  expected: 4242,
  actual: 4241,
  message:
    "This build expects platform schema 4242, but the database is at 4241. Run the release step " +
    "against this database before serving traffic from this revision — `node ops/release.cjs` in " +
    "the image, `npm run release` from a checkout, or `npm run db:local` against the local stack.",
};
const schemaCantTell: SchemaVersionStatus = {
  ok: true,
  expected: 4242,
  actual: null,
  message: "Could not determine the database schema version (expects 4242).",
};
const appsCurrent: AppMigrationStatus = { ok: true, pending: [] };
const appsBehind: AppMigrationStatus = {
  ok: false,
  pending: [
    { slug: "notes", file: "0042_notes.sql" },
    { slug: "notes", file: "0043_tags.sql" },
  ],
  message:
    "This build carries 2 app migration(s) the database has not applied: " +
    "apps/notes/migrations/0042_notes.sql, apps/notes/migrations/0043_tags.sql.",
};

function checks(over: Partial<ReadinessChecks> = {}): ReadinessChecks {
  return {
    ping: async () => [{ "?column?": 1 }],
    schema: async () => schemaCurrent,
    apps: async () => appsCurrent,
    ...over,
  };
}

/** Run the probe, collecting what it logs instead of printing it. */
async function probe(c: ReadinessChecks) {
  const logged: string[] = [];
  const result = await readiness(c, {
    pingTimeoutMs: 5,
    log: (...args) => logged.push(args.map(String).join(" ")),
  });
  return { ...result, logged: logged.join("\n") };
}

const BRANCHES: [string, ReadinessChecks, number, object][] = [
  ["ready", checks(), 200, { status: "ok" }],
  ["can't tell the schema version", checks({ schema: async () => schemaCantTell }), 200, { status: "ok" }],
  [
    "database unreachable",
    checks({ ping: () => Promise.reject(new Error("connect ECONNREFUSED 10.0.0.5:5432")) }),
    503,
    { status: "unavailable" },
  ],
  ["database too slow", checks({ ping: () => new Promise(() => {}) }), 503, { status: "unavailable" }],
  [
    "platform schema behind",
    checks({ schema: async () => schemaBehind }),
    503,
    { status: "unavailable", reason: "schema-behind" },
  ],
  [
    "app migrations behind",
    checks({ apps: async () => appsBehind }),
    503,
    { status: "unavailable", reason: "app-migrations-behind" },
  ],
];

for (const [name, c, httpStatus, body] of BRANCHES) {
  test(`readiness, ${name}: ${httpStatus} with no numbers in the body`, async () => {
    const result = await probe(c);
    assert.equal(result.httpStatus, httpStatus);
    assert.deepEqual(result.body, body);
    assert.doesNotMatch(JSON.stringify(result.body), /\d/);
  });
}

test("the log names the versions and the release step, never db:push", async () => {
  const { logged } = await probe(checks({ schema: async () => schemaBehind }));
  assert.match(logged, /expects platform schema 4242, but the database is at 4241/);
  assert.match(logged, /node ops\/release\.cjs/);
  assert.match(logged, /npm run release/);
  assert.doesNotMatch(logged, /db:push/);
});

test("the log names the app migrations' files", async () => {
  const { logged } = await probe(checks({ apps: async () => appsBehind }));
  assert.match(logged, /apps\/notes\/migrations\/0042_notes\.sql/);
});

test("the log keeps the connection error out of the body", async () => {
  const { body, logged } = await probe(
    checks({ ping: () => Promise.reject(new Error("connect ECONNREFUSED 10.0.0.5:5432")) }),
  );
  assert.match(logged, /ECONNREFUSED/);
  assert.doesNotMatch(JSON.stringify(body), /ECONNREFUSED/);
});

test("app migrations aren't checked while the platform schema is behind", async () => {
  let asked = false;
  await probe(
    checks({
      schema: async () => schemaBehind,
      apps: async () => {
        asked = true;
        return appsCurrent;
      },
    }),
  );
  assert.equal(asked, false);
});
