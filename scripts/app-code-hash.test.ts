/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashFileTree } from "../src/lib/repository/content-hash";
import { appCodeHash } from "./app-code-hash";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-app-code-hash-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

let folders = 0;

/** A fresh app folder holding `files`, by path relative to it. */
function app(files: Record<string, string>): string {
  const dir = path.join(root, `app-${folders++}`);
  for (const [rel, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), contents);
  }
  return dir;
}

const NOTES = {
  "app.json": '{ "name": "Notes" }',
  "api/notes/route.ts": "export const GET = defineRoute({});\n",
  "widgets/latest.tsx": "export default function Latest() { return null; }\n",
  "migrations/001_notes.sql": "create table notes (id int primary key);\n",
};

test("is the content hash of the folder's files, with every mode read as 644", () => {
  const dir = app(NOTES);
  const expected = hashFileTree(
    Object.entries(NOTES).map(([p, text]) => ({ path: p, mode: 0o644, data: Buffer.from(text) })),
  );
  assert.equal(appCodeHash(dir), expected);
  assert.match(appCodeHash(dir)!, /^sha256-[A-Za-z0-9+/]+=*$/);
});

test("two folders with the same files hash the same, wherever they are", () => {
  assert.equal(appCodeHash(app(NOTES)), appCodeHash(app(NOTES)));
});

test("a changed byte, a renamed file or an added file changes it", () => {
  const base = appCodeHash(app(NOTES));
  const edited = app({ ...NOTES, "api/notes/route.ts": "export const GET = defineRoute({ });\n" });
  const { "widgets/latest.tsx": widget, ...rest } = NOTES;
  const renamed = app({ ...rest, "widgets/newest.tsx": widget });
  const added = app({ ...NOTES, "jobs/sweep.ts": "export default async () => {};\n" });
  const hashes = [base, appCodeHash(edited), appCodeHash(renamed), appCodeHash(added)];
  assert.equal(new Set(hashes).size, hashes.length, "two different folders hashed the same");
});

test("execute bits don't change it", () => {
  const plain = app(NOTES);
  const executable = app(NOTES);
  fs.chmodSync(path.join(executable, "api/notes/route.ts"), 0o755);
  assert.equal(appCodeHash(executable), appCodeHash(plain));
});

test("dot entries and node_modules are left out, at any depth", () => {
  const littered = app({
    ...NOTES,
    ".DS_Store": "finder",
    ".registry.json": '{ "source": "https://mixos.org" }',
    ".cache/build.json": "{}",
    "api/.DS_Store": "finder",
    "lib/.hidden/secret.ts": "export {};\n",
    "node_modules/left-pad/index.js": "module.exports = () => {};\n",
    "lib/node_modules/x/index.js": "module.exports = 1;\n",
  });
  assert.equal(appCodeHash(littered), appCodeHash(app(NOTES)));
});

test("a symlink is read through, and a link back up the tree ends there", () => {
  const copied = app({ ...NOTES, "lib/shared.ts": "export const x = 1;\n" });
  const linked = app(NOTES);
  const target = path.join(root, "outside-shared.ts");
  fs.writeFileSync(target, "export const x = 1;\n");
  fs.mkdirSync(path.join(linked, "lib"));
  fs.symlinkSync(target, path.join(linked, "lib/shared.ts"));
  assert.equal(appCodeHash(linked), appCodeHash(copied));

  // A link to an ancestor would otherwise be walked forever; one to nothing is skipped.
  fs.symlinkSync(linked, path.join(linked, "lib/loop"));
  fs.symlinkSync(path.join(root, "does-not-exist"), path.join(linked, "lib/dangling.ts"));
  assert.equal(appCodeHash(linked), appCodeHash(copied));
});

test("an empty folder has a hash, and no folder has none", () => {
  const empty = path.join(root, "empty");
  fs.mkdirSync(empty);
  assert.equal(appCodeHash(empty), hashFileTree([]));
  assert.equal(appCodeHash(path.join(root, "missing")), null);
  const file = path.join(root, "not-a-folder");
  fs.writeFileSync(file, "x");
  assert.equal(appCodeHash(file), null);
});
