/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * scripts/stamp-updated.ts: which extension directories a commit stamps, from
 * the paths it changes against HEAD and, for a merge or cherry-pick, the paths
 * where it differs from each commit it brings in. Reading those from git is
 * the script's job and isn't exercised here.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { planStamps } from "./stamp-updated";

const dirs = (m: Map<string, string[]>) => [...m.keys()].sort();

describe("an ordinary commit", () => {
  test("stamps every extension with a changed path", () => {
    const plan = planStamps([
      "themes/mixos-dark/theme.css",
      "apps/wall-e/pages/index.tsx",
      "connectors/github/connector.ts",
      "src/lib/apps/types.ts",
    ]);
    assert.deepEqual(dirs(plan.own), ["apps/wall-e", "connectors/github", "themes/mixos-dark"]);
    assert.equal(plan.broughtIn.size, 0);
  });

  test("keeps each directory's changed paths, for the lastUpdated-only check", () => {
    const plan = planStamps(["themes/mixos-dark/theme.json", "themes/mixos-dark/theme.css"]);
    assert.deepEqual(plan.own.get("themes/mixos-dark"), [
      "themes/mixos-dark/theme.json",
      "themes/mixos-dark/theme.css",
    ]);
  });

  test("leaves out templates, files directly under a root, and the platform", () => {
    const plan = planStamps([
      "apps/_template/app.json",
      "connectors/_template-oauth/connector.json",
      "themes/AGENTS.md",
      "src/lib/apps/types.ts",
      "README.md",
    ]);
    assert.equal(plan.own.size, 0);
    assert.equal(plan.broughtIn.size, 0);
  });
});

describe("a merge", () => {
  test("doesn't stamp a theme it brings in as the other side has it", () => {
    // A branch that never touched mixos-dark merges main, which changed it.
    const plan = planStamps(
      ["themes/mixos-dark/theme.css", "themes/mixos-dark/theme.json", "src/lib/from-main.ts"],
      [["src/lib/from-the-branch.ts"]],
    );
    assert.equal(plan.own.size, 0);
    assert.deepEqual(dirs(plan.broughtIn), ["themes/mixos-dark"]);
  });

  test("stamps a theme both sides changed, though each file matches one side", () => {
    // main changed fonts.css, the branch theme.css, and both stamped theme.json.
    const plan = planStamps(
      ["themes/mixos-dark/fonts.css", "themes/mixos-dark/theme.json"],
      [["themes/mixos-dark/theme.css", "themes/mixos-dark/theme.json"]],
    );
    assert.deepEqual(dirs(plan.own), ["themes/mixos-dark"]);
    assert.equal(plan.broughtIn.size, 0);
  });

  test("stamps a theme the merge itself edits", () => {
    const plan = planStamps(["themes/mixos-dark/theme.css"], [["themes/mixos-dark/theme.css"]]);
    assert.deepEqual(dirs(plan.own), ["themes/mixos-dark"]);
  });

  test("decides each extension on its own", () => {
    const plan = planStamps(
      ["themes/mixos-dark/theme.css", "apps/wall-e/app.json", "apps/wall-e/api/route.ts"],
      [["apps/wall-e/api/route.ts"]],
    );
    assert.deepEqual(dirs(plan.own), ["apps/wall-e"]);
    assert.deepEqual(dirs(plan.broughtIn), ["themes/mixos-dark"]);
    // Every changed path stays with its directory, own or not.
    assert.deepEqual(plan.own.get("apps/wall-e"), ["apps/wall-e/app.json", "apps/wall-e/api/route.ts"]);
  });

  test("an octopus merge brings in a theme that matches any one merged branch", () => {
    const changed = ["themes/mixos-dark/theme.css"];
    assert.deepEqual(dirs(planStamps(changed, [["themes/mixos-dark/theme.css"], []]).broughtIn), [
      "themes/mixos-dark",
    ]);
    assert.deepEqual(
      dirs(planStamps(changed, [["themes/mixos-dark/theme.css"], ["themes/mixos-dark/theme.css"]]).own),
      ["themes/mixos-dark"],
    );
  });

  test("a file the other side deleted is brought in like any other change", () => {
    // main deleted fonts.css and stamped theme.json; the merge takes both.
    const plan = planStamps(["themes/mixos-dark/fonts.css", "themes/mixos-dark/theme.json"], [[]]);
    assert.deepEqual(dirs(plan.broughtIn), ["themes/mixos-dark"]);
  });
});

describe("a cherry-pick", () => {
  test("keeps the picked commit's date when it leaves the theme as that commit has it", () => {
    const plan = planStamps(["themes/mixos-dark/theme.css", "README.md"], [["README.md"]]);
    assert.deepEqual(dirs(plan.broughtIn), ["themes/mixos-dark"]);
  });

  test("stamps when the theme ends up in a state the picked commit never had", () => {
    const plan = planStamps(["themes/mixos-dark/theme.css"], [["themes/mixos-dark/fonts.css"]]);
    assert.deepEqual(dirs(plan.own), ["themes/mixos-dark"]);
  });
});
