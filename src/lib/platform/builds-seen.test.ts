/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The keys builds record themselves under in platform_builds_seen. Recording
 * and the 24-hour rule run against a real database in
 * src/lib/repository/delete-data.integration.test.ts.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRecord, checkoutId, CheckoutIdError, describeBuildKey, extensionSetHash } from "./builds-seen";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mixos-builds-seen-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const checkout = () => {
  const root = path.join(tmp, `checkout-${n++}`);
  fs.mkdirSync(root);
  return root;
};

test("the hash of what a build carries ignores order and repeats, and tells apps from connectors", () => {
  const a = extensionSetHash(["notes", "board"], ["crm"]);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(extensionSetHash(["board", "notes", "notes"], ["crm"]), a);
  assert.notEqual(extensionSetHash(["notes"], ["crm"]), a);
  assert.notEqual(extensionSetHash(["board", "notes", "crm"], []), a, "a connector counted as an app");
});

test("a built deployment's key is its commit and what it carries, sorted", () => {
  const record = buildRecord({
    root: "/nowhere",
    built: true,
    commit: "3e1f0a2b9c",
    apps: ["notes", "board"],
    connectors: ["crm"],
  });
  assert.deepEqual(record, {
    key: `build:3e1f0a2b9c:${extensionSetHash(["board", "notes"], ["crm"])}`,
    apps: ["board", "notes"],
    connectors: ["crm"],
  });
  assert.equal(fs.existsSync("/nowhere/.mixos"), false, "a build read a checkout id");

  const unknown = buildRecord({ root: "/nowhere", built: true, commit: null, apps: [], connectors: [] });
  assert.match(unknown.key, /^build:unknown:[0-9a-f]{16}$/);
});

test("a checkout's key is its own id, made once, whatever it carries", () => {
  const root = checkout();
  const first = buildRecord({ root, built: false, commit: "3e1f0a2", apps: ["notes"], connectors: [] });
  assert.match(first.key, /^checkout:[0-9a-f]{32}$/);
  assert.equal(fs.readFileSync(path.join(root, ".mixos", "checkout-id"), "utf8"), `${first.key.slice(9)}\n`);

  const later = buildRecord({ root, built: false, commit: "9999999", apps: [], connectors: ["crm"] });
  assert.equal(later.key, first.key);
  assert.deepEqual(fs.readdirSync(path.join(root, ".mixos")), ["checkout-id"], "it left a file behind");
  assert.notEqual(checkoutId(checkout()), checkoutId(root), "two checkouts share an id");
});

test("a checkout id MixOS didn't write is refused, and left as it is", () => {
  const root = checkout();
  fs.mkdirSync(path.join(root, ".mixos"));
  fs.writeFileSync(path.join(root, ".mixos", "checkout-id"), "production\n");
  assert.throws(() => checkoutId(root), CheckoutIdError);
  assert.equal(fs.readFileSync(path.join(root, ".mixos", "checkout-id"), "utf8"), "production\n");
});

test("a key in a few words", () => {
  assert.equal(describeBuildKey(`checkout:${"a".repeat(32)}`), "a checkout");
  assert.equal(describeBuildKey("build:3e1f0a2b9c8d:0123456789abcdef"), "a build of commit 3e1f0a2");
  assert.equal(describeBuildKey("build:unknown:0123456789abcdef"), "a build with no commit recorded");
  assert.equal(describeBuildKey("something else"), "a build");
});
