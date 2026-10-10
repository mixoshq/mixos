/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { pendingAppMigrations } from "./app-migrations";

const expected = [
  { slug: "sales", file: "001_orders.sql" },
  { slug: "sales", file: "002_status.sql" },
  { slug: "notes", file: "001_notes.sql" },
];

test("a file the ledger lacks is pending", () => {
  assert.deepEqual(
    pendingAppMigrations(expected, [
      { app_slug: "sales", migration_file: "001_orders.sql" },
      { app_slug: "notes", migration_file: "001_notes.sql" },
    ]),
    [{ slug: "sales", file: "002_status.sql" }],
  );
});

test("the same file name under another app does not count", () => {
  assert.deepEqual(
    pendingAppMigrations(
      [{ slug: "notes", file: "001_orders.sql" }],
      [{ app_slug: "sales", migration_file: "001_orders.sql" }],
    ),
    [{ slug: "notes", file: "001_orders.sql" }],
  );
});

test("ledger rows the build does not carry are fine", () => {
  assert.deepEqual(
    pendingAppMigrations(expected, [
      ...expected.map((m) => ({ app_slug: m.slug, migration_file: m.file })),
      { app_slug: "removed-app", migration_file: "001_old.sql" },
    ]),
    [],
  );
});
