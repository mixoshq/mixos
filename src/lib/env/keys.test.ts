/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { platformKey } from "./keys";

function withKey<T>(value: string, fn: () => T): T {
  const previous = process.env.CONNECTOR_ENCRYPTION_KEY;
  process.env.CONNECTOR_ENCRYPTION_KEY = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.CONNECTOR_ENCRYPTION_KEY;
    else process.env.CONNECTOR_ENCRYPTION_KEY = previous;
  }
}

test("a key is 32 bytes, spelled as hex or as base64", () => {
  const bytes = randomBytes(32);
  for (const spelling of [
    bytes.toString("hex"),
    bytes.toString("base64"),
    bytes.toString("base64").replace(/=$/, ""),
    bytes.toString("base64url"),
  ]) {
    assert.deepEqual(withKey(spelling, () => platformKey("connectorEncryption")), bytes, spelling);
  }
});

test("anything that is not exactly 32 bytes is refused", () => {
  for (const wrong of [
    randomBytes(32).toString("hex").slice(1),
    randomBytes(31).toString("base64"),
    randomBytes(33).toString("base64"),
    // 32 alphanumerics — a random password, not 32 random bytes.
    "a".repeat(32),
    "",
  ]) {
    assert.throws(() => withKey(wrong, () => platformKey("connectorEncryption")), wrong);
  }
});
