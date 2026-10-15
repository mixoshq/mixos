/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CORE_EXTENSIONS, strayExtensions } from "./core-extensions";

test("the core's own extensions, and the kinds' top-level files, aren't stray", () => {
  assert.deepEqual(
    strayExtensions([
      "apps/AGENTS.md",
      "apps/_template/app.json",
      "apps/wall-e/api/hello/route.ts",
      "connectors/AGENTS.md",
      "connectors/_template/connector.json",
      "connectors/_template-oauth/index.ts",
      "themes/AGENTS.md",
      "themes/_template/theme.json",
      "themes/mixos/theme.json",
      "themes/mixos-dark/assets/logo.svg",
      "src/lib/apps/access.ts",
    ]),
    [],
  );
});

test("any other extension is named once, by its folder, whatever it holds", () => {
  assert.deepEqual(
    strayExtensions([
      "apps/careers/app.json",
      "apps/careers/migrations/001_profile.sql",
      "apps/careers/plans/20260825_2352-convert-project-career.md",
      "connectors/google-sheets/connector.json",
      "themes/aurora/theme.json",
      "apps/key-numbers/.registry.json",
    ]),
    ["apps/careers", "apps/key-numbers", "connectors/google-sheets", "themes/aurora"],
  );
});

test("names are matched exactly", () => {
  assert.deepEqual(strayExtensions(["apps/Wall-E/app.json", "themes/mixos-light/theme.json"]), [
    "apps/Wall-E",
    "themes/mixos-light",
  ]);
});

test("the list is what main carries", () => {
  const root = path.resolve(__dirname, "..");
  for (const [kind, names] of Object.entries(CORE_EXTENSIONS)) {
    for (const name of names) {
      assert.ok(fs.statSync(path.join(root, kind, name)).isDirectory(), `${kind}/${name} exists`);
    }
  }
});
