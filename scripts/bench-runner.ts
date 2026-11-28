/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What a runner costs (Items 5b and 7b, step 1): a cold start, a run's round
 * trip, and a call back to the platform from inside a run, with the echo
 * bundle (tests/fixtures/runners/echo/bundle.mjs).
 *
 *   npm run bench:runner
 *
 * Prints the median and 95th percentile of each, in milliseconds. A measure,
 * not a check: nothing fails on a slow machine.
 */

import path from "node:path";
import { performance } from "node:perf_hooks";
import { isolationSupport, Runner, type RunScope } from "../src/lib/runners/supervisor";

const ECHO = path.join(process.cwd(), "tests/fixtures/runners/echo/bundle.mjs");
const SCOPE: RunScope = { subject: "echo", userId: "bench", readOnly: false };
const T = { timeoutMs: 10_000 };

function stats(samples: number[]): string {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  return `median ${at(0.5).toFixed(3)} ms, p95 ${at(0.95).toFixed(3)} ms (n=${s.length})`;
}

async function time(n: number, once: () => Promise<unknown>): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await once();
    out.push(performance.now() - t0);
  }
  return out;
}

async function main() {
  const support = isolationSupport();
  if (!support.supported) {
    console.error(`No runner on this host: ${support.reason}`);
    process.exit(1);
  }
  const runner = () => new Runner({ id: "app:echo", bundle: ECHO, onCall: async () => ({ ok: true }), log: () => {} });

  const cold: number[] = [];
  for (let i = 0; i < 10; i++) {
    const r = runner();
    const t0 = performance.now();
    await r.run("echo", "echo", 0, SCOPE, T);
    cold.push(performance.now() - t0);
    await r.stop();
  }

  const r = runner();
  await r.run("echo", "echo", 0, SCOPE, T);
  for (let i = 0; i < 200; i++) await r.run("echo", "echo", i, SCOPE, T);
  const echo = await time(2000, () => r.run("echo", "echo", { a: 1, b: "two" }, SCOPE, T));
  const oneCall = await time(2000, () => r.run("echo", "call", { op: "db.query", args: { sql: "select 1" } }, SCOPE, T));
  const tenCalls = await time(500, () => r.run("echo", "calls", { n: 10, op: "db.query", args: {} }, SCOPE, T));
  await r.stop();

  console.log(`Node ${process.versions.node}, ${process.platform}/${process.arch}`);
  console.log(`cold start to first answer: ${stats(cold)}`);
  console.log(`a run, no calls:            ${stats(echo)}`);
  console.log(`a run making one call:      ${stats(oneCall)}`);
  console.log(`a run making ten at once:   ${stats(tenCalls)}`);
}

void main();
