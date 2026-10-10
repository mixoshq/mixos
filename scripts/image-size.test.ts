/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readImageSize, readSvgSize } from "./image-size";

test("an absolute width and height are the SVG's size", () => {
  assert.deepEqual(readSvgSize('<svg width="120" height="40px" viewBox="0 0 12 4"></svg>'), {
    width: 120,
    height: 40,
  });
});

test("a viewBox gives the size when width and height are absent or relative", () => {
  assert.deepEqual(readSvgSize('<svg viewBox="0 0 256 244"/>'), { width: 256, height: 244 });
  assert.deepEqual(readSvgSize('<svg width="100%" height="100%" viewBox="0,0,300,100"/>'), {
    width: 300,
    height: 100,
  });
});

test("the root is found past a prolog and comments, attributes in any quotes", () => {
  const svg = `<?xml version="1.0"?>\n<!-- a mark -->\n<svg xmlns='http://www.w3.org/2000/svg'\n  viewBox='0 0 10 5'>`;
  assert.deepEqual(readSvgSize(svg), { width: 10, height: 5 });
});

test("stroke-width is not mistaken for width", () => {
  assert.deepEqual(readSvgSize('<svg stroke-width="2" height="9" viewBox="0 0 10 5"/>'), {
    width: 10,
    height: 5,
  });
});

test("an SVG that states no size is reported as unmeasurable", () => {
  assert.equal(readSvgSize('<svg xmlns="http://www.w3.org/2000/svg"/>'), null);
  assert.equal(readSvgSize('<svg viewBox="0 0 0 10"/>'), null);
  assert.equal(readSvgSize("not an svg"), null);
});

test("a PNG's size is read from its header", () => {
  const buf = Buffer.alloc(33);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(256, 16);
  buf.writeUInt32BE(244, 20);
  assert.deepEqual(readImageSize(buf), { width: 256, height: 244 });
});
