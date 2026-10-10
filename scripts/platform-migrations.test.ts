/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The runner refuses a directory where two migrations share a number before it
 * asks the database anything. Needs only Node: the client is a stand-in that
 * records each query and fails it, so none should arrive.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Sql } from "postgres";
import { migratePlatform } from "./platform-migrations";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-platform-runner-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function directory(name: string, files: string[]): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  for (const file of files) fs.writeFileSync(path.join(dir, file), "select 1;\n");
  return dir;
}

/** A client that records what reached it, and fails it. */
function recordingClient(queries: string[]): Sql {
  const reached = (query: string): never => {
    queries.push(query);
    throw new Error(`the database was asked: ${query}`);
  };
  const client = (strings: TemplateStringsArray) => reached(strings.join("$").trim());
  return Object.assign(client, {
    begin: () => reached("begin"),
    unsafe: (query: string) => reached(query),
  }) as unknown as Sql;
}

test("two files with one number are refused before the first query", async () => {
  const dir = directory("duplicate", [
    "0001_initial.sql",
    "0002_keep_app_data.sql",
    "0002_app_mcp_tool_settings.sql",
  ]);
  const queries: string[] = [];
  await assert.rejects(
    migratePlatform(recordingClient(queries), dir, () => {}),
    (err: Error) => {
      assert.match(err.message, /0002_app_mcp_tool_settings\.sql and 0002_keep_app_data\.sql/);
      assert.match(err.message, /0003, the next free number/);
      return true;
    },
  );
  assert.deepEqual(queries, []);
});

test("one file per number goes on to the database", async () => {
  const dir = directory("distinct", ["0001_initial.sql", "0002_keep_app_data.sql"]);
  const queries: string[] = [];
  await assert.rejects(migratePlatform(recordingClient(queries), dir, () => {}), /the database was asked/);
  assert.deepEqual(queries, ["show server_version_num"]);
});
