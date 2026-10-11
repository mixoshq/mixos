/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The checkout lock, `.mixos/lock`: created with O_EXCL, stale only for this
 * machine and a pid that isn't running, never across hostnames, fenced by its
 * token, and adopted by a child its holder names the token to. Each test has a
 * checkout of its own in a temporary folder.
 */

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CheckoutLockHeldError,
  CheckoutLockLostError,
  acquireCheckoutLock,
  adoptCheckoutLock,
  breakCheckoutLock,
  checkoutLockFile,
  isStaleHolder,
  parseCheckoutLockHolder,
  readCheckoutLock,
  tryAcquireCheckoutLock,
  withCheckoutLock,
  type CheckoutLockHolder,
} from "./checkout-lock";

// ── fixtures ────────────────────────────────────────────────────────────────

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-checkout-lock-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
/** A checkout of the test's own. */
function checkout(): string {
  const root = path.join(tmp, `checkout-${n++}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** A pid that was running a moment ago and isn't now. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
    encoding: "utf8",
  });
  return Number(child.stdout);
}

/** Write a lock file as another process would have. */
function plant(root: string, holder: Partial<CheckoutLockHolder>): CheckoutLockHolder {
  const full: CheckoutLockHolder = {
    pid: process.pid,
    hostname: os.hostname(),
    token: `planted-${n++}-0123456789abcdef`,
    purpose: "another process",
    since: new Date().toISOString(),
    ...holder,
  };
  fs.mkdirSync(path.dirname(checkoutLockFile(root)), { recursive: true });
  fs.writeFileSync(checkoutLockFile(root), `${JSON.stringify(full)}\n`);
  return full;
}

// ── taking it ───────────────────────────────────────────────────────────────

describe("taking the lock", () => {
  test("the file holds the pid, the hostname, a token, what holds it and since when", () => {
    const root = checkout();
    const lock = tryAcquireCheckoutLock(root, "a test");
    const state = readCheckoutLock(root);
    assert.equal(state.exists, true);
    assert.deepEqual(state.holder, lock.holder);
    assert.equal(lock.holder.pid, process.pid);
    assert.equal(lock.holder.hostname, os.hostname());
    assert.equal(lock.holder.purpose, "a test");
    assert.ok(lock.token.length >= 16);
    assert.ok(!Number.isNaN(Date.parse(lock.holder.since)));
    assert.equal(lock.tookOver, null);
    lock.release();
    assert.equal(readCheckoutLock(root).exists, false);
  });

  test("a second taker is refused while it is held, and told who holds it", () => {
    const root = checkout();
    const lock = tryAcquireCheckoutLock(root, "the first");
    assert.throws(
      () => tryAcquireCheckoutLock(root, "the second"),
      (err: unknown) =>
        err instanceof CheckoutLockHeldError &&
        err.holder?.token === lock.token &&
        /locked by the first \(pid \d+ on this machine/.test(err.message),
    );
    // Still the first's.
    assert.equal(readCheckoutLock(root).holder?.token, lock.token);
    lock.release();
    tryAcquireCheckoutLock(root, "the second").release();
  });

  test("of many takers at once, no two ever hold it together", async () => {
    const root = checkout();
    const held = path.join(root, "held.log");
    // Each racer that gets the lock records when it took it and when it let
    // go, holding it for a moment between.
    const script =
      `const fs = require("node:fs");\n` +
      `const { tryAcquireCheckoutLock } = require(${JSON.stringify(path.join(__dirname, "checkout-lock.ts"))});\n` +
      `const [root, log] = process.argv.slice(1);\n` +
      `try {\n` +
      `  const lock = tryAcquireCheckoutLock(root, "racer");\n` +
      `  const from = Date.now();\n` +
      `  setTimeout(() => { const to = Date.now(); lock.release(); fs.appendFileSync(log, JSON.stringify([from, to]) + "\\n"); }, 150);\n` +
      `} catch {}\n`;
    const tsx = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    await Promise.all(
      Array.from(
        { length: 6 },
        () =>
          new Promise<void>((resolve) => {
            spawn(process.execPath, [tsx, "-e", script, root, held], { stdio: "ignore" }).on("close", () => resolve());
          }),
      ),
    );
    const intervals = fs
      .readFileSync(held, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as [number, number])
      .sort((a, b) => a[0] - b[0]);
    assert.ok(intervals.length >= 1);
    for (let i = 1; i < intervals.length; i++) {
      assert.ok(intervals[i][0] >= intervals[i - 1][1], `two racers held it at once: ${JSON.stringify(intervals)}`);
    }
    assert.equal(readCheckoutLock(root).exists, false);
  });

  test("a link at the lock's path is never written through", () => {
    const root = checkout();
    const elsewhere = path.join(tmp, `elsewhere-${n++}`);
    fs.mkdirSync(path.join(root, ".mixos"), { recursive: true });
    fs.symlinkSync(elsewhere, checkoutLockFile(root));
    assert.throws(() => tryAcquireCheckoutLock(root, "a test"), CheckoutLockHeldError);
    assert.equal(fs.existsSync(elsewhere), false);
  });

  test("waiting: a taker that waits gets it once the holder releases, and is told who it waited for", async () => {
    const root = checkout();
    const first = tryAcquireCheckoutLock(root, "the first");
    const waitedFor: (string | undefined)[] = [];
    setTimeout(() => first.release(), 300);
    const second = await acquireCheckoutLock(root, "the second", {
      waitMs: 10_000,
      pollMs: 50,
      onWait: (holder) => waitedFor.push(holder?.purpose),
    });
    assert.deepEqual(waitedFor, ["the first"]);
    assert.equal(readCheckoutLock(root).holder?.token, second.token);
    second.release();
  });

  test("waiting gives up at its limit, naming the holder", async () => {
    const root = checkout();
    const first = tryAcquireCheckoutLock(root, "the first");
    await assert.rejects(
      acquireCheckoutLock(root, "the second", { waitMs: 300, pollMs: 50 }),
      (err: unknown) => err instanceof CheckoutLockHeldError && err.holder?.token === first.token,
    );
    first.release();
  });

  test("withCheckoutLock releases when its work throws", async () => {
    const root = checkout();
    await assert.rejects(
      withCheckoutLock(root, "a test", async () => {
        assert.equal(readCheckoutLock(root).exists, true);
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(readCheckoutLock(root).exists, false);
  });
});

// ── stale, or not ───────────────────────────────────────────────────────────

describe("when a lock is stale", () => {
  test("this machine and a pid that isn't running: taken over, and the taker is told whose it was", () => {
    const root = checkout();
    const stale = plant(root, { pid: deadPid(), purpose: "a crashed generator" });
    const lock = tryAcquireCheckoutLock(root, "a test");
    assert.equal(lock.tookOver?.token, stale.token);
    assert.equal(readCheckoutLock(root).holder?.token, lock.token);
    // Nothing set aside is left behind.
    assert.deepEqual(fs.readdirSync(path.join(root, ".mixos")), ["lock"]);
    lock.release();
  });

  test("this machine and a running pid: held", () => {
    const root = checkout();
    plant(root, { pid: process.ppid });
    assert.throws(() => tryAcquireCheckoutLock(root, "a test"), CheckoutLockHeldError);
  });

  test("another machine: never taken over, running or not", () => {
    const root = checkout();
    const foreign = plant(root, { pid: deadPid(), hostname: `${os.hostname()}-container` });
    assert.throws(
      () => tryAcquireCheckoutLock(root, "a test"),
      (err: unknown) =>
        err instanceof CheckoutLockHeldError &&
        /another machine/.test(err.message) &&
        /--break-lock/.test(err.message),
    );
    assert.equal(readCheckoutLock(root).holder?.token, foreign.token);
    assert.equal(isStaleHolder(foreign), false);
    assert.equal(isStaleHolder(foreign, foreign.hostname, () => false), true);
  });

  test("a lock file that can't be read as one: held, and never taken over", () => {
    const root = checkout();
    fs.mkdirSync(path.join(root, ".mixos"), { recursive: true });
    fs.writeFileSync(checkoutLockFile(root), "not a lock");
    assert.throws(
      () => tryAcquireCheckoutLock(root, "a test"),
      (err: unknown) => err instanceof CheckoutLockHeldError && err.holder === null && /can't be read/.test(err.message),
    );
    assert.equal(fs.readFileSync(checkoutLockFile(root), "utf8"), "not a lock");
  });

  test("a holder's file is parsed strictly enough to refuse what no holder writes", () => {
    for (const text of ["", "{}", "[]", '{"pid":0,"hostname":"h","token":"0123456789abcdef"}', '{"pid":1,"hostname":"","token":"0123456789abcdef"}', '{"pid":1,"hostname":"h","token":"short"}']) {
      assert.equal(parseCheckoutLockHolder(text), null, text);
    }
    assert.equal(parseCheckoutLockHolder('{"pid":12,"hostname":"h","token":"0123456789abcdef"}')?.purpose, "an unnamed process");
  });
});

// ── fenced ──────────────────────────────────────────────────────────────────

describe("assertHeld", () => {
  test("passes while the file holds this token, and throws once it is broken or replaced", () => {
    const root = checkout();
    const lock = tryAcquireCheckoutLock(root, "a test");
    lock.assertHeld();

    // Broken by hand and taken by someone else.
    fs.rmSync(checkoutLockFile(root));
    const other = plant(root, { purpose: "the new holder" });
    assert.throws(
      () => lock.assertHeld(),
      (err: unknown) => err instanceof CheckoutLockLostError && err.now?.token === other.token,
    );
    // And its release leaves the new holder's file alone.
    lock.release();
    assert.equal(readCheckoutLock(root).holder?.token, other.token);
  });

  test("throws once released", () => {
    const root = checkout();
    const lock = tryAcquireCheckoutLock(root, "a test");
    lock.release();
    assert.throws(() => lock.assertHeld(), CheckoutLockLostError);
  });
});

// ── a child of a holder ─────────────────────────────────────────────────────

describe("adoptCheckoutLock", () => {
  test("works under the lock its parent names, and leaves the file to the parent", () => {
    const root = checkout();
    const parent = tryAcquireCheckoutLock(root, "an install");
    const child = adoptCheckoutLock(root, parent.token);
    child.assertHeld();
    child.release();
    assert.equal(readCheckoutLock(root).holder?.token, parent.token);
    parent.release();
  });

  test("refuses a token the file doesn't hold, and no lock at all", () => {
    const root = checkout();
    assert.throws(() => adoptCheckoutLock(root, "0123456789abcdef-none"), CheckoutLockLostError);
    const parent = tryAcquireCheckoutLock(root, "an install");
    assert.throws(() => adoptCheckoutLock(root, "0123456789abcdef-other"), CheckoutLockLostError);
    parent.release();
  });
});

// ── breaking it by hand ─────────────────────────────────────────────────────

describe("breakCheckoutLock", () => {
  test("removes the lock that was shown", () => {
    const root = checkout();
    plant(root, { hostname: "a-dev-container" });
    const shown = readCheckoutLock(root);
    assert.equal(breakCheckoutLock(root, shown.raw), true);
    assert.equal(readCheckoutLock(root).exists, false);
  });

  test("leaves a lock taken since it was shown", () => {
    const root = checkout();
    plant(root, { hostname: "a-dev-container" });
    const shown = readCheckoutLock(root);
    const since = plant(root, { purpose: "a newer holder" });
    assert.equal(breakCheckoutLock(root, shown.raw), false);
    assert.equal(readCheckoutLock(root).holder?.token, since.token);
    assert.deepEqual(fs.readdirSync(path.join(root, ".mixos")), ["lock"]);
  });

  test("says so when there was nothing to break", () => {
    assert.equal(breakCheckoutLock(checkout(), "{}"), false);
  });
});
