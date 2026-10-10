/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listAppMigrations } from "./app-migration-files";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-app-migrations-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function write(rel: string, contents = "") {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), contents);
}

test("every app directory, with its .sql migrations in the order they apply", () => {
  write("apps/sales/migrations/002_status.sql");
  write("apps/sales/migrations/001_orders.sql");
  write("apps/sales/migrations/README.md");
  write("apps/notes/app.json", "{}");
  write("apps/_template/migrations/001_example.sql");
  write("apps/AGENTS.md");

  assert.deepEqual(listAppMigrations(path.join(root, "apps")), [
    { slug: "notes", files: [] },
    { slug: "sales", files: ["001_orders.sql", "002_status.sql"] },
  ]);
});

test("a checkout without apps/ has none", () => {
  assert.deepEqual(listAppMigrations(path.join(root, "missing")), []);
});
