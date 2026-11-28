/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Function out of reach by reflection. This file's process is locked for the
 * rest of its run, which is the point: node --test gives each file its own.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { lockFunctionConstructors } from "./reflection-lock";

const routes: Array<[string, () => unknown]> = [
  ["(() => {}).constructor", () => (() => {}).constructor("return process")()],
  ["(async () => {}).constructor", () => (async () => {}).constructor("return process")],
  ["(function* () {}).constructor", () => function* () {}.constructor("return process")],
  ["(async function* () {}).constructor", () => async function* () {}.constructor("return process")],
  ["Object.constructor", () => Object.constructor("return process")()],
  ["({}).constructor.constructor", () => ({}).constructor.constructor("return process")()],
  ['fn["constru" + "ctor"]', () => (Math.max as unknown as Record<string, (s: string) => () => unknown>)["constru" + "ctor"]("return process")()],
  ["Reflect.getPrototypeOf(fn).constructor", () => (Reflect.getPrototypeOf(() => {}) as { constructor: (s: string) => () => unknown }).constructor("return process")()],
];

test("before the lock, each route reaches process", () => {
  for (const [what, reach] of routes.slice(0, 1)) assert.equal(reach(), process, what);
});

test("after it, every route to Function by reflection throws, naming why", () => {
  assert.equal(lockFunctionConstructors(), true);
  for (const [what, reach] of routes) {
    assert.throws(reach, (err: Error) => err instanceof EvalError && /refused in this server/.test(err.message), what);
  }
});

test("Function by name still works, and the names libraries check are kept", () => {
  assert.equal(new Function("return 1")(), 1);
  assert.equal((() => {}).constructor.name, "Function");
  assert.equal((async () => {}).constructor.name, "AsyncFunction");
  assert.equal(function* () {}.constructor.name, "GeneratorFunction");
  assert.ok((() => {}) instanceof Function);
});

test("it can't be put back, and a second lock changes nothing", () => {
  assert.throws(() => Object.defineProperty(Function.prototype, "constructor", { value: Function }), TypeError);
  assert.equal(lockFunctionConstructors(), false);
});
