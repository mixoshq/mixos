/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { BRAND_NAME_MAX_LENGTH, brandLogoUrl, sanitizeBrandName } from "./types";

test("sanitizeBrandName keeps an ordinary name", () => {
  assert.equal(sanitizeBrandName("Acme Workspace"), "Acme Workspace");
});

test("sanitizeBrandName folds whitespace and control characters onto one line", () => {
  assert.equal(sanitizeBrandName("  Acme\n\tWorkspace  "), "Acme Workspace");
  assert.equal(sanitizeBrandName("Acme\u0000Workspace"), "Acme Workspace");
});

test("sanitizeBrandName refuses empty, over-long and non-string values", () => {
  assert.equal(sanitizeBrandName(""), null);
  assert.equal(sanitizeBrandName("   "), null);
  assert.equal(sanitizeBrandName("x".repeat(BRAND_NAME_MAX_LENGTH + 1)), null);
  assert.equal(sanitizeBrandName(42), null);
  assert.equal(sanitizeBrandName(undefined), null);
  assert.equal(sanitizeBrandName(null), null);
});

test("sanitizeBrandName accepts a name at exactly the limit", () => {
  const name = "x".repeat(BRAND_NAME_MAX_LENGTH);
  assert.equal(sanitizeBrandName(name), name);
});

test("brandLogoUrl publishes under the app's own folder", () => {
  assert.equal(brandLogoUrl("acme", "branding/mark.png"), "/branding/apps/acme/mark.png");
});
