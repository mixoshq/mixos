/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The registry generator's time limit, against a script that never finishes,
 * run the way the install path runs the generator: through tsx's CLI, which
 * starts the script in a child process of its own.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { spawnCapture } from "./install";

// ── fixtures ────────────────────────────────────────────────────────────────

let dir: string | undefined;

after(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

/** Whether `pid` has exited, allowing a moment for it to be reaped. */
async function exited(pid: number): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/** `promise`'s value, or null if it has not settled within `ms`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// ── the limit ───────────────────────────────────────────────────────────────

test("a run past its time limit is ended whole, including the script tsx runs in its own child", async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mixos-generator-"));
  const pidFile = path.join(dir, "pid");
  const script = path.join(dir, "spin.ts");
  await fs.writeFile(
    script,
    `import { writeFileSync } from "node:fs";\n` +
      `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
      `for (;;) {}\n`,
  );
  // The same entry regenerateRegistry() runs the generator through.
  const tsx = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");

  const run = await within(spawnCapture(process.execPath, [tsx, script], dir, 3_000), 15_000);
  const pid = Number(await fs.readFile(pidFile, "utf8").catch(() => "0"));
  try {
    assert.ok(run, "the run had not ended 12 seconds after its time limit");
    assert.equal(run.code, null);
    assert.match(run.output, /did not finish within 3s/);
    assert.ok(pid > 0, "the script never started");
    assert.ok(await exited(pid), `the script (pid ${pid}) is still running`);
  } finally {
    // Never leave it spinning, even when an assertion fails: it would also
    // hold this file's pipes open, and the test process with them. (A pid of
    // 0 would signal this whole process group, hence the guard.)
    if (pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone, which is the passing case.
      }
    }
  }
});
