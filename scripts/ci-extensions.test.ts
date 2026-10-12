/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The pull-request check for extensions: which apps it tests
 * (scripts/ci-extensions.ts), and what its workflow may and may not do
 * (.github/workflows/extensions.yml), read as text. The database half,
 * `activate`, is in scripts/smoke-activate.integration.test.ts.
 */

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHECK_FILES, appsToTest, readPaths } from "./ci-extensions";

const REPO = path.resolve(__dirname, "..");
const WORKFLOW = fs.readFileSync(path.join(REPO, ".github/workflows/extensions.yml"), "utf8");

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mixos-ci-extensions-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A checkout holding these app folders. */
function checkout(...apps: string[]): string {
  const root = fs.mkdtempSync(path.join(tmp, "checkout-"));
  for (const slug of apps) fs.mkdirSync(path.join(root, "apps", slug), { recursive: true });
  fs.writeFileSync(path.join(root, "apps", "AGENTS.md"), "# Apps\n");
  return root;
}

describe("which apps a pull request tests", () => {
  test("each app folder it changes, once, sorted", () => {
    const root = checkout("files", "notes", "wall-e");
    const result = appsToTest(
      ["apps/notes/app.json", "apps/files/api/x/route.ts", "apps/notes/widgets/a.tsx", "src/lib/x.ts"],
      root,
    );
    assert.deepEqual(result.slugs, ["files", "notes"]);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.notes, ["Apps to smoke-test: files, notes."]);
  });

  test("not a top-level file, a template, a set-aside copy, a connector or a theme", () => {
    const root = checkout("_template", ".old-files");
    const result = appsToTest(
      [
        "apps/AGENTS.md",
        "apps/_template/app.json",
        "apps/.old-files/app.json",
        "connectors/crm/connector.json",
        "themes/dusk/theme.css",
      ],
      root,
    );
    assert.deepEqual(result, { slugs: [], notes: ["No app to smoke-test."], problems: [] });
  });

  test("a folder the pull request removes is left out, and said", () => {
    const root = checkout("files");
    const result = appsToTest(["apps/gone/app.json", "apps/files/app.json"], root);
    assert.deepEqual(result.slugs, ["files"]);
    assert.deepEqual(result.notes, [
      "apps/gone/ is removed by this pull request, so there is nothing to test.",
      "Apps to smoke-test: files.",
    ]);
  });

  test("a folder name that can't be an app's fails the step, and never reaches a shell", () => {
    const root = checkout("Bad App", "ok_app");
    const result = appsToTest(["apps/Bad App/app.json", "apps/ok_app/app.json", "apps/$(id)/x"], root);
    assert.deepEqual(result.slugs, ["ok_app"]);
    assert.equal(result.problems.length, 2);
    assert.match(result.problems.join("\n"), /"apps\/Bad App\/" can't be an app/);
    assert.match(result.problems.join("\n"), /"apps\/\$\(id\)\/" can't be an app/);
  });

  test("a change to the check itself tests every app, so the check runs on its own pull request", () => {
    const root = checkout("files", "wall-e", "_template");
    for (const own of CHECK_FILES) {
      const result = appsToTest([own, "README.md"], root);
      assert.deepEqual(result.slugs, ["files", "wall-e"], own);
      assert.match(result.notes[0], new RegExp(`changes the check itself \\(${own.replace(/[.]/g, "\\.")}\\)`));
    }
  });

  test("paths from `git diff --name-only -z`, or one per line", () => {
    assert.deepEqual(readPaths("apps/a b/x\0apps/c/y\0"), ["apps/a b/x", "apps/c/y"]);
    assert.deepEqual(readPaths("apps/a/x\napps/c/y\n"), ["apps/a/x", "apps/c/y"]);
    assert.deepEqual(readPaths(""), []);
  });
});

describe("the workflow", () => {
  /** The `paths` its pull_request trigger lists. */
  const paths = [...WORKFLOW.matchAll(/^\s+- "([^"]+)"$/gm)].map((m) => m[1]);

  test("runs for apps, connectors and themes, and for every file of the check itself", () => {
    assert.deepEqual(
      paths.filter((p) => p.endsWith("/**")),
      ["apps/**", "connectors/**", "themes/**"],
    );
    assert.deepEqual(
      paths.filter((p) => !p.endsWith("/**")),
      [...CHECK_FILES],
    );
  });

  test("on pull_request only, never pull_request_target", () => {
    assert.match(WORKFLOW, /^on:\n {2}pull_request:\n/m);
    assert.doesNotMatch(WORKFLOW.replace(/^\s*#.*$/gm, ""), /pull_request_target|workflow_run|push:/);
  });

  test("with contents: read as its one permission", () => {
    assert.match(WORKFLOW, /^permissions:\n {2}contents: read\n\n/m);
    assert.equal((WORKFLOW.match(/^\s*permissions:/gm) ?? []).length, 1, "no job widens it");
    assert.doesNotMatch(WORKFLOW, /: write\b/);
  });

  test("checks out without keeping the token, and reads no secret", () => {
    assert.match(WORKFLOW, /persist-credentials: false/);
    assert.doesNotMatch(WORKFLOW, /secrets\.|GITHUB_TOKEN|github\.token/);
  });

  test("checks the installed folders first, then builds, starts, activates and smoke-tests, in that order", () => {
    const order = [
      "npx tsx scripts/check-install-records.ts",
      "scripts/ci-extensions.ts apps",
      "scripts/generate-keys.ts",
      "npm run release",
      "npm run build",
      "npm run start",
      "scripts/ci-extensions.ts activate",
      "npx tsx scripts/smoke-test-app.ts",
    ].map((step) => WORKFLOW.indexOf(step));
    assert.ok(order.every((at) => at > 0), String(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
  });

  test("passes step outputs through the environment, never into a script's text", () => {
    for (const line of WORKFLOW.split("\n").filter((l) => l.includes("${{"))) {
      assert.match(line, /^\s+(group|SLUGS|if): /, line);
    }
  });
});
