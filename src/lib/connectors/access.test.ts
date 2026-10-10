/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { grantedScopes } from "./access";
import { splitScopes } from "./oauth";
import { classifyGrant } from "./scope-status";

test("a grant GitHub or Slack returns comma-separated is read as a list", () => {
  assert.deepEqual(grantedScopes({ oauth_scope: "repo,gist" }), {
    granted: ["repo", "gist"],
    grantedKnown: true,
  });
  assert.deepEqual(grantedScopes({ oauth_scope: "channels:read,chat:write" }).granted, [
    "channels:read",
    "chat:write",
  ]);
});

test("a space-separated grant reads as before, and so does a mix of the two", () => {
  assert.deepEqual(grantedScopes({ oauth_scope: "a b" }).granted, ["a", "b"]);
  assert.deepEqual(grantedScopes({ oauth_scope: " a, b  c ," }).granted, ["a", "b", "c"]);
  assert.deepEqual(grantedScopes({ oauth_scope: "" }), { granted: [], grantedKnown: false });
  assert.deepEqual(grantedScopes(null), { granted: [], grantedKnown: false });
});

test("the snapshot taken at the token exchange marks a comma-separated grant Granted", () => {
  // What the OAuth callback records. Read whole, "repo,gist" matched neither
  // requested scope and both showed Refused.
  const scopes = [
    { scope: "repo", requested: true },
    { scope: "gist", requested: true },
  ];
  assert.deepEqual(
    classifyGrant(scopes, splitScopes("repo,gist")).map((r) => r.status),
    ["granted", "granted"],
  );
});
