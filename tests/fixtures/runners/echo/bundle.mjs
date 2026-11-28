/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// @ts-check

/**
 * The echo runner's bundle, for src/lib/runners/supervisor.test.ts and
 * scripts/bench-runner.ts. Each run name does one thing, and "probe" tries
 * every way out of a runner that its permission model and bootstrap close.
 */

/** @type {{ call: (op: string, args?: unknown) => Promise<unknown> } | null} */
let stashed = null;

/** @param {() => unknown | Promise<unknown>} attempt */
async function outcome(attempt) {
  try {
    await attempt();
    return "allowed";
  } catch (error) {
    // The code that says why, wherever it is in the chain of causes.
    /** @type {any} */
    let e = error;
    while (e) {
      if (typeof e.code === "string") return e.code;
      if (!e.cause) return e.name ?? "threw";
      e = e.cause;
    }
    return "threw";
  }
}

/** @param {{ outside: string }} input */
async function probe(input) {
  const net = await import("node:net");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const dgram = await import("node:dgram");
  return {
    // Not port 9: fetch refuses that one itself, before the permission model.
    fetch: await outcome(() => fetch("http://127.0.0.1:3999/")),
    socket: await outcome(
      () =>
        new Promise((resolve, reject) => {
          const s = net.connect(9, "127.0.0.1", () => resolve(s.end()));
          s.on("error", reject);
        }),
    ),
    unixSocket: await outcome(
      () =>
        new Promise((resolve, reject) => {
          const s = net.connect(new URL("./no.sock", import.meta.url).pathname, () => resolve(s.end()));
          s.on("error", reject);
        }),
    ),
    udp: await outcome(
      async () =>
        new Promise((resolve, reject) => {
          const d = (/** @type {typeof import("node:dgram")} */ (dgram)).createSocket("udp4");
          d.on("error", reject);
          d.bind(0, () => resolve(d.close()));
        }),
    ),
    dns: await outcome(async () => (await import("node:dns/promises")).lookup("localhost")),
    wasi: await outcome(async () => new (await import("node:wasi")).WASI({ version: "preview1" })),
    addon: await outcome(() => process.dlopen({ exports: {} }, new URL("./none.node", import.meta.url).pathname)),
    report: await outcome(() => process.report.writeReport(new URL("./report.json", import.meta.url).pathname)),
    readOutside: await outcome(() => fs.readFileSync(input.outside)),
    write: await outcome(() => fs.writeFileSync(new URL("./written.txt", import.meta.url), "x")),
    childProcess: await outcome(async () => (await import("node:child_process")).execFileSync("true")),
    worker: await outcome(async () => new (await import("node:worker_threads")).Worker("0", { eval: true })),
    inspector: await outcome(async () => new (await import("node:inspector")).Session().connect()),
    signalPlatform: await outcome(() => process.kill(process.ppid, 0)),
    debugPlatform: await outcome(() => /** @type {any} */ (process)._debugProcess(process.ppid)),
    priority: await outcome(() => os.setPriority(process.ppid, 0)),
    binding: await outcome(() => /** @type {any} */ (process).binding("fs")),
    env: Object.keys(process.env).length,
  };
}

/**
 * @param {string} _kind
 * @param {string} name
 * @param {any} input
 * @param {{ call: (op: string, args?: unknown) => Promise<unknown>; signal: AbortSignal }} host
 */
export async function run(_kind, name, input, host) {
  switch (name) {
    case "echo":
      return input;
    case "call":
      return host.call(input.op, input.args);
    case "calls":
      return Promise.all(Array.from({ length: input.n }, () => host.call(input.op, input.args)));
    case "sleep":
      await new Promise((resolve) => setTimeout(resolve, input.ms));
      return "slept";
    case "spin":
      for (;;) {
        // A loop that never yields: the heartbeat finds it.
      }
    case "throw":
      throw Object.assign(new Error(input.message), { category: "bad-request", secretStack: "kept out" });
    case "crash":
      process.exit(3);
      return null;
    case "stash":
      stashed = host;
      return "stashed";
    case "replay":
      if (!stashed) throw new Error("nothing stashed");
      return stashed.call(input.op, input.args);
    case "probe":
      return probe(input);
    default:
      throw new Error(`no run named ${name}`);
  }
}
