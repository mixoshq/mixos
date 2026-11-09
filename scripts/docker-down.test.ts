/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `npm run docker:down` and `npm run docker:reset`, against stand-ins for
 * `docker` and the Supabase CLI that record their arguments and touch nothing.
 * The script resolves every path from the directory above it, so it runs from
 * a scratch copy of scripts/ whose node_modules/.bin/supabase is the stand-in,
 * and whose PATH puts a stand-in `docker` first. The instance claims are read
 * from a scratch MIXOS_STATE_DIR, never from this machine's ~/.mixos.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(__dirname, "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-docker-down-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

let checkouts = 0;

/** A checkout with the files docker-down.ts looks for, and the stand-ins. */
function checkout(files: Record<string, string> = {}) {
  const root = path.join(scratch, `checkout-${checkouts++}`);
  fs.cpSync(path.join(REPO, "scripts"), path.join(root, "scripts"), { recursive: true });
  const log = path.join(root, "calls.log");
  const standIn = `#!/bin/sh\necho "$(basename "$0") $*" >> "${log}"\n`;
  for (const [rel, contents] of Object.entries({
    "bin/docker": standIn,
    "node_modules/.bin/supabase": standIn,
    "docker-compose.yml": "",
    ".env.docker.local": "",
    "supabase/config.toml": 'project_id = "env(MIXOS_INSTANCE)"\n',
    ...files,
  })) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), contents, { mode: 0o755 });
  }
  return { root, log };
}

const STATE = path.join(scratch, "state");

/** Run docker-down.ts from `root`, with no MIXOS_* from this shell. */
function run(root: string, args: string[] = []) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("MIXOS_")) delete env[k];
  env.MIXOS_STATE_DIR = STATE;
  env.PATH = `${path.join(root, "bin")}${path.delimiter}${process.env.PATH ?? ""}`;
  return spawnSync(
    process.execPath,
    ["--import", "tsx", path.join(root, "scripts", "docker-down.ts"), ...args],
    { cwd: REPO, encoding: "utf8", env },
  );
}

function calls(root: string): string[] {
  const log = path.join(root, "calls.log");
  return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
}

function down(root: string, args: string[] = []): string[] {
  const result = run(root, args);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return calls(root);
}

const SECOND_INSTANCE = { ".env.instance": "MIXOS_INSTANCE=mixos-dev\nMIXOS_PORT=3001\n" };

test("docker:down stops this checkout's instance, in both halves", () => {
  const { root } = checkout(SECOND_INSTANCE);
  const calls = down(root);
  assert.ok(calls.includes("docker compose -p mixos-dev --profile dev --profile prod down"), calls.join("\n"));
  assert.ok(calls.includes("supabase stop --project-id mixos-dev"), calls.join("\n"));
});

test("docker:reset deletes this checkout's database and no other's", () => {
  const { root } = checkout(SECOND_INSTANCE);
  const calls = down(root, ["--reset", "--yes"]);
  assert.ok(calls.includes("supabase stop --project-id mixos-dev --no-backup"), calls.join("\n"));
  assert.ok(!calls.some((c) => c.includes("--project-id mixos ")), calls.join("\n"));
});

test("a checkout with no .env.instance is still the mixos instance", () => {
  const { root } = checkout();
  const calls = down(root);
  assert.ok(calls.includes("docker compose -p mixos --profile dev --profile prod down"), calls.join("\n"));
  assert.ok(calls.includes("supabase stop --project-id mixos"), calls.join("\n"));
});

test("another checkout's instance is neither stopped nor reset from here", () => {
  const owner = checkout(SECOND_INSTANCE);
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(
    path.join(STATE, "instances.json"),
    JSON.stringify({
      version: 1,
      instances: { "mixos-dev": { checkout: owner.root, portBase: 54340, inspectorPort: 8084 } },
    }),
  );
  try {
    const { root } = checkout(SECOND_INSTANCE);
    const result = run(root, ["--reset", "--yes"]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /belongs to another checkout/);
    assert.ok(!calls(root).some((c) => c.startsWith("supabase ") || c.includes(" down")), calls(root).join("\n"));
  } finally {
    fs.rmSync(STATE, { recursive: true, force: true });
  }
});
