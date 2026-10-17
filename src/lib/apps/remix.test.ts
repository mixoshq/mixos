/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalJson,
  describeAnchor,
  editedRemixEntries,
  licenseVerdict,
  normalizeRemixKeyword,
  normalizeRemixKeywords,
  parseAnchor,
  remixEntriesFromAppJson,
  remixesFrom,
  remixesInto,
  type RemixIndexEntry,
} from "./remix";

// ── anchors ─────────────────────────────────────────────────────────────────

test("anchors name a widget, a page, a route or a job", () => {
  assert.deepEqual(parseAnchor("widget:application-pipeline"), { kind: "widget", id: "application-pipeline" });
  assert.deepEqual(parseAnchor("page:/"), { kind: "page", path: "/" });
  assert.deepEqual(parseAnchor("page:/tracker/[id]"), { kind: "page", path: "/tracker/[id]" });
  assert.deepEqual(parseAnchor("route:PATCH /applications/[id]"), {
    kind: "route",
    method: "PATCH",
    path: "/applications/[id]",
  });
  assert.deepEqual(parseAnchor("job:monday-summary"), { kind: "job", name: "monday-summary" });
});

test("anything else is not an anchor", () => {
  for (const bad of [
    "",
    "widget",
    "widget:",
    "widget:Pipeline",
    "page:tracker",
    "page:/../x",
    "page://",
    "route:FETCH /x",
    "route:GET",
    "route:GET x",
    "route:get /x",
    "table:roles",
    "job:../x",
  ]) {
    assert.equal(parseAnchor(bad), null, bad);
  }
});

test("an anchor reads as a phrase", () => {
  assert.equal(describeAnchor("page:/"), "main page");
  assert.equal(describeAnchor("route:DELETE /applications/[id]"), "DELETE /applications/[id]");
  assert.equal(describeAnchor("widget:pipeline"), "widget pipeline");
});

// ── keywords ────────────────────────────────────────────────────────────────

test("keywords are lowercased and hyphenated, punctuation dropped", () => {
  assert.equal(normalizeRemixKeyword("Status Table"), "status-table");
  assert.equal(normalizeRemixKeyword("  inline_status "), "inline-status");
  assert.equal(normalizeRemixKeyword("CRUD/dialogs!"), "crud-dialogs");
  assert.equal(normalizeRemixKeyword("a -- b"), "a-b");
});

test("synonyms merge, and words that describe nothing drop out", () => {
  assert.equal(normalizeRemixKeyword("DnD"), "drag-and-drop");
  assert.equal(normalizeRemixKeyword("drag drop"), "drag-and-drop");
  assert.equal(normalizeRemixKeyword("Data Grid"), "table");
  assert.equal(normalizeRemixKeyword("feature"), null);
  assert.equal(normalizeRemixKeyword("UI"), null);
  assert.equal(normalizeRemixKeyword("!!!"), null);
});

test("no stemming: a word ending in s is left as it is", () => {
  assert.equal(normalizeRemixKeyword("status"), "status");
  assert.equal(normalizeRemixKeyword("stats"), "stats");
});

test("a list keeps its order and loses repeats", () => {
  assert.deepEqual(normalizeRemixKeywords(["kanban", "dnd", "Drag and Drop", "page", "pipeline"]), [
    "kanban",
    "drag-and-drop",
    "pipeline",
  ]);
});

// ── edits ───────────────────────────────────────────────────────────────────

const entry = {
  remixedAt: "2026-10-16",
  source: { app: "careers", anchors: ["page:/"], commitSha: null, commitFrom: "git", modified: true, registry: null },
  summary: "Status table",
  keywords: ["status-table", "inline-status"],
  license: { spdx: "MPL-2.0", mode: "adapted" },
  actions: { "change-status": "same", delete: "remove" },
  landedIn: ["pages/deals.tsx"],
};

test("an unchanged entry, reordered keys and all, is not an edit", () => {
  const reordered = Object.fromEntries(Object.entries(entry).reverse());
  assert.deepEqual(editedRemixEntries([entry], [reordered]), []);
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
});

test("changing anything in an existing entry is an edit", () => {
  const changed = { ...entry, actions: { ...entry.actions, delete: "same" } };
  assert.deepEqual(editedRemixEntries([entry], [changed]), ["careers page:/ 2026-10-16"]);
});

test("adding and deleting entries are not edits", () => {
  const another = { ...entry, remixedAt: "2026-11-01" };
  assert.deepEqual(editedRemixEntries([], [entry]), []);
  assert.deepEqual(editedRemixEntries([entry], []), []);
  assert.deepEqual(editedRemixEntries([entry], [entry, another]), []);
});

test("remixedFrom is read from app.json text, and missing or broken text is empty", () => {
  assert.deepEqual(remixEntriesFromAppJson(JSON.stringify({ name: "x", remixedFrom: [entry] })), [entry]);
  assert.deepEqual(remixEntriesFromAppJson(JSON.stringify({ name: "x" })), []);
  assert.deepEqual(remixEntriesFromAppJson("{not json"), []);
  assert.deepEqual(remixEntriesFromAppJson(null), []);
});

// ── the index ───────────────────────────────────────────────────────────────

function indexed(app: string, source: string, remixedAt: string): RemixIndexEntry {
  return {
    app,
    keywords: ["status-table"],
    entry: {
      ...(entry as unknown as RemixIndexEntry["entry"]),
      remixedAt,
      source: {
        ...(entry.source as unknown as RemixIndexEntry["entry"]["source"]),
        app: source,
      },
    },
  };
}

test("an app's remixes, both ways, newest first", () => {
  const index = [
    indexed("deals", "careers", "2026-10-01"),
    indexed("deals", "tasks", "2026-10-09"),
    indexed("hiring", "deals", "2026-10-12"),
  ];
  assert.deepEqual(remixesFrom(index, "deals").map((r) => r.entry.source.app), ["tasks", "careers"]);
  // hiring remixed deals' copy: it is credited to deals, and not to careers.
  assert.deepEqual(remixesInto(index, "careers").map((r) => r.app), ["deals"]);
  assert.deepEqual(remixesInto(index, "deals").map((r) => r.app), ["hiring"]);
});

// ── license ─────────────────────────────────────────────────────────────────

test("permissive licenses and MPL-2.0 may be adapted", () => {
  for (const spdx of ["MIT", "Apache-2.0", "BSD-3-Clause", "ISC", "CC0-1.0", "MPL-2.0", "Apache-2.0 WITH LLVM-exception"]) {
    assert.equal(licenseVerdict(spdx, "UNLICENSED").mode, "adapted", spdx);
  }
});

test("no license, or UNLICENSED, is rebuilt", () => {
  assert.equal(licenseVerdict(null, "MIT").mode, "rebuilt");
  assert.equal(licenseVerdict(undefined, "MIT").mode, "rebuilt");
  assert.equal(licenseVerdict("UNLICENSED", "MIT").mode, "rebuilt");
});

test("GPL-family code is adapted only into an app with the same license", () => {
  assert.equal(licenseVerdict("GPL-3.0-only", "GPL-3.0-only").mode, "adapted");
  assert.equal(licenseVerdict("AGPL-3.0-or-later", "AGPL-3.0-or-later").mode, "adapted");
  assert.equal(licenseVerdict("GPL-3.0-only", "MPL-2.0").mode, "rebuilt");
  assert.match(licenseVerdict("GPL-3.0-only", "MPL-2.0").reason, /same license/);
  assert.equal(licenseVerdict("LGPL-2.1-only", null).mode, "rebuilt");
});

test("expressions: OR needs one acceptable side, AND needs both", () => {
  assert.equal(licenseVerdict("GPL-3.0-only OR MIT", "MPL-2.0").mode, "adapted");
  assert.equal(licenseVerdict("MIT AND GPL-3.0-only", "MPL-2.0").mode, "rebuilt");
  assert.equal(licenseVerdict("MIT AND Apache-2.0", "MPL-2.0").mode, "adapted");
});

test("what it can't read, it rebuilds", () => {
  assert.equal(licenseVerdict("SomeCustom-1.0", "MIT").mode, "rebuilt");
  assert.equal(licenseVerdict("(MIT OR GPL-3.0-only)", "MIT").mode, "rebuilt");
});
