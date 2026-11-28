/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The runner protocol without a process (RunnerConnection): what a runner can
 * and can't get the platform to do, driven frame by frame, as a hostile runner
 * would.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { FrameReader } from "../../../runner/frames.mjs";
import {
  RunnerConnection,
  RunnerProtocolError,
  RunnerTimeoutError,
  type RunnerCall,
  type RunScope,
} from "./supervisor";

const ALICE: RunScope = { subject: "notes", userId: "alice", readOnly: false };

/** A connection, the frames it sent, and the calls the platform was asked. */
function harness(opts: { onCall?: (call: RunnerCall) => Promise<unknown>; now?: () => number; maxCallsPerRun?: number } = {}) {
  const sent: Record<string, unknown>[] = [];
  const reader = new FrameReader((m) => sent.push(m));
  const calls: RunnerCall[] = [];
  const conn = new RunnerConnection({
    id: "app:notes",
    write: (frame) => reader.push(frame),
    onCall: async (call) => {
      calls.push(call);
      return opts.onCall ? opts.onCall(call) : { ok: true };
    },
    now: opts.now,
    maxCallsPerRun: opts.maxCallsPerRun,
  });
  const runFrame = () => sent.filter((m) => m.t === "run").at(-1)!;
  const reply = (id: string) => sent.find((m) => m.t === "reply" && m.id === id);
  const settle = () => new Promise((r) => setImmediate(r));
  return { conn, sent, calls, runFrame, reply, settle };
}

test("a call inside a run is answered, with the run's scope attached", async () => {
  const h = harness({ onCall: async () => ({ rows: [1] }) });
  const done = h.conn.run("route", "list", { q: 1 }, ALICE, 5000);
  const run = h.runFrame();
  h.conn.receive({ t: "call", id: "c1", cap: run.cap, op: "db.query", args: { sql: "select 1" } });
  await h.settle();
  assert.deepEqual(h.reply("c1"), { t: "reply", id: "c1", ok: true, value: { rows: [1] } });
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0]!.run, { runId: run.id, subject: "notes", userId: "alice", readOnly: false });
  assert.equal(h.calls[0]!.op, "db.query");
  h.conn.receive({ t: "done", id: run.id, ok: true, value: "listed" });
  assert.equal(await done, "listed");
});

test("a call with a made-up capability is refused, and the platform is never asked", async () => {
  const h = harness();
  void h.conn.run("route", "list", null, ALICE, 5000);
  h.conn.receive({ t: "call", id: "c1", cap: "a".repeat(43), op: "db.query", args: {} });
  h.conn.receive({ t: "call", id: "c2", cap: 42, op: "db.query", args: {} });
  await h.settle();
  for (const id of ["c1", "c2"]) {
    const r = h.reply(id)!;
    assert.equal(r.ok, false);
    assert.equal((r.error as Error).name, "RunnerCallRefusedError");
  }
  assert.equal(h.calls.length, 0);
});

test("a run's capability ends with the run: kept and used later, it names nothing", async () => {
  const h = harness();
  const done = h.conn.run("route", "list", null, ALICE, 5000);
  const run = h.runFrame();
  h.conn.receive({ t: "done", id: run.id, ok: true, value: null });
  await done;
  void h.conn.run("route", "list", null, { ...ALICE, userId: "bob" }, 5000);
  h.conn.receive({ t: "call", id: "c1", cap: run.cap, op: "db.query", args: {} });
  await h.settle();
  assert.equal(h.reply("c1")!.ok, false);
  assert.equal(h.calls.length, 0);
});

test("a run that times out is given up on, told to stop, and its capability ends", async () => {
  const h = harness();
  const done = h.conn.run("route", "slow", null, ALICE, 20);
  const run = h.runFrame();
  await assert.rejects(done, RunnerTimeoutError);
  assert.ok(h.sent.some((m) => m.t === "cancel" && m.id === run.id));
  h.conn.receive({ t: "call", id: "c1", cap: run.cap, op: "db.query", args: {} });
  // Its late answer is ignored, not an error.
  h.conn.receive({ t: "done", id: run.id, ok: true, value: "late" });
  await h.settle();
  assert.equal(h.reply("c1")!.ok, false);
  assert.equal(h.calls.length, 0);
});

test("a capability past its run's deadline is refused even before the timer fires", async () => {
  let now = 1000;
  const h = harness({ now: () => now });
  void h.conn.run("route", "list", null, ALICE, 5000);
  const run = h.runFrame();
  now += 5001;
  h.conn.receive({ t: "call", id: "c1", cap: run.cap, op: "db.query", args: {} });
  await h.settle();
  assert.equal(h.reply("c1")!.ok, false);
  assert.equal(h.calls.length, 0);
});

test("one run can't have more than its share of calls waiting at once", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const h = harness({ onCall: () => gate.then(() => "ok"), maxCallsPerRun: 2 });
  void h.conn.run("route", "list", null, ALICE, 5000);
  const run = h.runFrame();
  for (const id of ["c1", "c2", "c3"]) h.conn.receive({ t: "call", id, cap: run.cap, op: "db.query", args: {} });
  await h.settle();
  assert.equal(h.reply("c3")!.ok, false);
  assert.equal(h.calls.length, 2);
  release();
  await h.settle();
  await h.settle();
  assert.equal(h.reply("c1")!.ok, true);
});

test("the platform's refusal crosses as an error, without its stack", async () => {
  const h = harness({
    onCall: async () => {
      throw Object.assign(new Error("Writes aren't allowed in a read-only run."), { name: "ReadOnlyError", detail: "x" });
    },
  });
  void h.conn.run("mcp", "find", null, { ...ALICE, readOnly: true }, 5000);
  h.conn.receive({ t: "call", id: "c1", cap: h.runFrame().cap, op: "db.query", args: {} });
  await h.settle();
  const err = h.reply("c1")!.error as Error & Record<string, unknown>;
  assert.equal(err.name, "ReadOnlyError");
  assert.equal(err.detail, undefined);
  assert.equal(h.calls[0]!.run.readOnly, true);
});

test("a frame outside the protocol is a protocol error, and the runner is stopped for it", () => {
  const h = harness();
  assert.throws(() => h.conn.receive({ t: "exec", cmd: "rm -rf /" }), RunnerProtocolError);
  assert.throws(() => h.conn.receive({ t: "call", cap: "x", op: "y" }), RunnerProtocolError);
  assert.throws(() => h.conn.receive({ t: "done", id: "x".repeat(65) }), RunnerProtocolError);
});

test("closing fails every run waiting, and no capability names anything after", async () => {
  const h = harness();
  const a = h.conn.run("route", "a", null, ALICE, 5000);
  const capA = h.runFrame().cap;
  const b = h.conn.run("route", "b", null, ALICE, 5000);
  h.conn.close(new Error("gone"));
  await assert.rejects(a, /gone/);
  await assert.rejects(b, /gone/);
  await assert.rejects(h.conn.run("route", "c", null, ALICE, 5000), /gone/);
  h.conn.receive({ t: "call", id: "c1", cap: capA, op: "db.query", args: {} });
  await h.settle();
  assert.equal(h.calls.length, 0);
});

test("each run gets its own capability, unguessable from another's", () => {
  const h = harness();
  void h.conn.run("route", "a", null, ALICE, 5000);
  const a = h.runFrame().cap as string;
  void h.conn.run("route", "b", null, ALICE, 5000);
  const b = h.runFrame().cap as string;
  assert.notEqual(a, b);
  assert.ok(a.length >= 43 && b.length >= 43);
  assert.ok(Buffer.from(a, "base64url").length === 32);
});
