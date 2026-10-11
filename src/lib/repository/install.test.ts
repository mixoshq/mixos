/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { LockLostError, type PlatformLease } from "../platform/lock";
import type { TarEntry } from "./tar";

// ── fixtures ────────────────────────────────────────────────────────────────

// VERCEL is one of the two markers src/lib/platform/build.ts reads to tell a
// built deployment from a checkout. Set before the imports below, which are
// dynamic so that nothing loads before it, so this file sees the module as a
// Vercel deployment would.
process.env.VERCEL = "1";
delete process.env.INSTALL_APPS;

// The lock reaches Postgres through the lazy pool in src/lib/db/client.ts,
// which uses globalThis.__pg once it is set. Recording here shows whether
// anything asked for the lock, with no database to reach.
const queries: string[] = [];
(globalThis as { __pg?: unknown }).__pg = async (strings: TemplateStringsArray) => {
  queries.push(strings.join("?"));
  return [];
};

const install = () => import("./install");

const ENTRIES: TarEntry[] = [
  { path: "app.json", mode: 0o755, data: Buffer.from('{"slug":"acme"}\n') },
  { path: "api/items/route.ts", mode: 0o644, data: Buffer.from("export {};\n") },
];

/** A lease whose checks pass, except the ones numbered in `lostAt`, counting from 1. */
function lease(lostAt: number[] = []): PlatformLease & { checks: number } {
  const l = {
    checks: 0,
    async assertHeld() {
      l.checks += 1;
      if (lostAt.includes(l.checks)) throw new LockLostError("repository.register");
    },
  };
  return l;
}

const made: string[] = [];
async function emptyDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mixos-install-"));
  made.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(made.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

// ── before the lock ─────────────────────────────────────────────────────────

test("a built deployment is refused before the register lock is asked for", async () => {
  const { installExtension, InstallError } = await install();
  await assert.rejects(
    installExtension("app", "acme"),
    (err: unknown) => err instanceof InstallError && err.code === "unsupported-environment",
  );
  assert.deepEqual(queries, []);
});

// ── writing under the lease ─────────────────────────────────────────────────

test("with the lease held, the tree is staged in a dot-prefixed folder, then lands in one rename, with no file executable", async () => {
  const { stageTree, placeTree } = await install();
  const parent = await emptyDir();
  const held = lease();
  const dir = path.join(parent, "acme");

  const staged = await stageTree(dir, ENTRIES, held);

  // Staged where no scan looks, in a folder named for the slug, so the check
  // can read it as the extension's own folder. Nothing in place yet.
  assert.equal(staged, path.join(parent, ".installing-acme", "acme"));
  assert.deepEqual(await fs.readdir(parent), [".installing-acme"]);

  await placeTree(staged, dir, held);

  // Once before writing, once before the rename.
  assert.equal(held.checks, 2);
  assert.deepEqual(await fs.readdir(parent), ["acme"]);
  const manifest = await fs.stat(path.join(dir, "app.json"));
  assert.equal(manifest.mode & 0o111, 0);
  assert.equal(
    await fs.readFile(path.join(dir, "api", "items", "route.ts"), "utf8"),
    "export {};\n",
  );
});

test("a lease lost before writing leaves the disk as it was, leftovers included", async () => {
  const { stageTree, InstallError } = await install();
  const parent = await emptyDir();
  // What an earlier run left behind. A registration clears it before writing,
  // but only while the lock is its own.
  await fs.mkdir(path.join(parent, ".installing-acme", "acme"), { recursive: true });
  await fs.writeFile(path.join(parent, ".installing-acme", "acme", "app.json"), "{}");

  await assert.rejects(
    stageTree(path.join(parent, "acme"), ENTRIES, lease([1])),
    (err: unknown) =>
      err instanceof InstallError &&
      err.code === "lock-lost" &&
      /Nothing was written\./.test(err.message),
  );
  assert.deepEqual(await fs.readdir(parent), [".installing-acme"]);
  assert.deepEqual(await fs.readdir(path.join(parent, ".installing-acme", "acme")), ["app.json"]);
});

test("a lease lost before the rename puts nothing in place and cleans nothing up", async () => {
  const { stageTree, placeTree, InstallError } = await install();
  const parent = await emptyDir();
  const dir = path.join(parent, "acme");
  const lost = lease([2]);

  const staged = await stageTree(dir, ENTRIES, lost);
  await assert.rejects(
    placeTree(staged, dir, lost),
    (err: unknown) =>
      err instanceof InstallError &&
      err.code === "lock-lost" &&
      /Nothing was moved into place\./.test(err.message),
  );
  // No target. The staging copy stays: by now it may be the new holder's.
  assert.deepEqual(await fs.readdir(parent), [".installing-acme"]);
  assert.deepEqual((await fs.readdir(staged)).sort(), ["api", "app.json"]);
});

test("a lease that cannot be confirmed stops it the same way, without the database's words", async () => {
  const { stageTree, placeTree, InstallError } = await install();
  const parent = await emptyDir();
  const dir = path.join(parent, "acme");
  let checks = 0;
  const unconfirmed: PlatformLease = {
    async assertHeld() {
      if (++checks === 2) throw new Error("connect ECONNREFUSED 10.0.0.5:5432");
    },
  };

  const staged = await stageTree(dir, ENTRIES, unconfirmed);
  await assert.rejects(
    placeTree(staged, dir, unconfirmed),
    (err: unknown) =>
      err instanceof InstallError &&
      err.code === "lock-unconfirmed" &&
      /Nothing was moved into place\./.test(err.message) &&
      !err.message.includes("10.0.0.5"),
  );
  // Not cleaned up either, for the same reason as a lost lease.
  assert.deepEqual(await fs.readdir(parent), [".installing-acme"]);
});
