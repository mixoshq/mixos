/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type { AppMigrationStatus } from "./app-migrations";
import {
  APP_UPDATING_MESSAGE,
  appMaintenanceGate,
  appPagePath,
  cachedMaintenanceState,
  maintenanceGate,
  maintenanceStateOf,
  type AppPagePath,
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

/** One turn of the event loop, with the mocked clock left where it is. */
const turn = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Move the mocked clock on `ms`, a millisecond at a time, with a turn of the
 * event loop before each step and after the last, so whatever a timer sets off
 * has run before the clock moves again.
 */
async function elapse(ms: number): Promise<void> {
  for (let i = 0; i < ms; i++) {
    await turn();
    mock.timers.tick(1);
  }
  await turn();
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

test("a check that answers late is kept once it does", async (t) => {
  // On the mocked clock the read answers at 30 ms, after both requests' 5 ms
  // waits, however busy the machine is. Date is mocked too, so the kept
  // answer's age is measured on the same clock.
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.after(() => mock.timers.reset());
  let reads = 0;
  const state = cachedMaintenanceState(
    () => {
      reads++;
      return new Promise<MaintenanceState>((resolve) => setTimeout(() => resolve(BEHIND), 30));
    },
    { waitMs: 5 },
  );
  // Each request's status once it is answered, null for served as usual. The
  // test checks this list instead of awaiting a request: awaiting one that is
  // still waiting when the clock stops would hang the test, not fail it.
  const answered: (number | null)[] = [];
  const request = () => {
    void maintenanceGate("/", state).then((res) => answered.push(res?.status ?? null));
  };

  // The first request doesn't wait for it...
  request();
  await elapse(5);
  assert.deepEqual(answered, [null]);
  // ...a request while it is still running waits on the same read...
  request();
  await elapse(5);
  assert.deepEqual(answered, [null, null]);
  // ...and once it has answered, that answer is the one kept: the next request
  // has it without the clock moving.
  await elapse(30);
  request();
  await turn();
  assert.deepEqual(answered, [null, null, 503]);
  assert.equal(reads, 1);
});

// ── one app being updated ───────────────────────────────────────────────────

const NOTES_BEHIND = maintenanceStateOf(schemaCurrent, appsBehind);

/** The app gate's answer for a page, recording what it was asked. */
function gateFor(updating: (page: AppPagePath) => boolean) {
  const asked: AppPagePath[] = [];
  return {
    asked,
    updating: async (page: AppPagePath) => {
      asked.push(page);
      return updating(page);
    },
  };
}

test("an app's pages are found under /apps and /p, with the page's key", () => {
  assert.deepEqual(appPagePath("/apps/notes"), { surface: "apps", slug: "notes", pageKey: "" });
  assert.deepEqual(appPagePath("/apps/notes/"), { surface: "apps", slug: "notes", pageKey: "" });
  assert.deepEqual(appPagePath("/apps/notes/settings/advanced"), {
    surface: "apps",
    slug: "notes",
    pageKey: "settings/advanced",
  });
  assert.deepEqual(appPagePath("/p/notes"), { surface: "p", slug: "notes", pageKey: "" });
  assert.deepEqual(appPagePath("/p/notes/report%20one"), {
    surface: "p",
    slug: "notes",
    pageKey: "report one",
  });
});

test("nothing else is an app page: the gateway answers for API routes", () => {
  for (const path of [
    "/",
    "/apps",
    "/apps/",
    "/p",
    "/p/",
    "/api/apps/notes/items",
    "/api/p/notes",
    "/admin/apps",
    "/login",
    "/p/notes/%E0%A4%A",
  ]) {
    assert.equal(appPagePath(path), null, path);
  }
});

test("an app being updated: its page gets a static 503 page, Retry-After, no numbers", async () => {
  for (const path of ["/apps/notes", "/apps/notes/settings", "/p/notes", "/p/notes/report"]) {
    const res = await appMaintenanceGate(path, always(NOTES_BEHIND), gateFor(() => true).updating);
    assert.ok(res, path);
    assert.equal(res.status, 503, path);
    assert.equal(res.headers.get("retry-after"), "30", path);
    assert.equal(res.headers.get("cache-control"), "no-store", path);
    assert.match(res.headers.get("content-type") ?? "", /^text\/html/, path);
    assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'/, path);

    const body = await res.text();
    assert.match(body, /<title>Being updated<\/title>/, path);
    assert.ok(body.includes(APP_UPDATING_MESSAGE), path);
    assert.doesNotMatch(body.replace(/<\/?h1>/g, ""), /\d/, path);
    assert.doesNotMatch(body, /<script/i, path);
    const lower = body.toLowerCase();
    for (const word of ["migration", "release", "schema", "version", "npm", "notes", ".sql"]) {
      assert.ok(!lower.includes(word), `${path} says "${word}"`);
    }
  }
});

test("the gate is asked only for an app that is behind, with the page it addresses", async () => {
  const { asked, updating } = gateFor(() => true);
  await appMaintenanceGate("/p/notes/report", always(NOTES_BEHIND), updating);
  assert.deepEqual(asked, [{ surface: "p", slug: "notes", pageKey: "report" }]);

  // Another app's pages are decided from the kept answer alone: no query.
  const other = gateFor(() => true);
  for (const path of ["/apps/tasks", "/p/tasks", "/apps/tasks/board"]) {
    assert.equal(await appMaintenanceGate(path, always(NOTES_BEHIND), other.updating), null, path);
  }
  assert.deepEqual(other.asked, []);
});

test("a page the gate doesn't hold back for the update is served as usual", async () => {
  // A switched-off app's page, or a public page its manifest doesn't open:
  // the page route answers those as it always has.
  const { updating } = gateFor(() => false);
  for (const path of ["/apps/notes", "/p/notes", "/p/notes/admin"]) {
    assert.equal(await appMaintenanceGate(path, always(NOTES_BEHIND), updating), null, path);
  }
});

test("an app's API routes, and every other path, are not the proxy's to answer", async () => {
  const { asked, updating } = gateFor(() => true);
  let read = 0;
  const state = async () => {
    read++;
    return NOTES_BEHIND;
  };
  for (const path of [...APIS, "/", "/login", "/admin/apps", "/apps", "/api/p/notes/items"]) {
    assert.equal(await appMaintenanceGate(path, state, updating), null, path);
  }
  assert.equal(read, 0, "a path that isn't an app page read the state");
  assert.deepEqual(asked, []);
});

test("can't tell serves an app's pages", async () => {
  const { asked, updating } = gateFor(() => true);
  const cantTell = maintenanceStateOf(schemaCantTell, appsCantTell);
  const failing = cachedMaintenanceState(async () => {
    throw new Error("connect ECONNREFUSED");
  });
  const silent = cachedMaintenanceState(() => new Promise<MaintenanceState>(() => {}), { waitMs: 5 });
  for (const state of [always(cantTell), failing, silent]) {
    assert.equal(await appMaintenanceGate("/p/notes", state, updating), null);
  }
  assert.deepEqual(asked, []);
});

test("two copies kept in one store share one answer and one read", async () => {
  // The proxy and the routes are bundled apart, each with its own copy of the
  // module: one store per process keeps them agreeing.
  const store = {};
  let reads = 0;
  const read = async () => {
    reads++;
    return NOTES_BEHIND;
  };
  const proxyCopy = cachedMaintenanceState(read, { store });
  const routeCopy = cachedMaintenanceState(read, { store });

  const [a, b] = await Promise.all([proxyCopy(), routeCopy()]);
  assert.equal(reads, 1);
  assert.deepEqual([...a.appsBehind], ["notes"]);
  assert.equal(b, a);
  assert.equal(await routeCopy(), a);
  assert.equal(reads, 1);
});
