/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The floor comparison and its words, with no build stamp: what the registry
 * generator and the dialogs use. ./version.test.ts covers the same comparison
 * against the stamped version. Then the full comparison of MixOS's own release
 * tags, which the release notice uses.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkFloor,
  compareRelease,
  compareReleaseVersions,
  describeFloor,
  parseReleaseVersion,
  parseVersion,
  type FloorVerdict,
} from "./version-floor";

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

// ── MixOS's own releases, compared in full ──────────────────────────────────

test("a release tag parses in full, suffix and all, where a floor drops it", () => {
  assert.deepEqual(parseReleaseVersion("v0.5.0"), { major: 0, minor: 5, patch: 0, prerelease: [] });
  assert.deepEqual(parseReleaseVersion("v0.5.0-rc.1"), { major: 0, minor: 5, patch: 0, prerelease: ["rc", "1"] });
  assert.deepEqual(parseReleaseVersion("1.2.3"), { major: 1, minor: 2, patch: 3, prerelease: [] });
  assert.deepEqual(parseReleaseVersion("v1.0.0-0a.beta"), { major: 1, minor: 0, patch: 0, prerelease: ["0a", "beta"] });
  // The coarse floor reads the same tag as 0.5.0.
  assert.deepEqual(parseVersion("v0.5.0-rc.1"), { major: 0, minor: 5, patch: 0 });
});

test("a release tag that isn't a version in full is refused", () => {
  for (const raw of [
    "v0.5",
    "0.5",
    "v01.2.3",
    "v1.02.3",
    "v1.2.3-",
    "v1.2.3-.",
    "v1.2.3-rc..1",
    "v1.2.3-rc.",
    "v1.2.3-rc.01",
    "v1.2.3-rc-1",
    "v1.2.3+build.5",
    " v1.2.3",
    "v1.2.3 ",
    "V1.2.3",
    "vv1.2.3",
    "v99999999999999999999.0.0",
    "",
  ]) {
    assert.equal(parseReleaseVersion(raw), null, JSON.stringify(raw));
  }
});

test("semver order: a prerelease comes before its release, numbers by value, words after numbers", () => {
  const order = [
    "v0.4.2",
    "v0.5.0-alpha",
    "v0.5.0-alpha.1",
    "v0.5.0-alpha.beta",
    "v0.5.0-beta",
    "v0.5.0-beta.2",
    "v0.5.0-beta.11",
    "v0.5.0-rc.1",
    "v0.5.0-rc.2",
    "v0.5.0-rc.10",
    "v0.5.0",
    "v0.5.1",
    "v0.10.0",
    "v1.0.0",
  ].map((tag) => parseReleaseVersion(tag)!);
  for (let i = 1; i < order.length; i++) {
    assert.equal(compareReleaseVersions(order[i - 1], order[i]), -1, JSON.stringify([order[i - 1], order[i]]));
    assert.equal(compareReleaseVersions(order[i], order[i - 1]), 1);
    assert.equal(compareReleaseVersions(order[i], order[i]), 0);
  }
  // A numeric identifier too long for a number still compares by value.
  assert.equal(
    compareReleaseVersions(parseReleaseVersion("v1.0.0-rc.99999999999999999999")!, parseReleaseVersion("v1.0.0-rc.100000000000000000000")!),
    -1,
  );
});

test("a release against the version running: major, minor, patch, equal and older", () => {
  assert.deepEqual(compareRelease("v1.0.0", "0.4.2"), { order: "newer", step: "major" });
  assert.deepEqual(compareRelease("v0.5.0", "0.4.2"), { order: "newer", step: "minor" });
  assert.deepEqual(compareRelease("v0.4.3", "0.4.2"), { order: "newer", step: "patch" });
  assert.deepEqual(compareRelease("v0.4.2", "0.4.2"), { order: "same" });
  assert.deepEqual(compareRelease("v0.4.1", "0.4.2"), { order: "older" });
  assert.deepEqual(compareRelease("v0.3.9", "0.4.2"), { order: "older" });
  // A prerelease is older than its release, and a step by its numbers.
  assert.deepEqual(compareRelease("v0.5.0-rc.1", "0.4.2"), { order: "newer", step: "minor" });
  assert.deepEqual(compareRelease("v0.5.0-rc.1", "0.5.0"), { order: "older" });
  // Running a prerelease, its final release and a later prerelease are newer by the suffix alone.
  assert.deepEqual(compareRelease("v0.5.0", "0.5.0-rc.1"), { order: "newer", step: "prerelease" });
  assert.deepEqual(compareRelease("v0.5.0-rc.2", "0.5.0-rc.1"), { order: "newer", step: "prerelease" });
  assert.deepEqual(compareRelease("v0.5.1", "0.5.0-rc.1"), { order: "newer", step: "patch" });
  // Either side not a version: no comparison.
  assert.equal(compareRelease("v0.5", "0.4.2"), null);
  assert.equal(compareRelease("v0.5.0", "main"), null);
});
