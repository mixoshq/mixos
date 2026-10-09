/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { nextPageLink } from "./status-map";

const REQUESTED = "https://api.example.com/repos/acme/issues?per_page=100";

test("the next page is read from a GitHub-style Link header", () => {
  const header =
    '<https://api.example.com/repositories/9/issues?per_page=100&page=2>; rel="next", ' +
    '<https://api.example.com/repositories/9/issues?per_page=100&page=7>; rel="last"';
  assert.equal(
    nextPageLink(header, REQUESTED),
    "https://api.example.com/repositories/9/issues?per_page=100&page=2",
  );
});

test("no next relation means the last page", () => {
  assert.equal(nextPageLink('<https://api.example.com/x?page=1>; rel="first"', REQUESTED), null);
  assert.equal(nextPageLink(null, REQUESTED), null);
  assert.equal(nextPageLink("", REQUESTED), null);
});

test("a relative link is resolved against the URL that was requested", () => {
  assert.equal(
    nextPageLink('</repos/acme/issues?page=2>; rel="next"', REQUESTED),
    "https://api.example.com/repos/acme/issues?page=2",
  );
});

test("next is found wherever it sits, however rel is written", () => {
  const target = "https://api.example.com/x?page=2";
  for (const header of [
    `<https://api.example.com/x?page=1>; rel="prev", <${target}>; rel="next"`,
    `<${target}>; rel=next`,
    `<${target}>; REL="Next"`,
    `<${target}>; rel="next last"`,
    `<${target}>;rel="next"`,
  ]) {
    assert.equal(nextPageLink(header, REQUESTED), target, header);
  }
});

test("commas inside a URL or a quoted parameter do not split a link", () => {
  assert.equal(
    nextPageLink(
      '<https://api.example.com/x?ids=1,2>; title="a, b"; rel="next"',
      REQUESTED,
    ),
    "https://api.example.com/x?ids=1,2",
  );
  assert.equal(
    nextPageLink(
      '<https://api.example.com/x?page=1>; title="next, page"; rel="prev", <https://api.example.com/x?page=3>; rel="next"',
      REQUESTED,
    ),
    "https://api.example.com/x?page=3",
  );
});

test("a malformed header yields no next page rather than a guess", () => {
  assert.equal(nextPageLink('<https://api.example.com/x?page=2; rel="next"', REQUESTED), null);
  assert.equal(nextPageLink('<http://[bad>; rel="next"', REQUESTED), null);
});
