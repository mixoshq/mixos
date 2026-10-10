/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnv } from "./load-env";

// ── fixtures ────────────────────────────────────────────────────────────────

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-load-env-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;

/** A checkout holding `files`, relative path → contents. */
function checkout(files: Record<string, string>): string {
  const dir = path.join(root, `checkout-${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, rel), contents);
  }
  return dir;
}

/** The variables these tests look at, all of which a test starts without. */
const WATCHED = [
  "DATABASE_URL",
  "POSTGRES_URL",
  "PGHOST",
  "PGSSLMODE",
  "INITIAL_ADMIN_EMAIL",
  "INITIAL_ADMIN_PASSWORD",
] as const;

/**
 * Run loadEnv against `dir` with `shell` as the only watched variables set, and
 * return what it left them as. process.env is restored afterwards.
 */
function load(dir: string, shell: Partial<Record<(typeof WATCHED)[number], string>> = {}) {
  const saved = Object.fromEntries(WATCHED.map((k) => [k, process.env[k]]));
  try {
    for (const k of WATCHED) delete process.env[k];
    Object.assign(process.env, shell);
    loadEnv(dir);
    return Object.fromEntries(WATCHED.map((k) => [k, process.env[k]]));
  } finally {
    for (const k of WATCHED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/** A checkout on the Docker path, once `npm run dev:docker` has booted it. */
const DOCKER_STACK = {
  ".env.docker":
    "PGSSLMODE=disable\nINITIAL_ADMIN_EMAIL=admin@localhost\nINITIAL_ADMIN_PASSWORD=mixos-local-dev\n",
  ".env.docker.local":
    "DATABASE_URL=postgresql://postgres:postgres@host.docker.internal:54322/postgres\n",
};

// ── the local Docker fallback ───────────────────────────────────────────────

test("on the Docker path, a script run from the shell finds the local stack", () => {
  assert.deepEqual(load(checkout(DOCKER_STACK)), {
    DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    POSTGRES_URL: undefined,
    PGHOST: undefined,
    PGSSLMODE: "disable",
    INITIAL_ADMIN_EMAIL: "admin@localhost",
    INITIAL_ADMIN_PASSWORD: "mixos-local-dev",
  });
});

test("a connection string from the shell never gets the local stack's settings", () => {
  for (const shell of [
    { DATABASE_URL: "postgres://mixos@db.example.com/mixos" },
    { POSTGRES_URL: "postgres://mixos@db.example.com/mixos" },
  ]) {
    const env = load(checkout(DOCKER_STACK), shell);
    assert.equal(env.PGSSLMODE, undefined, JSON.stringify(shell));
    assert.equal(env.INITIAL_ADMIN_EMAIL, undefined, JSON.stringify(shell));
    assert.equal(env.INITIAL_ADMIN_PASSWORD, undefined, JSON.stringify(shell));
  }
});

test("PGHOST alone does not stop the fallback, whose URL is then the one used", () => {
  const env = load(checkout(DOCKER_STACK), { PGHOST: "localhost" });
  assert.equal(env.DATABASE_URL, "postgresql://postgres:postgres@127.0.0.1:54322/postgres");
  assert.equal(env.PGSSLMODE, "disable");
});

test("nor does a database named in .env", () => {
  const env = load(
    checkout({ ...DOCKER_STACK, ".env": "DATABASE_URL=postgres://mixos@db.example.com/mixos\n" }),
  );
  assert.equal(env.DATABASE_URL, "postgres://mixos@db.example.com/mixos");
  assert.equal(env.PGSSLMODE, undefined);
  assert.equal(env.INITIAL_ADMIN_EMAIL, undefined);
});

test(".env.local still wins outright", () => {
  const env = load(
    checkout({
      ...DOCKER_STACK,
      ".env.local": "DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/dev\n",
    }),
  );
  assert.equal(env.DATABASE_URL, "postgresql://postgres:postgres@127.0.0.1:5432/dev");
  assert.equal(env.PGSSLMODE, undefined);
  assert.equal(env.INITIAL_ADMIN_EMAIL, undefined);
});

test("before the stack has been booted there is nothing to fall back to", () => {
  const env = load(checkout({ ".env.docker": DOCKER_STACK[".env.docker"] }));
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.PGSSLMODE, undefined);
});
