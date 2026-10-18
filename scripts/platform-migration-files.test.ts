/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  describeDuplicateMigrations,
  duplicateMigrationNumbers,
  duplicatesAdded,
  listPlatformMigrations,
  nextMigrationNumber,
} from "./platform-migration-files";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-platform-migrations-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function directory(name: string, files: string[]): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  for (const file of files) fs.writeFileSync(path.join(dir, file), "");
  return dir;
}

test("the migrations in a directory, in the order they apply", () => {
  // README.md, seed.sql and 0012.sql are not named NNNN_name.sql, so the runner
  // never applies them, and the build must not expect them either.
  const dir = directory("ordered", [
    "0010_tags.sql",
    "0002_status.sql",
    "0001_platform_schema.sql",
    "README.md",
    "seed.sql",
    "0012.sql",
  ]);
  assert.deepEqual(
    listPlatformMigrations(dir).map((m) => [m.version, m.name, m.file]),
    [
      ["0001", "platform_schema", "0001_platform_schema.sql"],
      ["0002", "status", "0002_status.sql"],
      ["0010", "tags", "0010_tags.sql"],
    ],
  );
});

test("two files with one number are refused, naming both and the next free number", () => {
  const dir = directory("duplicate", [
    "0009_notes.sql",
    "0010_tags.sql",
    "0010_pins.sql",
  ]);
  assert.throws(
    () => listPlatformMigrations(dir),
    (err: Error) => {
      assert.match(
        err.message,
        /share the number 0010: 0010_pins\.sql and 0010_tags\.sql\./,
      );
      assert.match(err.message, /to 0011, the next free number/);
      assert.match(err.message, /platform_schema_version to '11'/);
      return true;
    },
  );
});

test("a missing directory is an error, not an empty schema", () => {
  assert.throws(() => listPlatformMigrations(path.join(root, "absent")), /No platform migrations at/);
});

test("numbers compare as numbers", () => {
  assert.deepEqual(duplicateMigrationNumbers(["0012_a.sql", "12_b.sql", "0013_c.sql"]), [
    { version: "0012", files: ["0012_a.sql", "12_b.sql"] },
  ]);
});

test("every file that shares a number is named, and only those", () => {
  const files = ["0001_a.sql", "0002_b.sql", "0002_c.sql", "0002_d.sql", "0003_e.sql", "0003_f.sql"];
  const duplicates = duplicateMigrationNumbers(files);
  assert.deepEqual(duplicates, [
    { version: "0002", files: ["0002_b.sql", "0002_c.sql", "0002_d.sql"] },
    { version: "0003", files: ["0003_e.sql", "0003_f.sql"] },
  ]);
  const message = describeDuplicateMigrations(duplicates, nextMigrationNumber(files));
  assert.match(message, /^ {2}0002: 0002_b\.sql, 0002_c\.sql and 0002_d\.sql$/m);
  assert.match(message, /^ {2}0003: 0003_e\.sql and 0003_f\.sql$/m);
  assert.match(message, /Renumber the ones your branch added from 0004, the next free number/);
});

test("the same file listed twice is one file", () => {
  assert.deepEqual(duplicateMigrationNumbers(["0001_a.sql", "0001_a.sql"]), []);
});

test("the next free number is one past the highest, padded like the rest", () => {
  assert.equal(nextMigrationNumber(["0001_a.sql", "0010_b.sql", "README.md"]), "0011");
  assert.equal(nextMigrationNumber(["supabase/migrations/0099_a.sql"]), "0100");
  assert.equal(nextMigrationNumber(["1_a.sql", "2_b.sql"]), "3");
  assert.equal(nextMigrationNumber([]), "0001");
});

test("a pull request's new migration is held to the ones already there", () => {
  const dir = "supabase/migrations";
  const main = [`${dir}/0010_tags.sql`, `${dir}/0011_on_main.sql`];

  // A number main already has.
  assert.deepEqual(duplicatesAdded([`${dir}/0011_added.sql`], main), [
    { version: "0011", files: [`${dir}/0011_added.sql`, `${dir}/0011_on_main.sql`] },
  ]);

  // One number used twice in the pull request itself.
  assert.deepEqual(duplicatesAdded([`${dir}/0012_a.sql`, `${dir}/0012_b.sql`], main), [
    { version: "0012", files: [`${dir}/0012_a.sql`, `${dir}/0012_b.sql`] },
  ]);

  // The checkout already holds the pull request's own files: still one each.
  assert.deepEqual(duplicatesAdded([`${dir}/0012_a.sql`], [...main, `${dir}/0012_a.sql`]), []);

  // A repeat that was there before is not the pull request's doing.
  const repeated = [...main, `${dir}/0011_also_on_main.sql`];
  assert.deepEqual(duplicatesAdded([`${dir}/0012_a.sql`], repeated), []);
});
