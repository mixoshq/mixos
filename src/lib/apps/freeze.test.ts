/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * deepFreeze: what `context` hands an app can't be changed for anyone else.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { deepFreeze } from "./freeze";

test("every object and array is frozen to its leaves, in place", () => {
  const manifest = {
    slug: "ledger",
    global: false,
    egress: ["api.example.com"],
    connectorRequirements: [{ name: "crm", access: "read" }],
    hooks: { listens: { actions: [] as string[] } },
  };
  assert.equal(deepFreeze(manifest), manifest);
  for (const value of [
    manifest,
    manifest.egress,
    manifest.connectorRequirements,
    manifest.connectorRequirements[0],
    manifest.hooks.listens.actions,
  ]) {
    assert.ok(Object.isFrozen(value));
  }
  // Test files are strict, as app modules are: a write throws.
  assert.throws(() => manifest.egress.push("evil.example.com"), TypeError);
  assert.throws(() => {
    (manifest as { global: boolean }).global = true;
  }, TypeError);
  assert.throws(() => {
    (manifest.connectorRequirements[0] as { access: string }).access = "write";
  }, TypeError);
  assert.deepEqual(manifest.egress, ["api.example.com"]);
});

test("a function's own properties are frozen, and a cycle ends the walk", () => {
  const user: Record<string, unknown> = { id: "u1", hasRole: () => false };
  user.self = user;
  deepFreeze(user);
  assert.ok(Object.isFrozen(user.hasRole));
  assert.throws(() => {
    user.id = "u2";
  }, TypeError);
});

test("a root is walked once, and a primitive comes back as it was", () => {
  const root = { a: { b: 1 } };
  assert.equal(deepFreeze(deepFreeze(root)), root);
  assert.equal(deepFreeze(3), 3);
  assert.equal(deepFreeze(null), null);
});
