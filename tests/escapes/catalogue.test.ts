/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The escape suite's catalogue holds together: every test it names exists,
 * every threat-model row it backs is in the threat model, and every label's
 * escapes are cases in it. Plus the one case with no test elsewhere.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ESCAPES } from "./catalogue";
import { LABELS } from "@/lib/apps/labels";
import { resolveAuthTier } from "@/lib/apps/auth-tier";

const REPO = path.resolve(__dirname, "../..");

test("every test the catalogue names exists, by file and name", () => {
  const missing: string[] = [];
  for (const c of ESCAPES) {
    assert.ok(c.tests.length > 0, `${c.id} names no test`);
    for (const t of c.tests) {
      const file = path.join(REPO, t.file);
      const source = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      const named = [`test("${t.name}"`, `test(\`${t.name}\``, `test('${t.name}'`].some((s) => source.includes(s));
      if (!named) missing.push(`${c.id}: ${t.file} — "${t.name}"`);
    }
  }
  assert.deepEqual(missing, []);
});

test("every case backs a row the threat model has, and ids are unique", () => {
  const model = fs.readFileSync(path.join(REPO, "docs/threat-model.md"), "utf8");
  for (const c of ESCAPES) assert.ok(model.includes(c.threatModelRow), `${c.id}: no row "${c.threatModelRow}"`);
  assert.equal(new Set(ESCAPES.map((c) => c.id)).size, ESCAPES.length);
});

test("every label's escapes are cases here, so no label rests on nothing", () => {
  const ids = new Set(ESCAPES.map((c) => c.id));
  for (const label of Object.values(LABELS)) {
    for (const e of label.escapes) assert.ok(ids.has(e), `${label.id}: no case "${e}"`);
  }
});

test("a known limit is said as one: in-process only, and pinned by a test", () => {
  const limits = ESCAPES.filter((c) => c.outcome.inProcess === "known-limit").map((c) => c.id);
  assert.deepEqual(limits.sort(), ["connector-reads-another", "platform-login", "pool-on-global"]);
});

test("a route that declares only sessions isn't served to the public", async () => {
  assert.deepEqual(await resolveAuthTier({ appSlug: "notes", accepted: ["session"], mount: "public" }), {
    kind: "not-served",
  });
  assert.deepEqual(await resolveAuthTier({ appSlug: "notes", accepted: ["key", "password"], mount: "authenticated" }), {
    kind: "not-served",
  });
});
