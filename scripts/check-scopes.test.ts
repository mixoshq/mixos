/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The scopes refresh: a fresh parse merged over what the manifest already says. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { merge } from "./check-scopes";

const parsed = [
  { scope: "task:add", description: "Add new tasks.", access: "read-write" as const },
  { scope: "data:read", description: "Read your data.", access: "read" as const },
  { scope: "data:read_write", description: "Read and change your data.", access: "read-write" as const },
];

test("the refresh keeps requested and includes, the two hand edits", () => {
  const { scopes, orphans, droppedIncludes } = merge(
    [
      { scope: "data:read", requested: true },
      { scope: "data:read_write", requested: "write", includes: ["task:add", "data:read"] },
    ],
    parsed,
  );
  assert.deepEqual(scopes, [
    { scope: "task:add", description: "Add new tasks.", access: "read-write", requested: false },
    { scope: "data:read", description: "Read your data.", access: "read", requested: true },
    {
      scope: "data:read_write",
      description: "Read and change your data.",
      access: "read-write",
      requested: "write",
      includes: ["task:add", "data:read"],
    },
  ]);
  assert.deepEqual(orphans, []);
  assert.deepEqual(droppedIncludes, []);
});

test("an included scope the page no longer documents is dropped from includes, and said", () => {
  const { scopes, droppedIncludes } = merge(
    [
      { scope: "data:read_write", requested: "write", includes: ["task:add", "data:read"] },
      // Requested, so kept though undocumented: still includable.
      { scope: "legacy:read", requested: true, includes: ["task:quick"] },
    ],
    parsed.filter((p) => p.scope !== "task:add"),
  );
  assert.deepEqual(scopes.find((s) => s.scope === "data:read_write")?.includes, ["data:read"]);
  // All of them gone: no includes left at all, rather than an empty list.
  assert.equal("includes" in scopes.find((s) => s.scope === "legacy:read")!, false);
  assert.deepEqual(droppedIncludes, ["data:read_write includes task:add", "legacy:read includes task:quick"]);
});
