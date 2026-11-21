/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Global search's pure rules: filling a link template (src/lib/search/link.ts),
 * and the person's source order and when search is available
 * (src/lib/search/types.ts). The link shapes the build accepts are tested
 * with the manifest schema (scripts/manifest-schemas.test.ts).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { fillSearchLink } from "./link";
import { APPS_SOURCE, mergeOrder, orderSources, searchAvailable } from "./types";

// ── fillSearchLink ──────────────────────────────────────────────────────────

test("a link fills {id} into the query string, under the app", () => {
  assert.equal(fillSearchLink("notes-3f9a2c1b", "notes?id={id}", { id: "n_1" }), "/apps/notes-3f9a2c1b/notes?id=n_1");
  assert.equal(fillSearchLink("notes-3f9a2c1b", "?id={id}", { id: "n_1" }), "/apps/notes-3f9a2c1b?id=n_1");
  assert.equal(fillSearchLink("notes-3f9a2c1b", "notes/archive", { id: "n_1" }), "/apps/notes-3f9a2c1b/notes/archive");
});

test("a link fills other placeholders from params and keeps literal values", () => {
  assert.equal(
    fillSearchLink("boards-3f9a2c1b", "cards?card={id}&board={board}&tab=details", {
      id: "c_9",
      params: { board: "b_2" },
    }),
    "/apps/boards-3f9a2c1b/cards?card=c_9&board=b_2&tab=details",
  );
});

test("every filled value is URL-encoded, so a result can't leave its app", () => {
  const href = fillSearchLink("notes-3f9a2c1b", "notes?id={id}", { id: "../../admin?x=1&y=//evil.example#frag" });
  assert.equal(href, "/apps/notes-3f9a2c1b/notes?id=..%2F..%2Fadmin%3Fx%3D1%26y%3D%2F%2Fevil.example%23frag");
  assert.ok(href!.startsWith("/apps/notes-3f9a2c1b/notes?"));
});

test("a result missing a param its link needs gets no link", () => {
  assert.equal(fillSearchLink("boards-3f9a2c1b", "cards?card={id}&board={board}", { id: "c_9" }), null);
  assert.equal(fillSearchLink("boards-3f9a2c1b", "cards?card={id}&board={board}", { id: "c_9", params: {} }), null);
});

// ── order and availability ─────────────────────────────────────────────────

test("sources follow the person's order, then the rest in build order", () => {
  const keys = [APPS_SOURCE, "notes", "tasks", "crm"];
  assert.deepEqual(orderSources(keys, []), keys);
  assert.deepEqual(orderSources(keys, ["crm", "notes"]), ["crm", "notes", APPS_SOURCE, "tasks"]);
  // An uninstalled app in the stored order is skipped; a repeat counts once.
  assert.deepEqual(orderSources(keys, ["gone", "tasks", "tasks", APPS_SOURCE]), ["tasks", APPS_SOURCE, "notes", "crm"]);
});

test("a reorder keeps the stored places of sources not shown right now", () => {
  assert.deepEqual(mergeOrder(["tasks", "notes"], ["notes", "gone", "tasks"]), ["tasks", "notes", "gone"]);
  assert.deepEqual(mergeOrder(["notes"], []), ["notes"]);
});

test("search is available while the icon or the shortcut is on", () => {
  assert.equal(searchAvailable({ showIcon: true, shortcutEnabled: true }), true);
  assert.equal(searchAvailable({ showIcon: false, shortcutEnabled: true }), true);
  assert.equal(searchAvailable({ showIcon: true, shortcutEnabled: false }), true);
  assert.equal(searchAvailable({ showIcon: false, shortcutEnabled: false }), false);
});
