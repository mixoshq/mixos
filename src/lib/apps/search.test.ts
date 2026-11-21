/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * src/lib/apps/search.ts: the ranking every search handler shares — contains,
 * title first, each result once — and the LIKE pattern it queries with.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { containsPattern, matchesQuery, searchFields, type SearchInput } from "./search";

interface Row {
  id: string;
  title: string;
  body: string;
}

/** Newest first, as a handler's query would order them. */
const ROWS: Row[] = [
  { id: "1", title: "Garden plan", body: "tomatoes and basil" },
  { id: "2", title: "Groceries", body: "basil, garlic" },
  { id: "3", title: "Basil pesto", body: "pine nuts" },
  { id: "4", title: "Trip notes", body: "buy basil seeds" },
  { id: "5", title: "Basil varieties", body: "thai basil, lemon basil" },
  { id: "6", title: "Unrelated", body: "nothing here" },
];

function input(query: string, offset: number, limit: number): SearchInput {
  return { query, fields: ["title", "body"], offset, limit };
}

/** A fetch over ROWS that records what it was asked for. */
function fetcher(asked: { field: string; take: number }[] = []) {
  return (field: string, take: number) => {
    asked.push({ field, take });
    return ROWS.filter((r) => matchesQuery(r[field as keyof Row], "basil")).slice(0, take);
  };
}

const toResult = (r: Row) => ({ id: r.id, title: r.title });

test("title matches come first, then other fields, each result once", async () => {
  const results = await searchFields({ input: input("basil", 0, 10), fetch: fetcher(), toResult });
  // 3 and 5 match the title; 1, 2, 4 only the body; 5 also matches the body and is listed once.
  assert.deepEqual(
    results.map((r) => r.id),
    ["3", "5", "1", "2", "4"],
  );
});

test("pages through the merged list without gaps or repeats", async () => {
  const all = await searchFields({ input: input("basil", 0, 10), fetch: fetcher(), toResult });
  const pages: string[] = [];
  for (let offset = 0; offset < 6; offset += 2) {
    const page = await searchFields({ input: input("basil", offset, 2), fetch: fetcher(), toResult });
    pages.push(...page.map((r) => r.id));
  }
  assert.deepEqual(pages, all.map((r) => r.id));
});

test("asks each field for offset + limit rows, in field order", async () => {
  const asked: { field: string; take: number }[] = [];
  await searchFields({ input: input("basil", 5, 11), fetch: fetcher(asked), toResult });
  assert.deepEqual(asked, [
    { field: "title", take: 16 },
    { field: "body", take: 16 },
  ]);
});

test("a limit of 0 asks for nothing", async () => {
  const asked: { field: string; take: number }[] = [];
  assert.deepEqual(await searchFields({ input: input("basil", 0, 0), fetch: fetcher(asked), toResult }), []);
  assert.deepEqual(asked, []);
});

test("containsPattern escapes LIKE's wildcards and wraps the query", () => {
  assert.equal(containsPattern("basil"), "%basil%");
  assert.equal(containsPattern("50%"), "%50\\%%");
  assert.equal(containsPattern("snake_case"), "%snake\\_case%");
  assert.equal(containsPattern("a\\b"), "%a\\\\b%");
  // The query builder turns every `*` into `%`, so a literal `*` can only be `_`.
  assert.equal(containsPattern("a*b"), "%a_b%");
});

test("matchesQuery ignores case, matches numbers, and refuses anything else", () => {
  assert.equal(matchesQuery("Basil Pesto", "basil"), true);
  assert.equal(matchesQuery("BASIL", "Basil"), true);
  assert.equal(matchesQuery(2026, "202"), true);
  assert.equal(matchesQuery("thyme", "basil"), false);
  assert.equal(matchesQuery(null, "basil"), false);
  assert.equal(matchesQuery({ title: "basil" }, "basil"), false);
});
