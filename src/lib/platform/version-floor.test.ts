/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The floor comparison and its words, with no build stamp: what the registry
 * generator and the dialogs use. ./version.test.ts covers the same comparison
 * against the stamped version.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFloor, describeFloor, parseVersion, type FloorVerdict } from "./version-floor";

const verdict = (declared: string | null, current: string, where: FloorVerdict["where"] = "checkout"): FloorVerdict => {
  const check = checkFloor(declared, current);
  return { declared, current, where, met: check.allowed, checked: check.checked, reason: check.reason ?? null };
};

test("a floor compares with any version it is given, not only this build's", () => {
  assert.deepEqual(checkFloor("0.2.0", "0.2.0"), { allowed: true, checked: true });
  assert.equal(checkFloor("0.2.0", "0.1.9").allowed, false);
  // A local bump to the coming release lets its floor through.
  assert.deepEqual(checkFloor("0.2.0", "0.2.0-rc.1"), { allowed: true, checked: true });
  assert.equal(parseVersion("0.2.x"), null);
  assert.deepEqual(checkFloor("0.2.x", "0.1.0"), {
    allowed: true,
    checked: false,
    reason: 'The listing declares "requires MixOS 0.2.x", which is not a version this instance can compare against. It was not enforced.',
  });
});

test("the dialogs say the floor, this checkout's version, and whether it meets it", () => {
  assert.equal(
    describeFloor(verdict("0.1.0", "0.1.0")),
    "Requires MixOS 0.1.0 or newer. This checkout runs 0.1.0, which meets it.",
  );
  assert.equal(
    describeFloor(verdict("0.2.0", "0.1.0")),
    "Requires MixOS 0.2.0 or newer. This checkout runs 0.1.0, which doesn't meet it.",
  );
  assert.equal(describeFloor(verdict(null, "0.1.0")), "No minimum MixOS version. This checkout runs 0.1.0.");
  assert.equal(
    describeFloor(verdict("soon", "0.1.0")),
    'Its minimum MixOS version, "soon", isn\'t a version, so it isn\'t checked. This checkout runs 0.1.0.',
  );
});

test("a built deployment is named as one", () => {
  assert.equal(
    describeFloor(verdict("0.2.0", "0.1.0", "deployment")),
    "Requires MixOS 0.2.0 or newer. This deployment runs 0.1.0, which doesn't meet it.",
  );
});

test("a version that can't be read is the one blamed, not the floor", () => {
  assert.equal(
    describeFloor(verdict("0.2.0", "main")),
    'Requires MixOS 0.2.0 or newer. This checkout runs "main", which isn\'t a version, so it isn\'t checked.',
  );
});
