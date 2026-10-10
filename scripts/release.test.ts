/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The release step as it ships: scripts/release.ts bundled the way
 * `npm run build:ops` bundles it into the image, and run from a scratch
 * checkout. The bundle resolves everything from the directory above it, so a
 * scratch root holding the files a development checkout has (.env.docker,
 * .env.docker.local, .env.local) shows what the release step does with them,
 * without touching this checkout's own.
 *
 * The first group needs only Node: a stand-in Postgres that records how the
 * client opened the connection, then hangs up. The second needs a server it may
 * create and drop databases on, and is skipped otherwise:
 *
 *   docker run -d --name relpg -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test scripts/release.test.ts
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { buildSync } from "esbuild";
import postgres, { type Sql } from "postgres";
import { checkAppMigrations } from "../src/lib/platform/app-migrations";

const REPO = path.resolve(__dirname, "..");

// The bundle includes the generated app registry, which `npm run typecheck`,
// `npm run build` and `npm run registry` write. CI runs typecheck first.
const skipBundle = fs.existsSync(path.join(REPO, "src", "generated", "app-registry.ts"))
  ? false
  : "run `npm run registry` first: the release step bundles the generated app registry";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-release-"));
const BUNDLE = path.join(scratch, "release.cjs");
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

before(() => {
  if (skipBundle) return;
  buildSync({
    absWorkingDir: REPO,
    entryPoints: [path.join(REPO, "scripts", "release.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: BUNDLE,
    external: ["@apps/*"],
    logLevel: "silent",
  });
});

// What a development checkout holds: the committed .env.docker's values that
// matter here, and the file `npm run dev:docker` generates.
const DOCKER_STACK = {
  ".env.docker":
    "PGSSLMODE=disable\nINITIAL_ADMIN_EMAIL=admin@localhost\nINITIAL_ADMIN_PASSWORD=mixos-local-dev\n",
  ".env.docker.local": "DATABASE_URL=postgresql://postgres:postgres@host.docker.internal:54322/postgres\n",
};

let checkouts = 0;

/** A scratch checkout: the bundle at ops/release.cjs, plus `files`. */
function checkout(files: Record<string, string>, migrations?: string): string {
  const root = path.join(scratch, `checkout-${checkouts++}`);
  fs.mkdirSync(path.join(root, "ops"), { recursive: true });
  fs.copyFileSync(BUNDLE, path.join(root, "ops", "release.cjs"));
  const target = path.join(root, "supabase", "migrations");
  if (migrations) fs.cpSync(migrations, target, { recursive: true });
  else fs.mkdirSync(target, { recursive: true });
  for (const [rel, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), contents);
  }
  return root;
}

interface Run {
  code: number | null;
  output: string;
}

/** `node ops/release.cjs` in `root`, with exactly `env` and nothing from this shell. */
function release(root: string, env: Record<string, string>): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, "ops", "release.cjs")], {
      cwd: root,
      // Nothing from this shell. (ProcessEnv's type requires a NODE_ENV, which
      // nothing here reads.)
      env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv,
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

/**
 * Accepts connections and records how each one opened: a TLS request (the
 * SSLRequest code, 80877103) or a plaintext startup message. Then resets the
 * connection, which fails the client at once; a clean close would have
 * postgres.js reconnect until its own timeout.
 */
async function standInPostgres() {
  const openings: Array<"tls" | "plaintext"> = [];
  const server = net.createServer((socket) => {
    socket.once("data", (chunk) => {
      openings.push(chunk.length >= 8 && chunk.readInt32BE(4) === 80877103 ? "tls" : "plaintext");
      socket.resetAndDestroy();
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `postgres://mixos:secret@127.0.0.1:${port}/mixos`,
    openings,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("what the release step reads", { skip: skipBundle }, () => {
  for (const [layout, files] of [
    ["a booted local Docker stack", DOCKER_STACK],
    ["a host .env.local for the local database", { ".env.local": "PGSSLMODE=disable\n" }],
  ] as const) {
    test(`a database named in its environment is not paired with ${layout}`, async () => {
      const db = await standInPostgres();
      try {
        await release(checkout(files), { DATABASE_URL: db.url });
        // PGSSLMODE was not in the environment, so TLS is required. A plaintext
        // opening means a checkout file turned it off.
        assert.ok(db.openings.length > 0, "the release step never connected");
        assert.deepEqual([...new Set(db.openings)], ["tls"]);
      } finally {
        await db.close();
      }
    });
  }

  test("with no database in its environment it stops, rather than use a checkout's", async () => {
    const db = await standInPostgres();
    try {
      const root = checkout({
        ".env.local": `DATABASE_URL=${db.url}\nPGSSLMODE=disable\n`,
        ...DOCKER_STACK,
      });
      const run = await release(root, {});
      assert.equal(run.code, 1);
      assert.match(run.output, /DATABASE_URL/);
      assert.deepEqual(db.openings, [], "it connected to the database a checkout file named");
    } finally {
      await db.close();
    }
  });
});

// ── Against a real Postgres ─────────────────────────────────────────────────

const serverUrl = process.env.MIXOS_TEST_DATABASE_URL;
const skipDb =
  skipBundle || (serverUrl ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres");

describe("the release step against a real database", { skip: skipDb }, () => {
  const name = `mixos_release_${randomBytes(4).toString("hex")}`;
  let admin: Sql;
  let sql: Sql;
  let url: string;
  let root: string;

  before(async () => {
    admin = postgres(serverUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${name}`);
    const u = new URL(serverUrl!);
    u.pathname = `/${name}`;
    url = u.toString();
    sql = postgres(url, { max: 1, onnotice: () => {} });

    // A checkout of the development kind, with one app whose migration is not
    // idempotent and holds its transaction open for a moment, so two runners
    // that do not take turns are sure to collide on it.
    root = checkout(
      {
        ...DOCKER_STACK,
        "apps/fixture-app/migrations/001_items.sql":
          "create table items (id int primary key);\nselect pg_sleep(1);\ninsert into items (id) values (1);\n",
      },
      path.join(REPO, "supabase", "migrations"),
    );
  });

  after(async () => {
    await sql?.end();
    await admin?.unsafe(`drop database if exists ${name} with (force)`);
    await admin?.end();
  });

  const ITEMS = { slug: "fixture-app", file: "001_items.sql" };
  const BROKEN = { slug: "fixture-app", file: "002_broken.sql" };

  test("before any release step, readiness counts every app migration as pending", async () => {
    const status = await checkAppMigrations(sql, [ITEMS]);
    assert.equal(status.ok, false);
    assert.deepEqual(status.pending, [ITEMS]);
  });

  test("two at once both succeed, and apply each migration and the admin once", async () => {
    const env = {
      DATABASE_URL: url,
      PGSSLMODE: "disable",
      INITIAL_ADMIN_EMAIL: "owner@example.com",
      INITIAL_ADMIN_PASSWORD: randomBytes(12).toString("hex"),
    };
    const runs = await Promise.all([release(root, env), release(root, env)]);
    for (const run of runs) assert.equal(run.code, 0, run.output);

    const [ledger] = await sql`
      select count(*)::int as n from public._migrations where app_slug = 'fixture-app'
    `;
    const [items] = await sql`select count(*)::int as n from public._app_fixture_app_items`;
    const [owners] = await sql`
      select count(*)::int as n from public.users where email = 'owner@example.com'
    `;
    assert.deepEqual([ledger.n, items.n, owners.n], [1, 1, 1]);
    assert.deepEqual(await checkAppMigrations(sql, [ITEMS]), { ok: true, pending: [] });
  });

  test("an app migration that fails leaves readiness refusing the build", async () => {
    fs.writeFileSync(
      path.join(root, "apps", "fixture-app", "migrations", BROKEN.file),
      "alter table items add column total numeric not a type;\n",
    );
    try {
      const run = await release(root, { DATABASE_URL: url, PGSSLMODE: "disable" });
      assert.equal(run.code, 1, run.output);
      const status = await checkAppMigrations(sql, [ITEMS, BROKEN]);
      assert.equal(status.ok, false);
      assert.deepEqual(status.pending, [BROKEN]);
    } finally {
      fs.rmSync(path.join(root, "apps", "fixture-app", "migrations", BROKEN.file));
    }
  });

  test("it creates no account the environment did not ask for", async () => {
    const run = await release(root, { DATABASE_URL: url, PGSSLMODE: "disable" });
    assert.equal(run.code, 0, run.output);
    const rows = await sql`select email from public.users where email = 'admin@localhost'`;
    assert.equal(rows.length, 0, "the committed local admin login was created");
  });
});
