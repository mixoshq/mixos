/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The pre-commit contract check, in a real repository: a staged connector
 * manifest against HEAD's. The rules themselves are tested in
 * src/lib/connectors/requirements.test.ts; this is which files it reads.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stagedContractBreaks } from "./check-connector-contract";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mixos-contract-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

const manifest = (version: string, ...methods: string[]) =>
  JSON.stringify({ name: "crm", version, telemetry: methods.map((method) => ({ method, operation: `op ${method}` })) });

/** A repository whose HEAD holds `connectors/<folder>/connector.json` as `committed`. */
function repo(folder: string, committed: string): string {
  const root = fs.mkdtempSync(path.join(tmp, "checkout-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@mixos.test");
  git(root, "config", "user.name", "Test");
  git(root, "config", "commit.gpgsign", "false");
  fs.mkdirSync(path.join(root, "connectors", folder), { recursive: true });
  fs.writeFileSync(path.join(root, "connectors", folder, "connector.json"), committed);
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "first");
  return root;
}

const stage = (root: string, folder: string, text: string) => {
  fs.writeFileSync(path.join(root, "connectors", folder, "connector.json"), text);
  git(root, "add", ".");
};

test("a staged manifest that removes a method without a new major version is refused", () => {
  const root = repo("crm", manifest("1.2.0", "listDeals", "createDeal"));
  stage(root, "crm", manifest("1.3.0", "listDeals"));
  const breaks = stagedContractBreaks(root);
  assert.equal(breaks.length, 1);
  assert.equal(breaks[0].file, "connectors/crm/connector.json");
  assert.match(breaks[0].problems[0], /removes `createDeal`.*needs a new major version: 2\.0\.0, not 1\.3\.0/);

  stage(root, "crm", manifest("2.0.0", "listDeals"));
  assert.deepEqual(stagedContractBreaks(root), []);
});

test("adding a method, or changing nothing the contract covers, passes", () => {
  const root = repo("crm", manifest("1.2.0", "listDeals"));
  stage(root, "crm", manifest("1.2.0", "listDeals", "getDeal"));
  assert.deepEqual(stagedContractBreaks(root), []);
});

test("a version going backwards is refused", () => {
  const root = repo("crm", manifest("1.2.0", "listDeals"));
  stage(root, "crm", manifest("1.1.0", "listDeals"));
  assert.match(stagedContractBreaks(root)[0].problems[0], /went backwards, from 1\.2\.0 to 1\.1\.0/);
});

test("a template, a new connector and a Registry install are not held to it", () => {
  const template = repo("_template", manifest("1.0.0", "listItems", "createItem"));
  stage(template, "_template", manifest("1.0.0", "listItems"));
  assert.deepEqual(stagedContractBreaks(template), []);

  const installed = repo("crm", manifest("1.2.0", "listDeals", "createDeal"));
  fs.writeFileSync(path.join(installed, "connectors", "crm", ".registry.json"), "{}");
  stage(installed, "crm", manifest("1.2.1", "listDeals"));
  assert.deepEqual(stagedContractBreaks(installed), []);

  const fresh = repo("other", manifest("1.0.0", "x"));
  fs.mkdirSync(path.join(fresh, "connectors", "crm"), { recursive: true });
  stage(fresh, "crm", manifest("1.0.0", "listDeals"));
  assert.deepEqual(stagedContractBreaks(fresh), []);
});
