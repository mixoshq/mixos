/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The registry generator's copies in public/: each recorded before it is made,
 * and at the end of a full run, the ones it no longer makes deleted. Nothing
 * else in public/ is ever touched. Each test works in a public/ of its own.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PublicCopies } from "./public-copies";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mixos-public-copies-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function checkout() {
  const root = path.join(tmp, `checkout-${n++}`);
  const pub = path.join(root, "public");
  const record = path.join(root, "src", "generated", "public-copies.json");
  fs.mkdirSync(pub, { recursive: true });
  const has = (rel: string) => fs.existsSync(path.join(pub, rel));
  const put = (rel: string) => {
    fs.mkdirSync(path.dirname(path.join(pub, rel)), { recursive: true });
    fs.writeFileSync(path.join(pub, rel), "x");
  };
  const recorded = () => JSON.parse(fs.readFileSync(record, "utf-8")).copies as string[];
  /** A full run that copies into each of `folders`, `place/name`, and finishes. */
  const run = (folders: string[]) => {
    const copies = new PublicCopies(pub, record);
    for (const f of folders) {
      const [place, name] = [f.slice(0, f.lastIndexOf("/")), f.slice(f.lastIndexOf("/") + 1)];
      const dir = copies.folder(place as Parameters<PublicCopies["folder"]>[0], name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "file.png"), "x");
    }
    return copies.prune();
  };
  return { root, pub, record, has, put, recorded, run };
}

test("a copy is recorded before it is made, and a later run that doesn't make it deletes it", () => {
  const c = checkout();
  assert.deepEqual(c.run(["themes/aurora", "themes/dusk", "screenshots/themes/dusk", "connector-assets/probe"]), []);
  assert.deepEqual(c.recorded(), ["connector-assets/probe", "screenshots/themes/dusk", "themes/aurora", "themes/dusk"]);

  // dusk and probe were removed: their copies go, aurora's stays.
  assert.deepEqual(c.run(["themes/aurora"]), ["connector-assets/probe", "screenshots/themes/dusk", "themes/dusk"]);
  assert.equal(c.has("themes/aurora/file.png"), true);
  assert.equal(c.has("themes/dusk"), false);
  assert.equal(c.has("screenshots/themes/dusk"), false);
  assert.equal(c.has("connector-assets/probe"), false);
  assert.deepEqual(c.recorded(), ["themes/aurora"]);
});

test("every place: an app's screenshots and brand marks go when it does", () => {
  const c = checkout();
  c.run(["screenshots/apps/files", "branding/apps/files", "screenshots/apps/notes"]);
  assert.deepEqual(c.run(["screenshots/apps/notes"]), ["branding/apps/files", "screenshots/apps/files"]);
  assert.equal(c.has("screenshots/apps/notes/file.png"), true);
});

test("never touches what it didn't record: the rest of public/, or a folder someone else put there", () => {
  const c = checkout();
  c.put("icon-512.png");
  c.put("sw.js");
  c.put("themes/hand-made/logo.svg");
  c.put("screenshots/other/x.png");
  c.run(["themes/aurora"]);
  c.run([]);
  for (const rel of ["icon-512.png", "sw.js", "themes/hand-made/logo.svg", "screenshots/other/x.png"]) {
    assert.equal(c.has(rel), true, rel);
  }
  assert.equal(c.has("themes/aurora"), false);
});

test("a link where a copy was is left alone, and dropped from the record", () => {
  const c = checkout();
  c.run(["themes/aurora"]);
  const outside = path.join(c.root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "keep.txt"), "x");
  fs.rmSync(path.join(c.pub, "themes", "aurora"), { recursive: true });
  fs.symlinkSync(outside, path.join(c.pub, "themes", "aurora"));
  assert.deepEqual(c.run([]), []);
  assert.equal(fs.existsSync(path.join(outside, "keep.txt")), true);
  assert.equal(fs.lstatSync(path.join(c.pub, "themes", "aurora")).isSymbolicLink(), true);
  assert.deepEqual(c.recorded(), []);
});

test("a run that stops partway deletes nothing, and the next run deletes what it would have", () => {
  const c = checkout();
  c.run(["themes/aurora", "themes/dusk"]);
  // A run that copies a new theme, then stops before it prunes.
  const stopped = new PublicCopies(c.pub, c.record);
  fs.mkdirSync(stopped.folder("themes", "fresh"), { recursive: true });
  assert.deepEqual(c.recorded(), ["themes/aurora", "themes/dusk", "themes/fresh"]);
  assert.equal(c.has("themes/dusk"), true);
  // fresh was removed before the next run: it is still deleted, since a run made it.
  assert.deepEqual(c.run(["themes/aurora"]), ["themes/dusk", "themes/fresh"]);
});

test("a record that isn't one, or names somewhere else, deletes nothing", () => {
  const c = checkout();
  c.put("elsewhere/a.txt");
  c.put("themes/x/a.txt");
  fs.mkdirSync(path.dirname(c.record), { recursive: true });
  for (const text of [
    "not json",
    JSON.stringify({ copies: "themes/x" }),
    JSON.stringify({ copies: ["elsewhere", "themes", "themes/", "themes/..", "themes/../elsewhere", "themes/.x", "public/themes/x", "themes/x/y", 7] }),
  ]) {
    fs.writeFileSync(c.record, text);
    assert.deepEqual(new PublicCopies(c.pub, c.record).prune(), []);
    assert.equal(c.has("elsewhere/a.txt"), true);
    assert.equal(c.has("themes/x/a.txt"), true);
  }
  assert.throws(() => new PublicCopies(c.pub, c.record).folder("themes", "../elsewhere"));
});
