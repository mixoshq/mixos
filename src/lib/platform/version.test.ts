/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reads the build stamp, so it needs the registry generator to have run (CI's
 * lint and typecheck steps run it first; locally, `npm run registry`).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describeBuild, floorVerdict, mixosCommit, mixosVersion, satisfiesMinimum } from "./version";

const PACKAGE_VERSION = (
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf-8")) as {
    version: string;
  }
).version;

const SHA = "3e1f0a2b4c5d6e7f8091a2b3c4d5e6f708192a3b";
const OTHER = "0123456789abcdef0123456789abcdef01234567";

const COMMIT_VARIABLES = [
  "MIXOS_COMMIT",
  "VERCEL_GIT_COMMIT_SHA",
  "RENDER_GIT_COMMIT",
  "RAILWAY_GIT_COMMIT_SHA",
];

function withEnv<T>(values: Record<string, string | undefined>, fn: () => T): T {
  const previous = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** No commit variable set, then `values` on top. */
function withCommitEnv<T>(values: Record<string, string | undefined>, fn: () => T): T {
  const cleared = Object.fromEntries(COMMIT_VARIABLES.map((k) => [k, undefined]));
  return withEnv({ ...cleared, ...values }, fn);
}

// ── the version ─────────────────────────────────────────────────────────────

test("every build knows its version: package.json's, stamped by the generator", () => {
  assert.match(PACKAGE_VERSION, /^\d+\.\d+\.\d+/);
  assert.equal(mixosVersion(), PACKAGE_VERSION);
});

test("MIXOS_RELEASE is not a version source", () => {
  withEnv({ MIXOS_RELEASE: "v9.9.9" }, () => {
    assert.equal(mixosVersion(), PACKAGE_VERSION);
  });
});

// ── the commit ──────────────────────────────────────────────────────────────

test("the commit is the first variable that holds a SHA, in order", () => {
  assert.equal(mixosCommit({ MIXOS_COMMIT: SHA, VERCEL_GIT_COMMIT_SHA: OTHER }), SHA);
  assert.equal(mixosCommit({ VERCEL_GIT_COMMIT_SHA: SHA, RENDER_GIT_COMMIT: OTHER }), SHA);
  assert.equal(mixosCommit({ RENDER_GIT_COMMIT: SHA, RAILWAY_GIT_COMMIT_SHA: OTHER }), SHA);
  assert.equal(mixosCommit({ RAILWAY_GIT_COMMIT_SHA: SHA }), SHA);
});

test("the image's empty MIXOS_COMMIT falls through to the host's variable", () => {
  // What Render and Railway run: the image built without the argument.
  assert.equal(mixosCommit({ MIXOS_COMMIT: "", RENDER_GIT_COMMIT: SHA }), SHA);
  assert.equal(mixosCommit({ MIXOS_COMMIT: "", RAILWAY_GIT_COMMIT_SHA: SHA }), SHA);
  // And read from the process environment by default.
  withCommitEnv({ MIXOS_COMMIT: "", RENDER_GIT_COMMIT: SHA }, () => {
    assert.equal(mixosCommit(), SHA);
  });
});

test("a value that is not a SHA is passed over", () => {
  assert.equal(mixosCommit({ MIXOS_COMMIT: "$SOURCE_COMMIT", RENDER_GIT_COMMIT: SHA }), SHA);
  assert.equal(mixosCommit({ MIXOS_COMMIT: "main", VERCEL_GIT_COMMIT_SHA: SHA }), SHA);
  assert.equal(mixosCommit({ MIXOS_COMMIT: "3e1f0a", RENDER_GIT_COMMIT: SHA }), SHA);
  assert.equal(mixosCommit({ MIXOS_COMMIT: `${SHA}0` }), null);
});

test("an abbreviated SHA counts, trimmed and lower-cased", () => {
  assert.equal(mixosCommit({ MIXOS_COMMIT: " 3E1F0A2 \n" }), "3e1f0a2");
});

test("no source means no commit", () => {
  assert.equal(mixosCommit({}), null);
  withCommitEnv({}, () => {
    assert.equal(mixosCommit(), null);
  });
});

// ── what admins see ─────────────────────────────────────────────────────────

test("the build is described as version and short commit", () => {
  assert.equal(describeBuild("0.4.2", SHA), "MixOS 0.4.2 · commit 3e1f0a2");
  assert.equal(describeBuild("0.4.2", null), "MixOS 0.4.2 · commit unknown");
});

test("by default it describes this build", () => {
  withCommitEnv({ RAILWAY_GIT_COMMIT_SHA: SHA }, () => {
    assert.equal(describeBuild(), `MixOS ${PACKAGE_VERSION} · commit 3e1f0a2`);
  });
  withCommitEnv({ MIXOS_COMMIT: "" }, () => {
    assert.equal(describeBuild(), `MixOS ${PACKAGE_VERSION} · commit unknown`);
  });
});

// ── requiresMixOS ───────────────────────────────────────────────────────────

test("a floor above this build's version is refused, with both numbers", () => {
  const check = satisfiesMinimum("999.0.0");
  assert.equal(check.allowed, false);
  assert.equal(check.checked, true);
  assert.match(check.reason ?? "", new RegExp(`running MixOS ${PACKAGE_VERSION.replace(/\./g, "\\.")}`));
  assert.match(check.reason ?? "", /requires 999\.0\.0 or newer/);
});

test("a floor at or below this build's version is met, and compared", () => {
  assert.deepEqual(satisfiesMinimum(PACKAGE_VERSION), { allowed: true, checked: true });
  assert.deepEqual(satisfiesMinimum("0.0.1"), { allowed: true, checked: true });
});

test("floors compare numerically, with the accepted spellings", () => {
  assert.equal(satisfiesMinimum("0.5.0", "0.4.2").allowed, false);
  assert.equal(satisfiesMinimum("0.10.0", "0.9.9").allowed, false);
  assert.equal(satisfiesMinimum("0.4.3-beta.1", "0.4.2").allowed, false);
  assert.deepEqual(satisfiesMinimum(">=0.4", "0.4.2"), { allowed: true, checked: true });
  assert.deepEqual(satisfiesMinimum("v0.4.2", "0.4.2"), { allowed: true, checked: true });
  assert.deepEqual(satisfiesMinimum("0.4.2", "0.5.0-rc.1"), { allowed: true, checked: true });
});

test("no floor allows, without a reason", () => {
  for (const none of [null, undefined, "", "  "]) {
    assert.deepEqual(satisfiesMinimum(none), { allowed: true, checked: false });
  }
});

test("a floor that is not a version allows, unchecked, and says so", () => {
  const check = satisfiesMinimum("latest");
  assert.equal(check.allowed, true);
  assert.equal(check.checked, false);
  assert.match(check.reason ?? "", /not enforced/);
});

// ── the verdict a dialog shows ──────────────────────────────────────────────

test("a dialog's verdict is the floor against this build, worked out on the server", () => {
  withEnv({ VERCEL: undefined }, () => {
    assert.deepEqual(floorVerdict("0.0.1"), {
      declared: "0.0.1",
      current: PACKAGE_VERSION,
      where: "checkout",
      met: true,
      checked: true,
      reason: null,
    });
    const unmet = floorVerdict("999.0.0");
    assert.equal(unmet.met, false);
    assert.equal(unmet.checked, true);
    assert.match(unmet.reason ?? "", /requires 999\.0\.0 or newer/);
    assert.deepEqual(floorVerdict("  "), { declared: null, current: PACKAGE_VERSION, where: "checkout", met: true, checked: false, reason: null });
    assert.equal(floorVerdict("soon").checked, false);
  });
});

test("on a built deployment the verdict says so", () => {
  withEnv({ VERCEL: "1" }, () => {
    assert.equal(floorVerdict("0.0.1").where, "deployment");
  });
});
