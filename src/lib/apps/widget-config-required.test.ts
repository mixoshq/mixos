/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { isConfigValueFilled, missingRequiredFields } from "./widget-config-required";
import { titleField } from "./widget-config-presets";
import type { WidgetConfigField } from "./types";

const field = (type: WidgetConfigField["type"], extra: Partial<WidgetConfigField> = {}) =>
  ({ key: type, label: type, type, required: true, ...extra }) as WidgetConfigField;

// ── what counts as filled ───────────────────────────────────────────────────

test("text needs more than whitespace", () => {
  assert.equal(isConfigValueFilled(field("text"), "Pipeline"), true);
  for (const empty of [undefined, null, "", "   "]) {
    assert.equal(isConfigValueFilled(field("text"), empty), false, JSON.stringify(empty));
  }
});

test("a number needs a finite value, and zero is one", () => {
  assert.equal(isConfigValueFilled(field("number"), 0), true);
  assert.equal(isConfigValueFilled(field("number"), 12), true);
  for (const empty of [undefined, null, "", Number.NaN]) {
    assert.equal(isConfigValueFilled(field("number"), empty), false, String(empty));
  }
});

test("a select needs a chosen option, a multiselect at least one", () => {
  assert.equal(isConfigValueFilled(field("select"), "week"), true);
  assert.equal(isConfigValueFilled(field("select"), ""), false);
  assert.equal(isConfigValueFilled(field("select"), undefined), false);
  assert.equal(isConfigValueFilled(field("multiselect"), ["a"]), true);
  assert.equal(isConfigValueFilled(field("multiselect"), []), false);
  assert.equal(isConfigValueFilled(field("multiselect"), undefined), false);
});

test("a checkbox is never empty", () => {
  assert.equal(isConfigValueFilled(field("boolean"), false), true);
  assert.equal(isConfigValueFilled(field("boolean"), undefined), true);
});

// ── which fields block a save ───────────────────────────────────────────────

test("an empty required field blocks the save; an optional one does not", () => {
  const fields = [field("text"), field("select", { required: false })];
  assert.deepEqual(missingRequiredFields(fields, {}), ["text"]);
  assert.deepEqual(missingRequiredFields(fields, { text: "Pipeline" }), []);
});

test("titleField's empty default has to be filled in", () => {
  const title = titleField() as WidgetConfigField;
  assert.deepEqual(missingRequiredFields([title], { title: title.default }), ["title"]);
  assert.deepEqual(missingRequiredFields([title], { title: "My links" }), []);
});

test("a field resolveConfig hides is never required", () => {
  const fields = [field("multiselect")];
  assert.deepEqual(missingRequiredFields(fields, {}), ["multiselect"]);
  assert.deepEqual(missingRequiredFields(fields, {}, { multiselect: { visible: false } }), []);
});
