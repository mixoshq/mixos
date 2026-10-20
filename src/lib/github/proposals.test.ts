/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { NO_CI_AFTER_MS, ciState } from "./proposals";

const since = new Date("2026-10-12T10:00:00Z");
const at = (ms: number) => new Date(since.getTime() + ms);
const runs = (...list: [string, string | null][]) => ({
  total_count: list.length,
  check_runs: list.map(([status, conclusion]) => ({ status, conclusion })),
});
const status = (...states: string[]) => ({
  state: states.length === 0 ? "pending" : "success",
  total_count: states.length,
  statuses: states.map((state) => ({ state })),
});

describe("what a pull request's checks say", () => {
  test("nothing yet is waiting for ten minutes, then No CI ran, in the danger tone", () => {
    assert.equal(ciState(runs(), status(), since, at(NO_CI_AFTER_MS - 1)).state, "waiting");
    const none = ciState(runs(), status(), since, at(NO_CI_AFTER_MS));
    assert.deepEqual([none.state, none.label, none.tone], ["none", "No CI ran", "danger"]);
    assert.match(none.detail, /Check that GitHub Actions is on for the repository\. Don't merge it unchecked\./);
  });

  test("a skipped run is nothing having run", () => {
    assert.equal(ciState(runs(["completed", "skipped"]), status(), since, at(NO_CI_AFTER_MS)).state, "none");
    assert.equal(ciState(runs(["completed", "skipped"], ["completed", "success"]), status(), since, at(0)).state, "passed");
  });

  test("a failure anywhere is a failure; anything running is running; otherwise passed", () => {
    for (const conclusion of ["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"]) {
      assert.equal(ciState(runs(["completed", "success"], ["completed", conclusion]), status(), since, at(0)).state, "failed", conclusion);
    }
    assert.equal(ciState(runs(["completed", "success"]), status("error"), since, at(0)).state, "failed");
    assert.equal(ciState(runs(["in_progress", null]), status(), since, at(0)).state, "running");
    assert.equal(ciState(runs(["queued", null]), status(), since, at(NO_CI_AFTER_MS * 3)).state, "running");
    assert.equal(ciState(runs(), status("pending"), since, at(0)).state, "running");
    assert.equal(ciState(runs(["completed", "success"], ["completed", "neutral"]), status("success"), since, at(0)).state, "passed");
    assert.equal(ciState(runs(), status("success"), since, at(0)).state, "passed");
  });

  test("more runs than the page showed count as runs", () => {
    assert.equal(ciState({ total_count: 150, check_runs: [] }, status(), since, at(NO_CI_AFTER_MS)).state, "passed");
  });
});
