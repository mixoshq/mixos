/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * scripts/stamp-updated.ts: which extension directories a commit stamps, from
 * the paths it changes against HEAD and, for a merge or cherry-pick, the paths
 * where it differs from each commit it brings in, never one installed from a
 * Registry. Reading those from git is the script's job and isn't exercised
 * here.
 */

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { filesHash } from "../src/lib/repository/content-hash";
import { INSTALL_RECORD_FILE, serializeInstallRecord } from "../src/lib/repository/install-record";
import { hasInstallRecord, planStamps } from "./stamp-updated";

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

describe("an extension installed from a Registry", () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mixos-stamp-")));
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  /** A checkout holding `apps/<slug>`, with an install record naming `kind`/`recorded`, or none. */
  function checkout(slug: string, record: { kind: "app" | "connector"; slug: string } | "garbled" | null): string {
    const root = fs.mkdtempSync(path.join(tmp, "checkout-"));
    const dir = path.join(root, "apps", slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "app.json"), '{"name":"Files"}\n');
    const hash = filesHash([{ path: "app.json", mode: 0o644, data: Buffer.from('{"name":"Files"}\n') }]);
    if (record === "garbled") fs.writeFileSync(path.join(dir, INSTALL_RECORD_FILE), "{");
    else if (record) {
      fs.writeFileSync(
        path.join(dir, INSTALL_RECORD_FILE),
        serializeInstallRecord({
          source: "https://mixos.org",
          kind: record.kind,
          slug: record.slug,
          version: "1.2.0",
          gitTag: null,
          commitSha: "c".repeat(40),
          contentHash: hash,
          filesHash: hash,
          repository: { owner: "acme", name: "files", subpath: null },
          requiresMixOS: null,
        }),
      );
    }
    return root;
  }

  test("is never stamped, whoever changed it, and is said apart", () => {
    const plan = planStamps(
      ["apps/files/app.json", "apps/files/.registry.json", "apps/wall-e/app.json"],
      [],
      (dir) => dir === "apps/files",
    );
    assert.deepEqual(dirs(plan.own), ["apps/wall-e"]);
    assert.deepEqual(dirs(plan.installed), ["apps/files"]);
    // Nor when a merge brings it in, or changes it on both sides.
    const merged = planStamps(["apps/files/app.json"], [["apps/files/app.json"]], () => true);
    assert.deepEqual(dirs(merged.own), []);
    assert.deepEqual(dirs(merged.broughtIn), []);
    assert.deepEqual(dirs(merged.installed), ["apps/files"]);
  });

  test("is one whose folder holds a readable install record naming it", () => {
    assert.equal(hasInstallRecord("apps/files", checkout("files", { kind: "app", slug: "files" })), true);
    // No record: a local extension, stamped as always.
    assert.equal(hasInstallRecord("apps/files", checkout("files", null)), false);
    // A record that can't be read, or isn't this folder's, makes it local too.
    assert.equal(hasInstallRecord("apps/files", checkout("files", "garbled")), false);
    assert.equal(hasInstallRecord("apps/files", checkout("files", { kind: "app", slug: "other" })), false);
    assert.equal(hasInstallRecord("apps/files", checkout("files", { kind: "connector", slug: "files" })), false);
    assert.equal(hasInstallRecord("src/lib", checkout("files", { kind: "app", slug: "files" })), false);
  });
});
