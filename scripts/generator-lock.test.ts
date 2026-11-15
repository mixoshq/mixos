/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The registry generator's full run holds the checkout lock (`.mixos/lock`):
 * its own, waited for while another process holds it, or with `--lock-token`,
 * its parent's. So `npm run dev`, `npm run build` and `npm run registry` can't
 * rewrite src/generated/ while an install or a registration is changing the
 * checkout.
 *
 * runFullGenerator() is the script's own entry, called here with a checkout of
 * the test's own and a stand-in for the run, so nothing here rewrites this
 * repository's src/generated/. The last test runs the real script, with a
 * token no lock holds, which stops before it writes anything.
 */

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkoutLockFile, readCheckoutLock, tryAcquireCheckoutLock } from "../src/lib/platform/checkout-lock";
import { runFullGenerator } from "./generate-project-registry";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-generator-lock-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
const checkout = () => {
  const root = path.join(tmp, `checkout-${n++}`);
  fs.mkdirSync(root);
  return root;
};

/** Run with `run` in main()'s place, keeping what was printed. */
async function quietly(fn: () => Promise<number>): Promise<{ code: number; printed: string }> {
  const lines: string[] = [];
  const { log, error } = console;
  console.log = console.error = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    return { code: await fn(), printed: lines.join("\n") };
  } finally {
    Object.assign(console, { log, error });
  }
}

describe("the full run and the checkout lock", () => {
  test("takes the lock for the run, holding it throughout, and releases it after", async () => {
    const root = checkout();
    let heldDuring = "";
    const { code } = await quietly(() =>
      runFullGenerator([], {
        root,
        run: async () => {
          heldDuring = readCheckoutLock(root).holder?.purpose ?? "";
        },
      }),
    );
    assert.equal(code, 0);
    assert.equal(heldDuring, "the registry generator");
    assert.equal(readCheckoutLock(root).exists, false);
  });

  test("releases it when the run fails", async () => {
    const root = checkout();
    const { code } = await quietly(() =>
      runFullGenerator([], {
        root,
        run: async () => {
          throw new Error("a manifest that aborts the build");
        },
      }),
    );
    assert.equal(code, 1);
    assert.equal(readCheckoutLock(root).exists, false);
  });

  test("waits while an install holds it, saying for whom, and runs once it is released", async () => {
    const root = checkout();
    const install = tryAcquireCheckoutLock(root, "an install of app/acme from the Registry");
    let ranAt = 0;
    const releasedAt = Date.now() + 400;
    setTimeout(() => install.release(), 400);
    const { code, printed } = await quietly(() =>
      runFullGenerator([], { root, waitMs: 10_000, pollMs: 50, run: async () => void (ranAt = Date.now()) }),
    );
    assert.equal(code, 0);
    assert.match(printed, /Waiting for the checkout lock \(\.mixos\/lock\), held by an install of app\/acme/);
    assert.ok(ranAt >= releasedAt - 50, "the run started before the install released the lock");
  });

  test("gives up after its wait without running, naming the holder", async () => {
    const root = checkout();
    const install = tryAcquireCheckoutLock(root, "a registration of app/acme");
    let ran = false;
    const { code, printed } = await quietly(() =>
      runFullGenerator([], { root, waitMs: 300, pollMs: 50, run: async () => void (ran = true) }),
    );
    install.release();
    assert.equal(code, 1);
    assert.equal(ran, false);
    assert.match(printed, /locked by a registration of app\/acme[\s\S]*not generated/);
  });

  test("takes over a lock whose holder stopped on this machine, and says so", async () => {
    const root = checkout();
    const dead = Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
    fs.mkdirSync(path.dirname(checkoutLockFile(root)));
    fs.writeFileSync(
      checkoutLockFile(root),
      JSON.stringify({ pid: dead, hostname: os.hostname(), token: "0123456789abcdef-dead", purpose: "a crashed install", since: new Date().toISOString() }),
    );
    let ran = false;
    const { code, printed } = await quietly(() => runFullGenerator([], { root, run: async () => void (ran = true) }));
    assert.equal(code, 0);
    assert.equal(ran, true);
    assert.match(printed, /Took over the checkout lock from a crashed install/);
  });

  test("never takes over a lock from another machine", async () => {
    const root = checkout();
    fs.mkdirSync(path.dirname(checkoutLockFile(root)));
    fs.writeFileSync(
      checkoutLockFile(root),
      JSON.stringify({ pid: 1, hostname: "a-dev-container", token: "0123456789abcdef-away", purpose: "the registry generator", since: new Date().toISOString() }),
    );
    let ran = false;
    const { code, printed } = await quietly(() => runFullGenerator([], { root, waitMs: 200, pollMs: 50, run: async () => void (ran = true) }));
    assert.equal(code, 1);
    assert.equal(ran, false);
    assert.match(printed, /another machine, a-dev-container/);
    assert.match(printed, /--break-lock/);
  });

  test("with its parent's token, runs under the parent's lock and leaves it to the parent", async () => {
    const root = checkout();
    const parent = tryAcquireCheckoutLock(root, "a registration of app/acme");
    let ran = false;
    const { code } = await quietly(() => runFullGenerator(["--lock-token", parent.token], { root, run: async () => void (ran = true) }));
    assert.equal(code, 0);
    assert.equal(ran, true);
    assert.equal(readCheckoutLock(root).holder?.token, parent.token);
    parent.release();
  });

  test("with a token the lock doesn't hold, stops before running", async () => {
    const root = checkout();
    const parent = tryAcquireCheckoutLock(root, "a registration of app/acme");
    let ran = false;
    const { code, printed } = await quietly(() =>
      runFullGenerator(["--lock-token", "0123456789abcdef-wrong"], { root, run: async () => void (ran = true) }),
    );
    parent.release();
    assert.equal(code, 1);
    assert.equal(ran, false);
    assert.match(printed, /doesn't hold/);
  });

  test("refuses arguments it doesn't know, without running", async () => {
    let ran = false;
    for (const args of [
      ["--lock"],
      ["--lock-token"],
      ["--lock-token", "a", "b"],
      ["--lock-token", "a", "--lock-token", "b"],
      ["--chek"],
      ["--without"],
      ["--without", "acme"],
      ["--without", "plugin/acme"],
      ["--without", "app/../acme"],
      ["--without", "app/.backup-acme"],
      ["--without", "app/acme", "--without", "app/board"],
    ]) {
      const { code } = await quietly(() => runFullGenerator(args, { root: checkout(), run: async () => void (ran = true) }));
      assert.equal(code, 2, args.join(" "));
    }
    assert.equal(ran, false);
  });

  test("hands the run the extension to leave out, with its parent's token or without", async () => {
    const root = checkout();
    const seen: unknown[] = [];
    const run = async ({ without }: { without?: unknown }) => void seen.push(without);
    const parent = tryAcquireCheckoutLock(root, "a removal of app/acme");
    await quietly(() => runFullGenerator(["--lock-token", parent.token, "--without", "app/acme"], { root, run }));
    await quietly(() => runFullGenerator(["--without", "connector/probe_1", "--lock-token", parent.token], { root, run }));
    parent.release();
    await quietly(() => runFullGenerator(["--without", "theme/dusk-e15a7c3f"], { root, run }));
    await quietly(() => runFullGenerator([], { root, run }));
    assert.deepEqual(seen, [
      { kind: "app", slug: "acme" },
      { kind: "connector", slug: "probe_1" },
      { kind: "theme", slug: "dusk-e15a7c3f" },
      undefined,
    ]);
  });

  test("the script itself: a token no lock holds stops it before src/generated/ is touched", () => {
    const root = path.resolve(__dirname, "..");
    const registry = path.join(root, "src", "generated", "app-registry.ts");
    const before = fs.existsSync(registry) ? fs.statSync(registry).mtimeMs : 0;
    const run = spawnSync(
      process.execPath,
      [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), path.join(__dirname, "generate-project-registry.ts"), "--lock-token", "0123456789abcdef-nobody"],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stderr, /doesn't hold/);
    assert.equal(fs.existsSync(registry) ? fs.statSync(registry).mtimeMs : 0, before);
  });
});
