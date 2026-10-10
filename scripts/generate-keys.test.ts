/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `npm run keys:generate` and `npm run keys:check`, run as the CLI. Every key
 * is passed explicitly, set or empty, so a .env.local in this checkout cannot
 * fill one in: the loader never overrides a variable that is already present.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { PLATFORM_KEYS } from "../src/lib/env/keys";

const REPO = path.resolve(__dirname, "..");
const PLATFORM = Object.values(PLATFORM_KEYS).map((k) => k.env);
const EVERY_KEY = ["AUTH_SECRET", "CRON_SECRET", ...PLATFORM];

function keys(args: string[], env: Record<string, string> = {}) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", path.join(REPO, "scripts", "generate-keys.ts"), ...args],
    {
      cwd: REPO,
      encoding: "utf8",
      // ProcessEnv's type requires a NODE_ENV, which nothing here reads.
      env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv,
    },
  );
}

/** Every key, freshly generated, with `overrides` on top. */
function environment(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of EVERY_KEY) env[name] = randomBytes(32).toString("hex");
  return { ...env, ...overrides };
}

/** The `NAME=value` lines a run printed. */
function assignments(stdout: string): Map<string, string> {
  return new Map(
    [...stdout.matchAll(/^([A-Z_]+)=(.*)$/gm)].map((m) => [m[1], m[2]] as [string, string]),
  );
}

test("keys:generate prints a fresh value for every key a deployment needs", () => {
  const run = keys([]);
  assert.equal(run.status, 0, run.stderr);
  const printed = assignments(run.stdout);
  assert.deepEqual([...printed.keys()].sort(), [...EVERY_KEY].sort());
  for (const [name, value] of printed) assert.match(value, /^[0-9a-f]{64}$/, name);
  assert.equal(new Set(printed.values()).size, EVERY_KEY.length, "two keys share a value");
});

test("keys:check fails while AUTH_SECRET or CRON_SECRET is unset, naming each", () => {
  const run = keys(["--check"], environment({ AUTH_SECRET: "", CRON_SECRET: "" }));
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stderr, /AUTH_SECRET/);
  assert.match(run.stderr, /CRON_SECRET/);
});

test("keys:check passes when every key is set", () => {
  const run = keys(["--check"], environment());
  assert.equal(run.status, 0, run.stderr);
});

test("--missing prints only the keys that are not set", () => {
  const run = keys(["--missing"], environment({ AUTH_SECRET: "", MCP_TOKEN_KEY: "too-short" }));
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual([...assignments(run.stdout).keys()].sort(), ["AUTH_SECRET", "MCP_TOKEN_KEY"]);
});
