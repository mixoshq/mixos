/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The names an audit row carries when no signed-in admin wrote it, and which
 * rows read as unverified.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { RELEASE_STEP_ACTOR as RELEASE_STEP_FROM_SYNC } from "../../../scripts/sync-app-registry";
import { CLI_ACTOR_PREFIX, RELEASE_STEP_ACTOR, cliActorName, isUnverifiedActor } from "./audit-actors";

test("the CLI's name is cli:<os user>@<hostname>, reduced to characters that print plainly", () => {
  assert.equal(cliActorName("ana", "laptop.local"), "cli:ana@laptop.local");
  assert.equal(cliActorName("a b‮c", "host\nname"), "cli:a_b_c@host_name");
  assert.equal(cliActorName(undefined, ""), "cli:unknown@unknown");
  assert.equal(cliActorName("x".repeat(100), "h").length, CLI_ACTOR_PREFIX.length + 64 + 2);
});

test("a CLI row and a release-step row are unverified; an admin's address, even of a deleted admin, is not", () => {
  assert.equal(isUnverifiedActor(cliActorName("ana", "laptop")), true);
  assert.equal(isUnverifiedActor(RELEASE_STEP_ACTOR), true);
  assert.equal(isUnverifiedActor("admin@example.com"), false);
  // An address that merely mentions the words is still an address.
  assert.equal(isUnverifiedActor("cli-team@example.com"), false);
});

test("the release step writes the name readers look for", () => {
  assert.equal(RELEASE_STEP_FROM_SYNC, RELEASE_STEP_ACTOR);
});
