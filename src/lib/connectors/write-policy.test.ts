/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** What a manifest says about changing data, as the server and the admin screens read it. */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  declaresWrites,
  grantHoldsWriteScopes,
  heldScopes,
  isScopeRequested,
  writeMethods,
  writeScopes,
} from "./write-policy";

const telemetry = [
  { method: "listDeals", operation: "GET /deals" },
  { method: "createDeal", operation: "POST /deals", mutates: true },
];

const auth = {
  scopes: [
    { scope: "deals:read", requested: true as const },
    { scope: "deals:write", requested: "write" as const },
    { scope: "admin", requested: false as const },
  ],
};

test("the methods that change data are the ones declared mutates", () => {
  assert.deepEqual(writeMethods({ telemetry }).map((m) => m.method), ["createDeal"]);
  assert.equal(declaresWrites({ telemetry }), true);
  assert.equal(declaresWrites({ telemetry: telemetry.slice(0, 1) }), false);
  assert.equal(declaresWrites(undefined), false);
});

test("a scope is asked for always, once changes are allowed, or never", () => {
  assert.deepEqual(
    auth.scopes.map((s) => [s.scope, isScopeRequested(s, false), isScopeRequested(s, true)]),
    [
      ["deals:read", true, true],
      ["deals:write", false, true],
      ["admin", false, false],
    ],
  );
  assert.deepEqual(writeScopes(auth), ["deals:write"]);
});

test("whether a grant holds the write scopes: yes, no, or not known", () => {
  assert.equal(grantHoldsWriteScopes(auth, ["deals:read", "deals:write"], true), true);
  assert.equal(grantHoldsWriteScopes(auth, ["deals:read"], true), false);
  assert.equal(grantHoldsWriteScopes(auth, [], false), null);
  // Nothing to hold: a connector requesting no scope with "write".
  assert.equal(grantHoldsWriteScopes({ scopes: [auth.scopes[0]] }, [], false), true);
});

test("a grant holds what it names and what those include, followed through", () => {
  const scopes = [
    { scope: "drive", includes: ["drive.file", "spreadsheets"] },
    { scope: "spreadsheets", includes: ["spreadsheets.readonly"] },
    { scope: "drive.file" },
    { scope: "spreadsheets.readonly" },
    { scope: "gmail.readonly" },
  ];
  assert.deepEqual(
    [...heldScopes(scopes, ["drive"])].sort(),
    ["drive", "drive.file", "spreadsheets", "spreadsheets.readonly"],
  );
  // Included is one way: a grant of the narrower scope doesn't hold the broader.
  assert.deepEqual([...heldScopes(scopes, ["spreadsheets.readonly"])], ["spreadsheets.readonly"]);
  // A name the catalogue doesn't document is still held, with nothing more.
  assert.deepEqual([...heldScopes(scopes, ["openid"])], ["openid"]);
  // Two scopes that include each other end, rather than loop.
  assert.deepEqual(
    [...heldScopes([{ scope: "a", includes: ["b"] }, { scope: "b", includes: ["a"] }], ["a"])].sort(),
    ["a", "b"],
  );
  assert.deepEqual([...heldScopes(undefined, ["a"])], ["a"]);
});

test("a write scope included by a scope in the grant is held", () => {
  const broad = {
    scopes: [
      { scope: "deals:read", requested: true as const },
      { scope: "deals:write", requested: "write" as const },
      { scope: "deals:all", requested: false as const, includes: ["deals:read", "deals:write"] },
    ],
  };
  assert.equal(grantHoldsWriteScopes(broad, ["deals:all"], true), true);
  assert.equal(grantHoldsWriteScopes(broad, ["deals:read"], true), false);
});
