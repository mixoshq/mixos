/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The registry generator's time limit, against a script that never finishes,
 * run the way the install path runs the generator: through tsx's CLI, which
 * starts the script in a child process of its own.
 *
 * The limit's timer runs on node:test's mocked clock, which the test moves
 * past the limit only once the script has written its pid. How long tsx takes
 * to start the script grows with the machine's load, and no longer decides
 * whether the limit fires first. The waits for the script to start and for
 * the run to end are on the real clock, with limits only a hang would reach.
 */

import { after, mock, test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import timers from "node:timers/promises";
import { spawnCapture } from "./install";

// ── fixtures ────────────────────────────────────────────────────────────────

let dir: string | undefined;

after(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

/**
 * The real clock's sleep, taken before the test puts setTimeout on the mocked
 * clock, which replaces this export along with the global.
 */
const sleep = timers.setTimeout;

/** The script's pid once it has written it, polled for up to a minute; 0 if it never did. */
async function started(pidFile: string): Promise<number> {
  for (let i = 0; i < 600; i++) {
    const pid = Number(await fs.readFile(pidFile, "utf8").catch(() => "0"));
    if (pid > 0) return pid;
    await sleep(100);
  }
  return 0;
}

/** Whether `pid` has exited, allowing a moment for it to be reaped. */
async function exited(pid: number): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await sleep(100);
  }
  return false;
}

/** `promise`'s value, or null if it has not settled within `ms` of real time. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  const stop = new AbortController();
  const deadline = sleep(ms, null, { signal: stop.signal }).catch(() => null);
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    stop.abort();
  }
}

// ── the limit ───────────────────────────────────────────────────────────────

test("a run past its time limit is ended whole, including the script tsx runs in its own child", async (t) => {
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

  // The limit's timer goes on the mocked clock: it fires when the test ticks
  // the clock past it, and not before.
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());

  const run = spawnCapture(process.execPath, [tsx, script], dir, 3_000);
  const pid = await started(pidFile);
  try {
    assert.ok(pid > 0, "the script never started");
    mock.timers.tick(3_000);
    const ended = await within(run, 15_000);
    assert.ok(ended, "the run had not ended 15 seconds after its time limit");
    assert.equal(ended.code, null);
    assert.match(ended.output, /did not finish within 3s/);
    assert.ok(await exited(pid), `the script (pid ${pid}) is still running`);
  } finally {
    // Never leave anything spinning, even when an assertion fails: it would
    // also hold this file's pipes open, and the test process with them. The
    // tick fires the limit if it hasn't fired yet, and the kill reaches a
    // script that outlived the run. (A pid of 0 would signal this whole
    // process group, hence the guard.)
    mock.timers.tick(3_000);
    if (pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone, which is the passing case.
      }
    }
  }
});
