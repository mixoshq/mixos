/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Admin > GitHub's work functions without a database: each asks for the admin
 * before anything else, and the branch rule's precondition for later
 * proposals. The flows themselves are in ./link.integration.test.ts.
 */

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { FakeGitHub } from "./fake-github";
import {
  branchRuleSatisfied,
  checkLink,
  confirmBranchProtection,
  finishLinking,
  forgetApp,
  replacePrivateKey,
  startAppCreation,
  unlink,
  withdrawBranchProtection,
  type LinkContext,
} from "./link";

const realFetch = globalThis.fetch;
let fake: FakeGitHub;
const previousKey = process.env.GITHUB_APP_ENCRYPTION_KEY;

beforeEach(() => {
  fake = new FakeGitHub();
  globalThis.fetch = fake.fetch;
  process.env.GITHUB_APP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (previousKey === undefined) delete process.env.GITHUB_APP_ENCRYPTION_KEY;
  else process.env.GITHUB_APP_ENCRYPTION_KEY = previousKey;
});

test("every action requires an admin before it reads anything, or asks GitHub", async () => {
  let origin = 0;
  const notAdmin: LinkContext = {
    admin: async () => {
      throw new Error("Admin access required");
    },
    origin: () => (origin++, "https://mixos.example.com"),
  };
  const calls: [string, () => Promise<unknown>][] = [
    ["start", () => startAppCreation({ account: "user", name: "MixOS" }, notAdmin)],
    ["finish linking", () => finishLinking({}, notAdmin)],
    ["check", () => checkLink(notAdmin)],
    ["replace key", () => replacePrivateKey({ pem: "x" }, notAdmin)],
    ["unlink", () => unlink(notAdmin)],
    ["forget", () => forgetApp({ typedSlug: "x" }, notAdmin)],
    ["confirm protection", () => confirmBranchProtection({ reason: "classic-protection", typedRepository: "a/b" }, notAdmin)],
    ["withdraw", () => withdrawBranchProtection(notAdmin)],
  ];
  for (const [name, call] of calls) {
    await assert.rejects(call(), /Admin access required/, name);
  }
  assert.equal(fake.requests.length, 0);
  assert.equal(origin, 0);
});

test("with GITHUB_APP_ENCRYPTION_KEY unset or malformed, every action says the App is off", async () => {
  const admin: LinkContext = { admin: async () => ({ id: "u1", email: "admin@example.com" }), origin: () => "https://mixos.example.com" };
  for (const [value, code] of [[undefined, "off"], ["not-a-key", "malformed-key"]] as const) {
    if (value === undefined) delete process.env.GITHUB_APP_ENCRYPTION_KEY;
    else process.env.GITHUB_APP_ENCRYPTION_KEY = value;
    const outcomes = [
      (await startAppCreation({ account: "user", name: "MixOS" }, admin)).outcome,
      await finishLinking({}, admin),
      await checkLink(admin),
      await replacePrivateKey({ pem: "x" }, admin),
      await unlink(admin),
      await forgetApp({ typedSlug: "x" }, admin),
    ];
    for (const outcome of outcomes) {
      assert.equal(outcome.ok, false);
      if (!outcome.ok) assert.equal(outcome.code, code);
    }
  }
  assert.equal(fake.requests.length, 0);
});

test("a proposal's branch precondition: a pull_request rule, or an admin's confirmation", () => {
  const rule = (pullRequest: boolean) => ({ repositoryId: 1, branch: "main", checkedAt: "", pullRequest, rules: [] });
  const override = { repositoryId: 1, reason: "classic-protection" as const, at: "", by: "a@example.com" };
  assert.deepEqual(branchRuleSatisfied({ branchRule: rule(true), override: null }), { ok: true, via: "rule" });
  assert.deepEqual(branchRuleSatisfied({ branchRule: rule(false), override }), { ok: true, via: "override" });
  assert.deepEqual(branchRuleSatisfied({ branchRule: null, override }), { ok: true, via: "override" });
  assert.deepEqual(branchRuleSatisfied({ branchRule: rule(false), override: null }), { ok: false });
  assert.deepEqual(branchRuleSatisfied({ branchRule: null, override: null }), { ok: false });
});
