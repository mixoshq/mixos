/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Real runner processes (Runner), with the echo bundle
 * (tests/fixtures/runners/echo/bundle.mjs). Skipped on a Node without the
 * network permission (before 25), where no runner starts at all.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  backoffMs,
  isolationSupport,
  Runner,
  RunnerCrashedError,
  RunnerTimeoutError,
  RunnerUnavailableError,
  runnerDir,
  type RunnerCall,
  type RunScope,
} from "./supervisor";

const supported = isolationSupport().supported;
const skip = supported ? false : "this Node has no network permission";
const ECHO = path.join(process.cwd(), "tests/fixtures/runners/echo/bundle.mjs");
const BROKEN = path.join(process.cwd(), "tests/fixtures/runners/broken/bundle.mjs");
const ALICE: RunScope = { subject: "echo", userId: "alice", readOnly: false };
const T = { timeoutMs: 5000 };

function echoRunner(opts: { onCall?: (call: RunnerCall) => Promise<unknown>; heartbeatMs?: number; idleMs?: number } = {}) {
  const calls: RunnerCall[] = [];
  const logs: string[] = [];
  const runner = new Runner({
    id: "app:echo",
    bundle: ECHO,
    onCall: async (call) => {
      calls.push(call);
      return opts.onCall ? opts.onCall(call) : { answered: call.op };
    },
    heartbeatMs: opts.heartbeatMs,
    idleMs: opts.idleMs,
    log: (line) => logs.push(line),
  });
  return { runner, calls, logs };
}

test("a run goes in and its answer comes back, values intact", { skip }, async () => {
  const { runner } = echoRunner();
  try {
    const when = new Date("2026-11-28T00:00:00.000Z");
    const back = (await runner.run("echo", "echo", { when, n: 1, bytes: new Uint8Array([7]) }, ALICE, T)) as Record<string, unknown>;
    assert.ok(back.when instanceof Date);
    assert.equal((back.when as Date).getTime(), when.getTime());
    assert.equal(back.n, 1);
    assert.deepEqual(back.bytes, new Uint8Array([7]));
    assert.equal(runner.state, "ready");
  } finally {
    await runner.stop();
  }
});

test("a call the code makes reaches the platform as the run's user, and is answered", { skip }, async () => {
  const { runner, calls } = echoRunner({ onCall: async (c) => ({ op: c.op, args: c.args }) });
  try {
    const back = await runner.run("route", "call", { op: "db.query", args: { sql: "select 1" } }, ALICE, T);
    assert.deepEqual(back, { op: "db.query", args: { sql: "select 1" } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.run.userId, "alice");
    assert.equal(calls[0]!.run.subject, "echo");
  } finally {
    await runner.stop();
  }
});

test("every way out the permission model and the bootstrap close is closed", { skip }, async () => {
  const { runner } = echoRunner();
  try {
    const outside = path.join(process.cwd(), "package.json");
    const out = (await runner.run("echo", "probe", { outside }, ALICE, T)) as Record<string, unknown>;
    assert.equal(out.env, 0, "an empty environment");
    for (const [what, how] of Object.entries(out)) {
      if (what === "env") continue;
      assert.notEqual(how, "allowed", `${what} should be refused`);
    }
    for (const denied of ["fetch", "socket", "unixSocket", "udp", "dns", "wasi", "report", "binding", "inspector", "worker"]) {
      assert.equal(out[denied], "ERR_ACCESS_DENIED", denied);
    }
    assert.equal(out.addon, "ERR_DLOPEN_DISABLED");
    assert.equal(out.readOutside, "ERR_ACCESS_DENIED");
    assert.equal(out.write, "ERR_ACCESS_DENIED");
    assert.equal(out.childProcess, "ERR_ACCESS_DENIED");
    assert.equal(out.signalPlatform, "RunnerRefusedError");
    assert.equal(out.debugPlatform, "RunnerRefusedError");
    assert.equal(out.priority, "RunnerRefusedError");
    for (const file of ["written.txt", "report.json"]) assert.ok(!existsSync(path.join(path.dirname(ECHO), file)), file);
  } finally {
    await runner.stop();
  }
});

test("a capability kept past its run is refused, and the platform is never asked", { skip }, async () => {
  const { runner, calls } = echoRunner();
  try {
    assert.equal(await runner.run("echo", "stash", null, ALICE, T), "stashed");
    await assert.rejects(
      runner.run("echo", "replay", { op: "db.query", args: {} }, { ...ALICE, userId: "bob" }, T),
      (err: Error) => err.name === "RunnerCallRefusedError",
    );
    assert.equal(calls.length, 0);
  } finally {
    await runner.stop();
  }
});

test("the code's own error comes back as an error, with its named fields only", { skip }, async () => {
  const { runner } = echoRunner();
  try {
    await assert.rejects(runner.run("echo", "throw", { message: "bad input" }, ALICE, T), (err: Error & Record<string, unknown>) => {
      assert.equal(err.message, "bad input");
      assert.equal(err.category, "bad-request");
      assert.equal(err.secretStack, undefined);
      return true;
    });
    // The runner is still up for the next run.
    assert.equal(await runner.run("echo", "echo", 1, ALICE, T), 1);
  } finally {
    await runner.stop();
  }
});

test("a run past its time fails, and the runner stays up for the next", { skip }, async () => {
  const { runner } = echoRunner();
  try {
    await assert.rejects(runner.run("echo", "sleep", { ms: 2000 }, ALICE, { timeoutMs: 50 }), RunnerTimeoutError);
    assert.equal(await runner.run("echo", "echo", "next", ALICE, T), "next");
  } finally {
    await runner.stop();
  }
});

test("a runner stuck in a loop is stopped by the heartbeat, and the next run starts a new one", { skip }, async () => {
  const { runner, logs } = echoRunner({ heartbeatMs: 100 });
  try {
    await runner.run("echo", "echo", 0, ALICE, T);
    const first = runner.pid;
    await assert.rejects(runner.run("echo", "spin", null, ALICE, { timeoutMs: 10_000 }), RunnerCrashedError);
    assert.ok(logs.some((l) => l.includes("stopped answering")));
    assert.equal(await runner.run("echo", "echo", "again", ALICE, T), "again");
    assert.notEqual(runner.pid, first);
  } finally {
    await runner.stop();
  }
});

test("a runner that exits fails the run in it, and is started again on the next", { skip }, async () => {
  const { runner } = echoRunner();
  try {
    await assert.rejects(runner.run("echo", "crash", null, ALICE, T), RunnerCrashedError);
    assert.equal(runner.state, "stopped");
    assert.equal(await runner.run("echo", "echo", "back", ALICE, T), "back");
  } finally {
    await runner.stop();
  }
});

test("code that can't load leaves the runner unavailable, never run in the platform", { skip }, async () => {
  const runner = new Runner({ id: "app:broken", bundle: BROKEN, onCall: async () => null, log: () => {} });
  await assert.rejects(runner.run("echo", "echo", 1, ALICE, T), (err: Error) => {
    assert.ok(err instanceof RunnerUnavailableError);
    assert.match(err.message, /couldn't load its code: this bundle can't load/);
    return true;
  });
  // The first failure may retry at once; the second waits.
  await assert.rejects(runner.run("echo", "echo", 1, ALICE, T), RunnerUnavailableError);
  await assert.rejects(runner.run("echo", "echo", 1, ALICE, T), /tried again in/);
});

test("an idle runner stops by itself", { skip }, async () => {
  const { runner } = echoRunner({ idleMs: 50 });
  await runner.run("echo", "echo", 1, ALICE, T);
  const deadline = Date.now() + 3000;
  while (runner.state !== "stopped" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.equal(runner.state, "stopped");
});

test("the bootstrap refuses to start outside the permission model", { skip }, () => {
  const r = spawnSync(process.execPath, [path.join(runnerDir(), "bootstrap.mjs"), ECHO], {
    env: {} as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(r.status, 78);
  assert.match(r.stderr, /permission model is off/);
});

test("the bootstrap refuses to start with the network allowed", { skip }, () => {
  const r = spawnSync(
    process.execPath,
    ["--permission", `--allow-fs-read=${runnerDir()}`, "--allow-net", path.join(runnerDir(), "bootstrap.mjs"), ECHO],
    { env: {} as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe", "pipe"], encoding: "utf8", timeout: 5000 },
  );
  assert.equal(r.status, 78);
  assert.match(r.stderr, /allows net/);
});

test("backoff: the first failure retries at once, then it doubles to a minute", () => {
  assert.deepEqual([1, 2, 3, 4, 8, 20].map(backoffMs), [0, 1000, 2000, 4000, 60_000, 60_000]);
});
