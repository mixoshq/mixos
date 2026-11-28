/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Labels, from what is enforced: each true exactly when its definition says,
 * and "No public routes" left off when the routes aren't known.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { LABELS, appLabels } from "./labels";
import type { AppManifest } from "./types";

const ids = (app: Parameters<typeof appLabels>[0], tier?: Parameters<typeof appLabels>[1]) =>
  appLabels(app, tier).map((l) => l.id);
const route = (auth: string[]) => ({ path: "x", params: [], methods: [{ method: "GET", auth }] }) as unknown as AppManifest["routes"][number];

test("an app that declares nothing outside itself has every label it can, and runs in the server process", () => {
  assert.deepEqual(ids({ slug: "notes", egress: [], connectorRequirements: [], consumes: [], listensTo: [], routes: [route(["session"])] }), [
    "stays-here",
    "read-only",
    "own-data",
    "no-public-routes",
    "in-process",
  ]);
});

test("each label goes when what it says isn't so", () => {
  assert.ok(!ids({ egress: ["api.example.com"] }).includes("stays-here"));
  assert.ok(
    !ids({ connectorRequirements: [{ name: "crm", optional: true, access: "read", version: "1.0.0" }] }).includes("stays-here"),
  );
  assert.ok(
    !ids({ connectorRequirements: [{ name: "crm", optional: false, access: "write", version: "1.0.0" }] }).includes("read-only"),
  );
  assert.ok(!ids({ consumes: [{ app: "files", service: "list" }] }).includes("own-data"));
  assert.ok(!ids({ slug: "notes", listensTo: [{ app: "files", hook: "added" }] }).includes("own-data"));
  // Its own hooks are its own data.
  assert.ok(ids({ slug: "notes", listensTo: [{ app: "notes", hook: "added" }] }).includes("own-data"));
  assert.ok(!ids({ routes: [route(["session", "public"])] }).includes("no-public-routes"));
  assert.ok(!ids({ routes: [route(["key"])] }).includes("no-public-routes"));
  assert.ok(!ids({ routes: [], pageVisibility: { "": ["password"] } }).includes("no-public-routes"));
});

test("without routes, No public routes is left off, not guessed", () => {
  assert.ok(!ids({ egress: [] }).includes("no-public-routes"));
});

test("Runs isolated only on an isolated tier, which no host has yet", () => {
  assert.ok(ids({}, "isolated").includes("isolated"));
  assert.ok(!ids({}).includes("isolated"));
  assert.match(LABELS.isolated.enforcement, /Not built/);
});

test("every label says what makes it true", () => {
  for (const l of Object.values(LABELS)) {
    assert.ok(l.definition.length > 20 && l.enforcement.length > 20, l.id);
  }
});
