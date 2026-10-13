/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  checkRenderYaml,
  checkVercelJson,
  checkWorkflow,
  filterMatches,
  readYaml,
  skipsAppBranches,
} from "./workflows";

const where = { defaultBranch: "main", branch: "mixos/install/app-files" };
const check = (text: string) => checkWorkflow(".github/workflows/x.yml", text, where);
const problems = (text: string) => check(text).map((f) => f.problem);

const SKIPPED = "    if: ${{ !startsWith(github.head_ref, 'mixos/') }}\n";

describe("the workflow check", () => {
  test("pull_request_target is refused, even with every job skipped", () => {
    const text = `on: pull_request_target\npermissions: {}\njobs:\n  a:\n${SKIPPED}    runs-on: ubuntu-latest\n    steps: [{ run: echo }]\n`;
    assert.match(problems(text).join("\n"), /pull_request_target/);
    assert.match(problems("on: [pull_request_target]\njobs: {}\n").join("\n"), /pull_request_target/);
  });

  test("a secret, a write permission and no permissions are each refused for pull requests into the default branch", () => {
    const secret = `on: pull_request\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: deploy\n        env:\n          TOKEN: \${{ secrets.VERCEL_TOKEN }}\n`;
    assert.deepEqual(problems(secret), ["runs for pull requests into main and uses the secret VERCEL_TOKEN."]);

    const write = `on:\n  pull_request:\n    branches: [main]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      pull-requests: write\n    steps: [{ run: echo }]\n`;
    assert.deepEqual(problems(write), ["runs for pull requests into main and asks for pull-requests: write."]);

    const none = `on: pull_request\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{ run: npm ci }]\n`;
    assert.deepEqual(problems(none), [
      "runs for pull requests into main and sets no permissions, so its token is the repository's default, which can write.",
    ]);
    assert.match(problems(`on: pull_request\npermissions: write-all\njobs:\n  a:\n    runs-on: x\n`).join(), /write-all/);
    assert.match(problems(`on: pull_request\npermissions:\n  id-token: write\njobs:\n  a:\n    runs-on: x\n`).join(), /id-token: write/);
  });

  test("the mixos/ job condition on every job is accepted, with secrets and write permissions", () => {
    const text =
      `on:\n  pull_request:\n    types: [opened, synchronize]\njobs:\n  danger:\n${SKIPPED}    runs-on: ubuntu-latest\n` +
      `    permissions:\n      pull-requests: write\n      statuses: write\n    steps:\n      - run: npx danger ci\n        env:\n          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}\n          OTHER: \${{ secrets.NPM_TOKEN }}\n`;
    assert.deepEqual(check(text), []);
    // Bare, and joined by && to another condition.
    assert.deepEqual(check(text.replace(SKIPPED, "    if: \"!startsWith(github.head_ref, 'mixos/')\"\n")), []);
    assert.deepEqual(
      check(text.replace(SKIPPED, "    if: ${{ github.actor != 'x' && !startsWith(github.head_ref, 'mixos/') }}\n")),
      [],
    );
    // One job without it: the whole workflow is checked.
    const two = `${text}  other:\n    runs-on: ubuntu-latest\n    steps: [{ run: echo }]\n`;
    assert.ok(check(two).length > 0);
  });

  test("a condition that doesn't keep the job off App branches isn't accepted", () => {
    for (const condition of [
      "${{ !startsWith(github.head_ref, 'mixos/') || true }}",
      "${{ !startsWith(github.head_ref, 'mixos/') }} && true",
      "${{ !(github.actor == 'x' && !startsWith(github.head_ref, 'mixos/')) }}",
      "${{ !startsWith(github.head_ref, 'mixos') }}",
      "${{ !startsWith(github.ref, 'mixos/') }}",
      "${{ startsWith(github.head_ref, 'mixos/') }}",
      "${{ !startsWith(github.head_ref, 'mixos/') && '(' }}x",
      "always()",
    ]) {
      assert.equal(skipsAppBranches(condition), false, condition);
    }
    assert.equal(skipsAppBranches("${{ !startsWith( github.head_ref ,'mixos/' ) }}"), true);
    assert.equal(skipsAppBranches(undefined), false);
  });

  test("branches-ignore on a pull_request trigger filters the target, so it doesn't leave App pull requests out", () => {
    const text = `on:\n  pull_request:\n    branches-ignore: ['mixos/**']\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: \${{ secrets.KEY }}\n`;
    assert.match(problems(text).join(), /uses the secret KEY/);
    // Into a branch other than the default one: the App's pull requests don't trigger it.
    const elsewhere = `on:\n  pull_request:\n    branches: [release, 'feature/**']\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: \${{ secrets.KEY }}\n`;
    assert.deepEqual(check(elsewhere), []);
    // An empty list isn't taken to mean no pull requests.
    const empty = `on:\n  pull_request:\n    branches: []\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: \${{ secrets.KEY }}\n`;
    assert.match(problems(empty).join(), /uses the secret KEY/);
    // Excluded again after a pattern that took it in.
    const excluded = `on:\n  pull_request:\n    branches: ['**', '!main']\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: \${{ secrets.KEY }}\n`;
    assert.deepEqual(check(excluded), []);
  });

  test("a push to the App's branch is checked, and the head_ref condition doesn't skip it", () => {
    const pushAll = `on: [push, pull_request]\npermissions:\n  contents: read\njobs:\n  a:\n${SKIPPED}    runs-on: x\n    steps:\n      - run: \${{ secrets.KEY }}\n`;
    assert.match(problems(pushAll).join(), /on a push to mixos\/install\/app-files and for pull requests into main and uses the secret KEY/);
    const mixosOnly = `on:\n  push:\n    branches: ['mixos/**']\njobs:\n  a:\n    runs-on: x\n    permissions: read-all\n    steps:\n      - run: \${{ secrets.KEY }}\n`;
    assert.match(problems(mixosOnly).join(), /uses the secret KEY/);
    const mainOnly = `on:\n  push:\n    branches: [main]\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: \${{ secrets.KEY }}\n`;
    assert.deepEqual(check(mainOnly), []);
    const ignoreMixos = `on:\n  push:\n    branches-ignore: ['mixos/**']\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: \${{ secrets.KEY }}\n`;
    assert.deepEqual(check(ignoreMixos), []);
    const tagsOnly = `on:\n  push:\n    tags: ['v*']\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: \${{ secrets.KEY }}\n`;
    assert.deepEqual(check(tagsOnly), []);
  });

  test("create, workflow_run and review events are checked too", () => {
    const create = `on: create\njobs:\n  a:\n    runs-on: x\n    permissions: {}\n    steps:\n      - run: \${{ secrets.KEY }}\n`;
    assert.match(problems(create).join(), /when a branch is created and uses the secret KEY/);
    const review = `on: pull_request_review\njobs:\n  a:\n    runs-on: x\n    steps: [{ run: echo }]\n`;
    assert.match(problems(review).join(), /when a pull request is reviewed and sets no permissions/);
    const run = `on:\n  workflow_run:\n    workflows: [ci]\n    types: [completed]\njobs:\n  a:\n    runs-on: x\n    permissions: { contents: write }\n`;
    assert.match(problems(run).join(), /after a workflow runs on mixos\/install\/app-files and asks for contents: write/);
    const runOnMain = run.replace("types: [completed]", "types: [completed]\n    branches: [main]");
    assert.deepEqual(check(runOnMain), []);
    const dispatch = `on: [workflow_dispatch, schedule, issues]\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: \${{ secrets.KEY }}\n`;
    assert.deepEqual(check(dispatch), []);
  });

  test("every way of reading secrets counts, GITHUB_TOKEN aside", () => {
    const wrap = (step: string, extra = "") =>
      `on: pull_request\npermissions: { contents: read }\njobs:\n  a:\n    runs-on: x\n${extra}    steps:\n      - ${step}\n`;
    assert.deepEqual(check(wrap("run: echo ${{ secrets.GITHUB_TOKEN }} ${{ github.token }}")), []);
    assert.match(problems(wrap("run: echo '${{ toJSON(secrets) }}'")).join(), /any of them/);
    assert.match(problems(wrap("run: echo ${{ secrets['NPM_TOKEN'] }}")).join(), /NPM_TOKEN/);
    assert.match(problems(wrap("run: echo ${{ secrets[matrix.name] }}")).join(), /any of them/);
    assert.match(problems(wrap("if: secrets.DEPLOY_KEY != ''\n        run: echo")).join(), /DEPLOY_KEY/);
    // A reusable workflow given every secret.
    const inherit = `on: pull_request\npermissions: {}\njobs:\n  call:\n    uses: ./.github/workflows/build.yml\n    secrets: inherit\n`;
    assert.match(problems(inherit).join(), /secrets: inherit/);
    // The word in a script isn't a secret.
    assert.deepEqual(check(wrap("run: echo 'no secrets here'")), []);
  });

  test("a self-hosted runner is refused", () => {
    const text = `on: pull_request\npermissions: {}\njobs:\n  a:\n    runs-on: [self-hosted, linux]\n    steps: [{ run: echo }]\n`;
    assert.match(problems(text).join(), /self-hosted runner/);
    const matrix = `on: pull_request\npermissions: {}\njobs:\n  a:\n    runs-on: \${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [ubuntu-latest, self-hosted]\n`;
    assert.match(problems(matrix).join(), /self-hosted runner/);
  });

  test("YAML the check can't read as GitHub does is refused, naming the file", () => {
    for (const text of [
      "on: pull_request\non: push\njobs: {}\n",
      "on: !custom pull_request\njobs: {}\n",
      "x: &x { permissions: { contents: write } }\non: pull_request\njobs:\n  a:\n    <<: *x\n    runs-on: y\n",
      "on: push\n---\non: pull_request\n",
      "a: &a [x,x,x,x,x,x,x,x,x,x]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]\nd: [*c,*c,*c,*c,*c,*c,*c,*c,*c,*c]\non: push\n",
      "? [a, b]\n: c\n",
      "on: pull_request\njobs:\n  a:\n    if: !startsWith(github.head_ref, 'mixos/')\n",
      "just text",
      "on: 7\njobs: {}\n",
    ]) {
      const found = check(text);
      assert.ok(found.length > 0, text);
      assert.equal(found[0].file, ".github/workflows/x.yml");
    }
    assert.throws(() => readYaml("a: 1\na: 2\n"));
  });

  test("filter patterns match as GitHub's cheat sheet says", () => {
    assert.equal(filterMatches("mixos/**", "mixos/install/app-files"), true);
    assert.equal(filterMatches("mixos/*", "mixos/install/app-files"), false);
    assert.equal(filterMatches("**", "main"), true);
    assert.equal(filterMatches("*", "mixos/x"), false);
    assert.equal(filterMatches("ma[a-z]n", "main"), true);
    assert.equal(filterMatches("mai?n", "man"), true);
    assert.equal(filterMatches("mai+n", "maiiin"), true);
    assert.equal(filterMatches("release/v1.0", "release/v1x0"), false);
    assert.equal(filterMatches("?bad", "x"), null);
    assert.equal(filterMatches("[$]", "$"), null);
  });

  test("this repository's own workflows pass the check", () => {
    const dir = path.join(process.cwd(), ".github", "workflows");
    const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f));
    assert.ok(files.includes("ci.yml") && files.includes("danger.yml"));
    for (const name of files) {
      assert.deepEqual(checkWorkflow(`.github/workflows/${name}`, fs.readFileSync(path.join(dir, name), "utf8"), where), [], name);
    }
  });

  // The pull request check from rank 18, as it is on main: it has to keep
  // running on App pull requests, because it is the check.
  test("extensions.yml passes, and runs for App pull requests", () => {
    const extensions = [
      "name: extensions",
      "on:",
      "  pull_request:",
      "    paths:",
      '      - "apps/**"',
      '      - "connectors/**"',
      '      - "themes/**"',
      "permissions:",
      "  contents: read",
      "jobs:",
      "  check:",
      "    runs-on: ubuntu-latest",
      "    services:",
      "      postgres:",
      "        image: postgres:17",
      "        env:",
      "          POSTGRES_PASSWORD: throwaway",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "        with:",
      "          persist-credentials: false",
      "          fetch-depth: 2",
      "      - run: npm ci",
      "      - name: Activate and grant the apps",
      "        if: steps.apps.outputs.slugs != ''",
      "        env:",
      "          SLUGS: ${{ steps.apps.outputs.slugs }}",
      '        run: npx tsx scripts/ci-extensions.ts activate --user "$INITIAL_ADMIN_EMAIL"',
      "",
    ].join("\n");
    assert.deepEqual(check(extensions), []);
    assert.equal(skipsAppBranches(undefined), false, "its job has no mixos/ condition, so it runs");
  });
});

describe("the render.yaml check", () => {
  test("this repository's render.yaml passes", () => {
    const text = fs.readFileSync(path.join(process.cwd(), "render.yaml"), "utf8");
    assert.deepEqual(checkRenderYaml(text), []);
    assert.match(text, /previews:\s*\n\s*generation: off/);
  });

  test("previews turned on are refused, for the Blueprint and for a service", () => {
    assert.match(checkRenderYaml("previews:\n  generation: automatic\nservices: []\n")[0].problem, /preview environments/);
    assert.match(checkRenderYaml("services:\n  - name: web\n    previews:\n      generation: manual\n")[0].problem, /for web/);
    assert.match(checkRenderYaml("services:\n  - name: web\n    pullRequestPreviewsEnabled: yes\n")[0].problem, /for web/);
    assert.match(checkRenderYaml("services:\n  - name: web\n    previews:\n      generation: sometimes\n")[0].problem, /can't read/);
    assert.deepEqual(checkRenderYaml("services:\n  - name: web\n    pullRequestPreviewsEnabled: no\n"), []);
    assert.deepEqual(checkRenderYaml("services: []\n"), []);
    assert.match(checkRenderYaml("services: [\n")[0].problem, /can't be read/);
  });
});

describe("the vercel.json check", () => {
  const branch = "mixos/install/app-files";
  test("this repository's vercel.json passes", () => {
    const text = fs.readFileSync(path.join(process.cwd(), "vercel.json"), "utf8");
    assert.deepEqual(checkVercelJson(text, branch), []);
  });

  test("deployments of App branches have to be off", () => {
    assert.match(checkVercelJson(null, branch)[0].problem, /doesn't exist/);
    assert.match(checkVercelJson("{}", branch)[0].problem, /doesn't turn off/);
    assert.match(checkVercelJson("{ nope", branch)[0].problem, /isn't JSON/);
    assert.deepEqual(checkVercelJson('{"git":{"deploymentEnabled":false}}', branch), []);
    assert.deepEqual(checkVercelJson('{"git":{"deploymentEnabled":{"mixos/**":false,"main":true}}}', branch), []);
    assert.equal(checkVercelJson('{"git":{"deploymentEnabled":{"mixos/**":false,"**":true}}}', branch).length, 1);
    assert.equal(checkVercelJson('{"git":{"deploymentEnabled":{"mixos/*":false}}}', branch).length, 1);
    assert.deepEqual(checkVercelJson('{"github":{"enabled":false}}', branch), []);
  });
});
