/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How the Access tab shows what it reads: only the newest read's answer is
 * applied, and a count that couldn't be read says so instead of looking like
 * it is still on its way.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { newestWins } from "./newest-wins";
import { SegmentCount } from "./app-access-panel";

test("of two reads in flight, only the newer one's answer is applied, whichever lands first", async () => {
  const ticket = newestWins();
  const shown: string[] = [];
  const read = (answer: string, ms: number) => {
    const isNewest = ticket();
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        if (isNewest()) shown.push(answer);
        resolve();
      }, ms),
    );
  };
  // The first read is slow: its answer, from before the second change, lands last.
  await Promise.all([read("before the revoke", 20), read("after the revoke", 1)]);
  assert.deepEqual(shown, ["after the revoke"]);

  // A read on its own is the newest.
  await read("later", 1);
  assert.deepEqual(shown, ["after the revoke", "later"]);
});

test("a segment count: a number, a loading mark, or a mark that says the read failed", () => {
  const render = (count: number | "failed" | null) =>
    renderToStaticMarkup(createElement(SegmentCount, { count }));
  assert.match(render(3), />3</);
  assert.match(render(null), /aria-label="loading">…</);
  const failed = render("failed");
  assert.match(failed, /couldn&#x27;t be read/);
  assert.match(failed, /title="Couldn&#x27;t be read"/);
  assert.doesNotMatch(failed, /…/);
});
