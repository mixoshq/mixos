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

// ── writing under the locks ─────────────────────────────────────────────────

const SIDECAR = async () => ({
  kind: "app" as const,
  slug: "acme",
  yankedAccepted: false,
  installedAt: new Date().toISOString(),
  installedBy: "admin@example.com",
  check: { verdict: "accepted" as const, deferred: [] },
});

test("with the locks held, an app is staged under .mixos/staging/, then moves to .mixos/pending/ with its sidecar, with no file executable", async () => {
  const { stageTree, placePending } = await install();
  const { pendingLocation, readSidecar, stagingLocation } = await import("./pending");
  const root = await emptyDir();
  const held = lease();

  const staged = await stageTree(stagingLocation(root, "app", "acme").dir, ENTRIES, held);
  // Staged where nothing that builds the checkout looks, in a folder named for
  // the slug, so the check can read it as the extension's own folder.
  assert.equal(staged, path.join(root, ".mixos", "staging", "apps", "acme"));
  assert.deepEqual(await fs.readdir(root), [".mixos"]);

  const where = pendingLocation(root, "app", "acme");
  const sidecar = await SIDECAR();
  await placePending(staged, where, sidecar, held);

  // Once before writing, once before the move.
  assert.equal(held.checks, 2);
  assert.deepEqual(await fs.readdir(path.join(root, ".mixos", "staging", "apps")), []);
  assert.deepEqual((await fs.readdir(path.join(root, ".mixos", "pending", "apps"))).sort(), ["acme", "acme.json"]);
  assert.deepEqual(readSidecar(where.sidecar), { state: "ok", sidecar });
  const manifest = await fs.stat(path.join(where.folder, "app.json"));
  assert.equal(manifest.mode & 0o111, 0);
  assert.equal(
    await fs.readFile(path.join(where.folder, "api", "items", "route.ts"), "utf8"),
    "export {};\n",
  );
});

test("a theme is staged the same way, and lands in its folder in one rename", async () => {
  const { stageTree, placeTree } = await install();
  const { stagingLocation } = await import("./pending");
  const root = await emptyDir();
  const held = lease();
  const dir = path.join(root, "themes", "aurora");
  await fs.mkdir(path.dirname(dir));

  const staged = await stageTree(stagingLocation(root, "theme", "aurora").dir, ENTRIES, held);
  await placeTree(staged, dir, held);
  assert.equal(held.checks, 2);
  assert.deepEqual(await fs.readdir(path.join(root, "themes")), ["aurora"]);
  assert.deepEqual(await fs.readdir(path.join(root, ".mixos", "staging", "themes")), []);
});

test("a lease lost before writing leaves the disk as it was, leftovers included", async () => {
  const { stageTree, InstallError } = await install();
  const { stagingLocation } = await import("./pending");
  const root = await emptyDir();
  const staging = stagingLocation(root, "app", "acme").dir;
  // What an earlier run left behind. An install clears it before writing, but
  // only while the locks are its own.
  await fs.mkdir(staging, { recursive: true });
  await fs.writeFile(path.join(staging, "app.json"), "{}");

  await assert.rejects(
    stageTree(staging, ENTRIES, lease([1])),
    (err: unknown) =>
      err instanceof InstallError &&
      err.code === "lock-lost" &&
      /Nothing was written\./.test(err.message),
  );
  assert.deepEqual(await fs.readdir(staging), ["app.json"]);
});

test("a lease lost before the move to pending moves nothing and cleans nothing up", async () => {
  const { stageTree, placePending, InstallError } = await install();
  const { pendingLocation, stagingLocation } = await import("./pending");
  const root = await emptyDir();
  const lost = lease([2]);

  const staged = await stageTree(stagingLocation(root, "app", "acme").dir, ENTRIES, lost);
  await assert.rejects(
    placePending(staged, pendingLocation(root, "app", "acme"), await SIDECAR(), lost),
    (err: unknown) =>
      err instanceof InstallError &&
      err.code === "lock-lost" &&
      /Nothing was moved into \.mixos\/pending\/\./.test(err.message),
  );
  // Nothing pending. The staged copy stays: by now it may be the new holder's.
  assert.deepEqual(await fs.readdir(path.join(root, ".mixos")), ["staging"]);
  assert.deepEqual((await fs.readdir(staged)).sort(), ["api", "app.json"]);
});

test("a lease that cannot be confirmed stops it the same way, without the database's words", async () => {
  const { stageTree, placeTree, InstallError } = await install();
  const { stagingLocation } = await import("./pending");
  const root = await emptyDir();
  let checks = 0;
  const unconfirmed: PlatformLease = {
    async assertHeld() {
      if (++checks === 2) throw new Error("connect ECONNREFUSED 10.0.0.5:5432");
    },
  };

  const staged = await stageTree(stagingLocation(root, "theme", "acme").dir, ENTRIES, unconfirmed);
  await assert.rejects(
    placeTree(staged, path.join(root, "acme"), unconfirmed),
    (err: unknown) =>
      err instanceof InstallError &&
      err.code === "lock-unconfirmed" &&
      /Nothing was moved into place\./.test(err.message) &&
      !err.message.includes("10.0.0.5"),
  );
  // Not cleaned up either, for the same reason as a lost lease.
  assert.deepEqual(await fs.readdir(staged), ["api", "app.json"].sort());
});

test("a checkout lock broken while it ran stops it the same way, and says which lock went", async () => {
  const { stageTree, InstallError } = await install();
  const { stagingLocation } = await import("./pending");
  const { CheckoutLockLostError } = await import("../platform/checkout-lock");
  const root = await emptyDir();
  const broken: PlatformLease = {
    async assertHeld() {
      throw new CheckoutLockLostError(path.join(root, ".mixos", "lock"), null);
    },
  };
  await assert.rejects(
    stageTree(stagingLocation(root, "app", "acme").dir, ENTRIES, broken),
    (err: unknown) =>
      err instanceof InstallError &&
      err.code === "lock-lost" &&
      /this checkout's lock \(\.mixos\/lock\)/.test(err.message) &&
      /Nothing was written\./.test(err.message),
  );
  assert.deepEqual(await fs.readdir(root), []);
});
