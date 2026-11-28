/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// @ts-check

/**
 * A runner's entry (Items 5b and 7b,
 * docs/plans/20261128_0146-out-of-process-runners.md). The platform starts it
 * (src/lib/runners/supervisor.ts) as
 *
 *   node --permission --allow-fs-read=<this folder> --allow-fs-read=<bundle>
 *        --max-old-space-size=<n> runner/bootstrap.mjs <bundle>
 *
 * with an empty environment and one pipe, on fd 3. It loads the bundle (one
 * Registry app's or one connector's code) and does each run the platform hands
 * it. Anything the code needs is a call back to the platform over the same
 * pipe, under that run's capability, and the platform decides each one.
 *
 * Node's permission model refuses this process the network, child processes,
 * workers, addons, WASI, the inspector, any file write, and any read outside
 * the two paths above. It doesn't cover signals or another process's
 * priority, so those go first, before the bundle loads.
 *
 * A bundle exports `run(kind, name, input, host)`, where `host.call(op, args)`
 * is its one way out.
 */

import fs from "node:fs";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import { encodeFrame, FrameReader } from "./frames.mjs";

/** Exit code for "refused to start": the platform reads it as a failed start, not a crash. */
const REFUSED = 78;

function refuseToStart(/** @type {string} */ why) {
  process.stderr.write(`mixos runner: refusing to start: ${why}\n`);
  process.exit(REFUSED);
}

// 1. Run only inside the permission model. Started any other way, a runner
//    would be the platform's process with extra steps.
const permission = process.permission;
if (!permission || typeof permission.has !== "function") refuseToStart("Node's permission model is off");
for (const scope of ["fs.write", "child", "worker", "net", "addon", "wasi", "inspector"]) {
  if (permission.has(/** @type {any} */ (scope))) refuseToStart(`the permission model allows ${scope}`);
}

// 2. Nothing from an environment. The platform passes none; the OS may add
//    one or two (macOS adds __CF_USER_TEXT_ENCODING).
for (const k of Object.keys(process.env)) delete process.env[k];

// 3. What the permission model leaves open: a signal to any process this user
//    owns (the platform, another runner), SIGUSR1 among them, which opens a
//    debugger in a Node process; the same through _debugProcess; and another
//    process's scheduling priority.
/** @param {string} what */
const refused = (what) => () => {
  const err = new Error(`${what} is not available in a MixOS runner`);
  err.name = "RunnerRefusedError";
  throw err;
};
for (const name of ["kill", "_kill", "_debugProcess", "_debugEnd"]) {
  delete (/** @type {Record<string, unknown>} */ (/** @type {unknown} */ (process)))[name];
  Object.defineProperty(process, name, { value: refused(`process.${name}`), writable: false, configurable: false });
}
Object.defineProperty(os, "setPriority", { value: refused("os.setPriority"), writable: false, configurable: false });
syncBuiltinESMExports();

// 4. The pipe, and the protocol. Read and written through fs, on its file
//    descriptor: the permission model doesn't check an operation on a file
//    descriptor already open (a documented limitation, put to use here). As a
//    socket, `new net.Socket({ fd: 3 })`, it is refused as network access
//    from Node 26.13 on.
const input = fs.createReadStream(/** @type {any} */ (null), { fd: 3, autoClose: false, highWaterMark: 256 * 1024 });
const output = fs.createWriteStream(/** @type {any} */ (null), { fd: 3, autoClose: false });
/**
 * Throws a FrameError for a message too large to frame; each caller says so
 * in one that fits.
 * @param {Record<string, unknown>} message
 */
const send = (message) => {
  output.write(encodeFrame(message));
};

/** @type {Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>} */
const calls = new Map();
let nextCall = 0;

/**
 * @param {string} cap
 * @param {string} op
 * @param {unknown} args
 */
function call(cap, op, args) {
  const id = `c${++nextCall}`;
  return new Promise((resolve, reject) => {
    try {
      send({ t: "call", id, cap, op, args: args === undefined ? null : args });
      calls.set(id, { resolve, reject });
    } catch (error) {
      reject(error);
    }
  });
}

/** @type {{ run: (kind: string, name: string, input: unknown, host: { call: (op: string, args?: unknown) => Promise<unknown>; signal: AbortSignal }) => Promise<unknown> }} */
let bundle;
/** @type {Map<string, AbortController>} */
const runs = new Map();

/** @param {Record<string, unknown>} frame */
async function onRun(frame) {
  const id = /** @type {string} */ (frame.id);
  const cap = /** @type {string} */ (frame.cap);
  const controller = new AbortController();
  runs.set(id, controller);
  const host = Object.freeze({
    call: (/** @type {string} */ op, /** @type {unknown} */ args) => call(cap, op, args),
    signal: controller.signal,
  });
  try {
    const value = await bundle.run(String(frame.kind), String(frame.name), frame.input, host);
    try {
      send({ t: "done", id, ok: true, value: value === undefined ? null : value });
    } catch (error) {
      send({ t: "done", id, ok: false, error });
    }
  } catch (error) {
    send({ t: "done", id, ok: false, error: error instanceof Error ? error : new Error(String(error)) });
  } finally {
    runs.delete(id);
  }
}

const reader = new FrameReader((frame) => {
  switch (frame.t) {
    case "run":
      void onRun(frame);
      return;
    case "reply": {
      const pending = calls.get(String(frame.id));
      if (!pending) return;
      calls.delete(String(frame.id));
      if (frame.ok === true) pending.resolve(frame.value);
      else pending.reject(frame.error instanceof Error ? frame.error : new Error("refused"));
      return;
    }
    case "cancel":
      runs.get(String(frame.id))?.abort();
      return;
    case "ping":
      send({ t: "pong", id: frame.id });
      return;
    default:
      return;
  }
});

input.on("data", (chunk) => {
  try {
    reader.push(/** @type {Buffer} */ (chunk));
  } catch {
    process.exit(1);
  }
});
// The platform went away: nothing more to do.
input.on("end", () => process.exit(0));
input.on("error", () => process.exit(0));
output.on("error", () => process.exit(0));

// A run that forgot a promise shouldn't end the others.
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`mixos runner: unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}\n`);
});

// 5. The bundle, last: nothing above is reachable from it any more.
async function main() {
  const bundlePath = process.argv[2];
  if (!bundlePath) refuseToStart("no bundle named");
  try {
    bundle = await import(pathToFileURL(bundlePath).href);
    if (typeof bundle.run !== "function") throw new Error("the bundle exports no run()");
  } catch (error) {
    // Say why, then go: the platform reads this as a failed start.
    output.end(encodeFrame({ t: "failed", error: error instanceof Error ? error : new Error(String(error)) }), () =>
      process.exit(1),
    );
    return;
  }
  send({ t: "ready" });
}

void main();
