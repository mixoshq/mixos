/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shared half of `npm run dev:docker`, `npm run dev` and `npm run status`:
 * reading who holds a port out of lsof, ss and docker, choosing the next one,
 * finding a checkout's own database, and asking a running app whether it is
 * up — against a stub server that answers the way MixOS does.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { parseDevArgs } from "./dev";
import {
  type Fixes,
  ROOT,
  allOk,
  checkApp,
  configuredDatabase,
  describeHolder,
  formatSummary,
  isMixosCheckout,
  nextFreePort,
  parseDockerRows,
  parseLsofListeners,
  parseSsListeners,
  publishedPort,
} from "./local-stack";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-local-stack-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

test("lsof -F output becomes one listener per process and port", () => {
  const out = [
    "p501",
    "cnext-server (v16.4.3)",
    "f20",
    "n*:3000",
    "f21",
    "n[::1]:3000",
    "p77",
    "cRaycast Backend",
    "f9",
    "n127.0.0.1:7265",
  ].join("\n");
  assert.deepEqual(parseLsofListeners(out), [
    { pid: 501, command: "next-server (v16.4.3)", port: 3000 },
    { pid: 77, command: "Raycast Backend", port: 7265 },
  ]);
});

test("ss -Hltnp output becomes listeners, and lines without a process are skipped", () => {
  const out = [
    'LISTEN 0      511          *:3000       *:*    users:(("next-server (v1",pid=4242,fd=20))',
    "LISTEN 0      4096   127.0.0.1:5432  0.0.0.0:*",
  ].join("\n");
  assert.deepEqual(parseSsListeners(out), [{ pid: 4242, command: "next-server (v1", port: 3000 }]);
});

test("docker ps rows keep compose's labels, and the published app port is read from them", () => {
  const out =
    "mixos-dev-app-dev-1\tmixos-dev\tapp-dev\t/Users/me/mixos-dev\t127.0.0.1:3001->3000/tcp\n" +
    "supabase_studio_mixos\t\t\t\t0.0.0.0:54323->3000/tcp\n";
  const rows = parseDockerRows(out);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    name: "mixos-dev-app-dev-1",
    project: "mixos-dev",
    service: "app-dev",
    workingDir: "/Users/me/mixos-dev",
    ports: "127.0.0.1:3001->3000/tcp",
  });
  assert.equal(publishedPort(rows[0].ports), 3001);
  assert.equal(publishedPort("5432/tcp"), null);
});

test("the next free port skips every busy one after the first", async () => {
  const busy = new Set([3000, 3001, 3002]);
  assert.equal(await nextFreePort(3000, async (p) => busy.has(p)), 3003);
  assert.equal(await nextFreePort(3000, async () => true), null);
});

test("a checkout is MixOS by what it contains", () => {
  assert.equal(isMixosCheckout(ROOT), true);
  assert.equal(isMixosCheckout(scratch), false);
  assert.equal(isMixosCheckout(null), false);
});

test("a holder reads as the subject of a sentence", () => {
  assert.equal(
    describeHolder({ kind: "mixos", instance: "mixos-dev", detail: "in Docker, from ~/mixos-dev", checkout: null }),
    "MixOS instance `mixos-dev` (in Docker, from ~/mixos-dev)",
  );
  assert.equal(describeHolder({ kind: "this-checkout", pid: 12 }), "this checkout's own `npm run dev` (pid 12)");
  assert.equal(describeHolder({ kind: "other", label: "Elgato (pid 9)" }), "Elgato (pid 9)");
});

test("a checkout's own database comes from the shell or a file Next reads, and nowhere else", () => {
  const saved = { DATABASE_URL: process.env.DATABASE_URL, POSTGRES_URL: process.env.POSTGRES_URL, PGHOST: process.env.PGHOST };
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
  delete process.env.PGHOST;
  try {
    const root = fs.mkdtempSync(path.join(scratch, "checkout-"));
    assert.equal(configuredDatabase(root), null);

    // .env.docker is not a file Next reads, so its database is not "own".
    fs.writeFileSync(path.join(root, ".env.docker"), "DATABASE_URL=postgresql://x@h.docker.internal/db\n");
    assert.equal(configuredDatabase(root), null);

    fs.writeFileSync(path.join(root, ".env.local"), "AUTH_SECRET=x\n");
    assert.equal(configuredDatabase(root), null, "a .env.local without a database names none");

    fs.writeFileSync(path.join(root, ".env"), "PGHOST=localhost\n");
    assert.equal(configuredDatabase(root), ".env");

    process.env.DATABASE_URL = "postgresql://elsewhere/db";
    assert.equal(configuredDatabase(root), "the shell environment");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("--port and -p are this script's; everything else goes to Next", () => {
  assert.deepEqual(parseDevArgs(["-p", "4000", "--turbopack"]), { port: 4000, noOpen: false, rest: ["--turbopack"] });
  assert.deepEqual(parseDevArgs(["--port=4001", "--no-open"]), { port: 4001, noOpen: true, rest: [] });
  assert.deepEqual(parseDevArgs(["-H", "0.0.0.0"]), { port: null, noOpen: false, rest: ["-H", "0.0.0.0"] });
  assert.throws(() => parseDevArgs(["-p", "lots"]), /wants a port number/);
});

// ── checkApp, against a stub that answers like MixOS ──

const FIXES: Fixes = { notRunning: "start it", noDatabase: "fix the database", schemaBehind: "migrate" };

/** A server that answers /api/health/live, /ready and /login as told. */
async function stub(ready: { status: number; body: object }) {
  const server = http.createServer((req, res) => {
    const send = (status: number, body: object) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/api/health/live") return send(200, { status: "ok" });
    if (req.url === "/api/health/ready") return send(ready.status, ready.body);
    if (req.url === "/login") return send(200, {});
    send(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

test("an app that answers, queries and renders sign-in is up, with the login on the sign-in line", async () => {
  const app = await stub({ status: 200, body: { status: "ok" } });
  try {
    const checks = await checkApp(app.url, { fixes: FIXES, signIn: { email: "a@b", password: "pw" } });
    assert.equal(allOk(checks), true);
    assert.deepEqual(
      checks.map((check) => check.name),
      ["Web server", "Database", "Sign-in"],
    );
    assert.deepEqual(checks[2].lines, [`${app.url}/login`, "a@b / pw"]);
  } finally {
    await app.close();
  }
});

test("a 503 with no reason is the database itself, and sign-in waits for it", async () => {
  const app = await stub({ status: 503, body: { status: "unavailable" } });
  try {
    const checks = await checkApp(app.url, { fixes: FIXES });
    assert.equal(checks[1].state, "fail");
    assert.equal(checks[1].fix, "fix the database");
    assert.equal(checks[2].state, "skip");
  } finally {
    await app.close();
  }
});

test("a schema behind this code gets the migration fix, not the connection one", async () => {
  const app = await stub({ status: 503, body: { status: "unavailable", reason: "schema-behind" } });
  try {
    const checks = await checkApp(app.url, { fixes: FIXES });
    assert.equal(checks[1].fix, "migrate");
  } finally {
    await app.close();
  }
});

test("nothing listening is a web server failure, and nothing after it is asked", async () => {
  const app = await stub({ status: 200, body: {} });
  const url = app.url;
  await app.close();
  const checks = await checkApp(url, { fixes: FIXES });
  assert.deepEqual(
    checks.map((check) => check.state),
    ["fail", "skip", "skip"],
  );
  assert.equal(checks[0].fix, "start it");
});

test("the summary says up or not in its first line, and puts each fix under its failure", () => {
  const text = formatSummary({
    headline: "MixOS is up at http://localhost:3000",
    checks: [
      { state: "ok", name: "Web server", lines: ["http://localhost:3000"] },
      { state: "fail", name: "Database", lines: ["the app can't reach its database"], fix: "fix the database" },
    ],
    notes: ["a note"],
  });
  const lines = text.split("\n");
  assert.match(lines.find((l) => l.includes("MixOS is up"))!, /✗/, "any failure makes the headline a ✗");
  const db = lines.findIndex((l) => l.includes("Database"));
  assert.match(lines[db], /✗ Database {5}the app can't reach its database/);
  assert.match(lines[db + 1], /→ fix the database/);
  assert.ok(lines.some((l) => l.includes("✓ Web server")));
});
