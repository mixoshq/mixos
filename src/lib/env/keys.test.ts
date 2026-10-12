/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  OPTIONAL_PLATFORM_KEYS,
  PLATFORM_KEYS,
  malformedOptionalKeys,
  optionalPlatformKey,
  platformKey,
} from "./keys";

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

function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

test("an optional key is off while unset or empty, and read like any other key when set", () => {
  const bytes = randomBytes(32);
  assert.equal(withEnv("GITHUB_APP_ENCRYPTION_KEY", undefined, () => optionalPlatformKey("githubAppEncryption")), null);
  assert.equal(withEnv("GITHUB_APP_ENCRYPTION_KEY", "", () => optionalPlatformKey("githubAppEncryption")), null);
  for (const spelling of [bytes.toString("hex"), bytes.toString("base64"), bytes.toString("base64url")]) {
    assert.deepEqual(
      withEnv("GITHUB_APP_ENCRYPTION_KEY", spelling, () => optionalPlatformKey("githubAppEncryption")),
      bytes,
    );
  }
});

test("an optional key set to anything but 32 bytes is an error naming it, never a quiet off", () => {
  for (const wrong of ["a".repeat(32), randomBytes(31).toString("hex"), "yes"]) {
    assert.throws(
      () => withEnv("GITHUB_APP_ENCRYPTION_KEY", wrong, () => optionalPlatformKey("githubAppEncryption")),
      /GITHUB_APP_ENCRYPTION_KEY must be 32 random bytes/,
    );
    const listed = withEnv("GITHUB_APP_ENCRYPTION_KEY", wrong, () => malformedOptionalKeys());
    assert.deepEqual(listed.map((m) => m.env), ["GITHUB_APP_ENCRYPTION_KEY"]);
    // The value itself is never repeated back.
    assert.ok(!listed[0].reason.includes(wrong), listed[0].reason);
  }
  assert.deepEqual(withEnv("GITHUB_APP_ENCRYPTION_KEY", undefined, () => malformedOptionalKeys()), []);
});

test("the GitHub App's key is not a required key", () => {
  const required: string[] = Object.values(PLATFORM_KEYS).map((k) => k.env);
  assert.ok(!required.includes("GITHUB_APP_ENCRYPTION_KEY"));
  assert.equal(OPTIONAL_PLATFORM_KEYS.githubAppEncryption.env, "GITHUB_APP_ENCRYPTION_KEY");
  assert.match(OPTIONAL_PLATFORM_KEYS.githubAppEncryption.rotationEffect, /keys:rotate-github-app/);
});
