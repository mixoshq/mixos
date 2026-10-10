/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppMigrationStatus } from "./app-migrations";
import {
  cachedMaintenanceState,
  maintenanceGate,
  maintenanceStateOf,
  type MaintenanceState,
} from "./maintenance-gate";
import type { SchemaVersionStatus } from "./schema-version";

// The checks' own answers, numbers and file names included, so a test can see
// that none of it reaches a response.
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
  message:
    "Could not determine the database schema version, so it was not checked against this build " +
    "(expects 4242). connect ECONNREFUSED 127.0.0.1:5432",
};
const schemaCurrent: SchemaVersionStatus = { ok: true, expected: 4242, actual: 4242 };
const appsCurrent: AppMigrationStatus = { ok: true, pending: [] };
const appsBehind: AppMigrationStatus = {
  ok: false,
  pending: [{ slug: "notes", file: "0042_notes.sql" }],
  message: "This build carries 1 app migration(s) the database has not applied: apps/notes/migrations/0042_notes.sql.",
};
const appsCantTell: AppMigrationStatus = {
  ok: true,
  pending: [],
  message: "Could not read public._migrations, so app migrations were not checked against this build.",
};

const BEHIND = maintenanceStateOf(schemaBehind, appsCurrent);

function always(state: MaintenanceState) {
  return async () => state;
}

/** A page, an app's API, and the three non-browser callers the instance has. */
const PAGES = ["/", "/login", "/admin/apps", "/p/notes", "/manifest.webmanifest"];
const APIS = [
  "/api/apps/notes/items",
  "/api/cron",
  "/api/webhooks/github",
  "/api/mcp",
  "/api/auth/session",
  "/.well-known/oauth-protected-resource",
];

test("the platform schema behind is the whole instance, whatever the apps say", () => {
  assert.equal(maintenanceStateOf(schemaBehind, appsCurrent).platformBehind, true);
  assert.equal(maintenanceStateOf(schemaBehind, appsBehind).platformBehind, true);
});

test("a page gets a static maintenance page: 503, Retry-After, no numbers", async () => {
  for (const path of PAGES) {
    const res = await maintenanceGate(path, always(BEHIND));
    assert.ok(res, path);
    assert.equal(res.status, 503, path);
    assert.equal(res.headers.get("retry-after"), "30", path);
    assert.equal(res.headers.get("cache-control"), "no-store", path);
    assert.match(res.headers.get("content-type") ?? "", /^text\/html/, path);
    // Nothing on the page may run.
    assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'/, path);

    const body = await res.text();
    assert.match(body, /<title>Down for maintenance<\/title>/, path);
    assert.match(body, /This instance is being updated/, path);
    // Not a digit anywhere, text, attributes and style included, but for the
    // name of the heading tag.
    assert.doesNotMatch(body.replace(/<\/?h1>/g, ""), /\d/, path);
    assert.doesNotMatch(body, /<script/i, path);
  }
});

test("an API route gets JSON: 503, Retry-After, no numbers", async () => {
  for (const path of APIS) {
    const res = await maintenanceGate(path, always(BEHIND));
    assert.ok(res, path);
    assert.equal(res.status, 503, path);
    assert.equal(res.headers.get("retry-after"), "30", path);
    assert.equal(res.headers.get("cache-control"), "no-store", path);
    assert.match(res.headers.get("content-type") ?? "", /^application\/json/, path);

    const text = await res.text();
    assert.doesNotMatch(text, /\d/, path);
    assert.deepEqual(JSON.parse(text), { error: "This instance is being updated. Try again shortly." });
  }
});

test("neither body tells a visitor what to run, or about the schema", async () => {
  for (const path of ["/", "/api/cron"]) {
    const res = await maintenanceGate(path, always(BEHIND));
    const body = (await res!.text()).toLowerCase();
    for (const word of ["schema", "version", "migration", "release", "npm", "ops/", "db:push", "db:local"]) {
      assert.ok(!body.includes(word), `${path} says "${word}"`);
    }
  }
});

test("the health probes are exempt, and never wait on the check", async () => {
  let asked = 0;
  const state = async () => {
    asked++;
    return BEHIND;
  };
  assert.equal(await maintenanceGate("/api/health/live", state), null);
  assert.equal(await maintenanceGate("/api/health/ready", state), null);
  assert.equal(asked, 0);

  // Only those two paths: their neighbours get the maintenance response.
  for (const path of ["/api/health", "/api/health/other", "/api/health/live/x"]) {
    assert.equal((await maintenanceGate(path, state))?.status, 503, path);
  }
});

test("can't tell serves normally", async () => {
  const cantTell = maintenanceStateOf(schemaCantTell, appsCantTell);
  assert.equal(cantTell.platformBehind, false);
  assert.equal(cantTell.appsBehind.size, 0);
  assert.equal(await maintenanceGate("/", always(cantTell)), null);
});

test("a check that fails, or doesn't answer in time, counts as can't tell", async () => {
  const failing = cachedMaintenanceState(async () => {
    throw new Error("connect ECONNREFUSED");
  });
  assert.equal(await maintenanceGate("/", failing), null);

  const throwing = cachedMaintenanceState(() => {
    throw new Error("thrown before a promise");
  });
  assert.equal(await maintenanceGate("/", throwing), null);

  const silent = cachedMaintenanceState(() => new Promise<MaintenanceState>(() => {}), { waitMs: 5 });
  assert.equal(await maintenanceGate("/", silent), null);
});

test("app migrations behind alone serve normally", async () => {
  const state = maintenanceStateOf(schemaCurrent, appsBehind);
  assert.equal(state.platformBehind, false);
  assert.deepEqual([...state.appsBehind], ["notes"]);
  for (const path of [...PAGES, ...APIS]) {
    assert.equal(await maintenanceGate(path, always(state)), null, path);
  }
});

test("an answer is kept for 15 seconds", async () => {
  let reads = 0;
  let clock = 1_000_000;
  const state = cachedMaintenanceState(
    async () => {
      reads++;
      return BEHIND;
    },
    { now: () => clock },
  );

  assert.equal((await state()).platformBehind, true);
  assert.equal(reads, 1);

  clock += 14_999;
  assert.equal((await state()).platformBehind, true);
  assert.equal(reads, 1, "a second call inside the window read again");

  clock += 1;
  await state();
  assert.equal(reads, 2, "a call after the window didn't read");
});

test("a failed check is kept too, so a database that is down isn't asked per request", async () => {
  let reads = 0;
  const state = cachedMaintenanceState(async () => {
    reads++;
    throw new Error("connect ECONNREFUSED");
  });
  await state();
  await state();
  assert.equal(reads, 1);
});

test("requests that arrive together share one check", async () => {
  let reads = 0;
  let answer!: (state: MaintenanceState) => void;
  const state = cachedMaintenanceState(() => {
    reads++;
    return new Promise<MaintenanceState>((resolve) => {
      answer = resolve;
    });
  });

  const together = Promise.all([state(), state(), state()]);
  await new Promise((resolve) => setImmediate(resolve));
  answer(BEHIND);
  const answers = await together;

  assert.equal(reads, 1);
  assert.ok(answers.every((a) => a.platformBehind));
});

test("a check that answers late is kept once it does", async () => {
  let reads = 0;
  const state = cachedMaintenanceState(
    () => {
      reads++;
      return new Promise<MaintenanceState>((resolve) => setTimeout(() => resolve(BEHIND), 30));
    },
    { waitMs: 5 },
  );

  // The first request doesn't wait for it...
  assert.equal(await maintenanceGate("/", state), null);
  // ...a request while it is still running waits on the same read...
  assert.equal(await maintenanceGate("/", state), null);
  await new Promise((resolve) => setTimeout(resolve, 40));
  // ...and once it has answered, that answer is the one kept.
  assert.equal((await maintenanceGate("/", state))?.status, 503);
  assert.equal(reads, 1);
});
