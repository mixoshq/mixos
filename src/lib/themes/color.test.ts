/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { composite, parseColor, resolveVar, toHex } from "./color";

test("an opaque colour parses with alpha 1, in every accepted spelling", () => {
  const spellings = ["#0369a1", "#0369A1", "rgb(3 105 161)", "rgb(3, 105, 161)", "hsl(201 96% 32%)"];
  for (const v of spellings) {
    const c = parseColor(v);
    assert.ok(c, v);
    assert.equal(c.alpha, 1, v);
  }
  assert.deepEqual(parseColor("#fff"), { rgb: [255, 255, 255], alpha: 1 });
  assert.deepEqual(parseColor("white"), { rgb: [255, 255, 255], alpha: 1 });
});

test("alpha is returned rather than dropped", () => {
  assert.deepEqual(parseColor("rgb(100 116 139 / 0.5)"), { rgb: [100, 116, 139], alpha: 0.5 });
  assert.deepEqual(parseColor("rgba(100, 116, 139, 25%)"), { rgb: [100, 116, 139], alpha: 0.25 });
  assert.equal(parseColor("hsla(0, 0%, 100%, 0.1)")?.alpha, 0.1);
  assert.equal(parseColor("#00000080")?.alpha, 128 / 255);
  assert.equal(parseColor("#0008")?.alpha, 136 / 255);
  assert.equal(parseColor("rgb(0 0 0 / 1)")?.alpha, 1);
});

test("a value the build cannot evaluate is null", () => {
  const unreadable = [
    "oklch(0.6 0.1 200)",
    "color-mix(in srgb, red, blue)",
    "var(--x, #fff)",
    "red",
    "#12345",
  ];
  for (const v of unreadable) {
    assert.equal(parseColor(v), null, v);
  }
});

test("a var() chain resolves to the literal it ends in", () => {
  const block = new Map([
    ["primary", "var(--brand-cyan)"],
    ["brand-cyan", "#0284c7"],
  ]);
  assert.deepEqual(resolveVar("var(--primary)", block), { value: "#0284c7" });
  assert.deepEqual(resolveVar(" #fff ", block), { value: "#fff" });
});

test("a chain ending in an unset token says which one, and through what", () => {
  const block = new Map([
    ["ring", "var(--primary)"],
    ["primary", "var(--brand-cyan)"],
  ]);
  assert.deepEqual(resolveVar("var(--primary)", block, ["ring"]), {
    missing: "brand-cyan",
    chain: ["ring", "primary"],
  });
});

test("a loop is reported rather than followed forever", () => {
  const block = new Map([
    ["a", "var(--b)"],
    ["b", "var(--a)"],
  ]);
  assert.deepEqual(resolveVar("var(--b)", block, ["a"]), { loop: ["a", "b", "a"] });
  assert.deepEqual(resolveVar("var(--a)", new Map([["a", "var(--a)"]]), ["a"]), {
    loop: ["a", "a"],
  });
});

test("compositing and hex output", () => {
  assert.deepEqual(composite([100, 116, 139], [255, 255, 255], 0.5), [178, 186, 197]);
  assert.equal(toHex([178, 186, 197]), "#b2bac5");
  assert.equal(toHex([3, 5, 255]), "#0305ff");
});
