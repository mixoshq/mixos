/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appMigrationFiles, listAppMigrations, undeclaredMigrations } from "./app-migration-files";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-app-migrations-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function write(rel: string, contents = "") {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), contents);
}

write("apps/sales/migrations/002_status.sql");
write("apps/sales/migrations/001_orders.sql");
write("apps/sales/migrations/README.md");
write("apps/notes/app.json", "{}");
write("apps/quotes/migrations/001_quotes.sql");
write("apps/skipped/migrations/001_anything.sql");
write("apps/_template/migrations/001_example.sql");

const apps = path.join(root, "apps");
const registry = [
  { slug: "sales", database: true },
  { slug: "notes", database: true },
  { slug: "quotes", database: false },
];

test("the .sql files of one app, in the order they apply", () => {
  assert.deepEqual(appMigrationFiles(apps, "sales"), ["001_orders.sql", "002_status.sql"]);
  assert.deepEqual(appMigrationFiles(apps, "notes"), []);
});

test("only apps the registry accepted with a database have migrations that run", () => {
  // `skipped` is a folder the generator did not accept and `_template` is a
  // template: neither is in the registry, so neither is listed.
  assert.deepEqual(listAppMigrations(apps, registry), [
    { slug: "notes", files: [] },
    { slug: "sales", files: ["001_orders.sql", "002_status.sql"] },
  ]);
});

test("an accepted app with migrations but no database is reported", () => {
  assert.deepEqual(undeclaredMigrations(apps, registry), [{ slug: "quotes", files: ["001_quotes.sql"] }]);
});

test("a checkout without apps/ has none", () => {
  const missing = path.join(root, "missing");
  assert.deepEqual(listAppMigrations(missing, registry), [
    { slug: "notes", files: [] },
    { slug: "sales", files: [] },
  ]);
  assert.deepEqual(undeclaredMigrations(missing, registry), []);
});
