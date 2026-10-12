/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * This server recording its own build, at start and on the cron tick: at most
 * every ten minutes from one process, and never a throw. Run as a built
 * deployment (VERCEL set), so no checkout id is read or made here.
 */

import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

const VERCEL = process.env.VERCEL;
process.env.VERCEL = "1";
after(() => {
  if (VERCEL === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = VERCEL;
});

let statements: { text: string; values: unknown[] }[] = [];
let failing = false;
let alreadyRecorded = false;
(globalThis as { __pg?: unknown }).__pg = async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.join("?").replace(/\s+/g, " ").trim();
  statements.push({ text, values });
  if (failing) throw new Error('relation "public.platform_builds_seen" does not exist');
  if (text.startsWith("insert into public.platform_builds_seen")) return alreadyRecorded ? [] : [{ wrote: 1 }];
  if (text.startsWith("delete from public.platform_builds_seen")) return [];
  throw new Error(`unexpected statement: ${text}`);
};

const memory = globalThis as { __mixosBuildSeen?: unknown; __mixosBuildSeenWarned?: boolean };
beforeEach(() => {
  statements = [];
  failing = false;
  alreadyRecorded = false;
  delete memory.__mixosBuildSeen;
  delete memory.__mixosBuildSeenWarned;
});

test("it records what this build carries, under its key, then waits ten minutes", async () => {
  const { recordThisBuild, thisBuild, thisBuildKey } = await import("./this-build");
  const record = thisBuild();
  assert.match(record.key, /^build:[^:]+:[0-9a-f]{16}$/);
  assert.equal(thisBuildKey(), record.key);

  const start = Date.now();
  assert.equal(await recordThisBuild(start), "recorded");
  assert.deepEqual(statements.map((s) => s.text.slice(0, 40)), [
    "insert into public.platform_builds_seen ",
    "delete from public.platform_builds_seen ",
  ]);
  assert.deepEqual(statements[0].values.slice(0, 3), [record.key, record.apps, record.connectors]);

  statements = [];
  assert.equal(await recordThisBuild(start + 9 * 60_000), "skipped");
  assert.deepEqual(statements, []);

  alreadyRecorded = true;
  assert.equal(await recordThisBuild(start + 11 * 60_000), "unchanged");
  assert.equal(statements.length, 1, "it pruned without writing");
});

test("a database it can't write to is said once, and never thrown", async () => {
  const { recordThisBuild } = await import("./this-build");
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (...args: unknown[]) => void warned.push(args.join(" "));
  try {
    failing = true;
    assert.equal(await recordThisBuild(), "failed");
    assert.equal(await recordThisBuild(), "failed");
  } finally {
    console.warn = warn;
  }
  assert.equal(warned.length, 1);
  assert.match(warned[0], /couldn't record which apps and connectors this build carries/);
});
