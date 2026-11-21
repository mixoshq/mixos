/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What an app's search handler is given, what it returns, and the helpers that
 * make every app rank the same way. On the app import allowlist
 * (./import-policy.mjs); see docs/apps/search.md.
 *
 * THE RANKING RULE. A result matches when any declared field contains the
 * query, ignoring case. Matches in the first field (the title) come first, then
 * matches in the second field that were not already listed, and so on; inside
 * each field, the order is whatever the handler's own query gives — most
 * recent first, for most data. One rule for every app is what lets results
 * from six apps sit in one modal without one app's notion of "relevant"
 * crowding out another's.
 *
 * WHY ONE QUERY PER FIELD. The query builder has no `or()`, so "title or body
 * contains" is not one query. `searchFields()` runs one per field and merges
 * them, which is also exactly what puts title matches first.
 */

/** What the platform hands a search handler. */
export interface SearchInput {
  /** What the person typed, trimmed: 2 to 100 characters. */
  query: string;
  /**
   * The keys of the object's declared `fields`, title first. Handed over so
   * the handler searches exactly what `app.json` says it does.
   */
  fields: string[];
  /** How many matches to skip: 0 for the first page, then 5, 15, 25… */
  offset: number;
  /**
   * The most results to return. One more than the modal will show, which is
   * how the platform tells whether there are more — so return up to this many
   * and no fewer when there are that many.
   */
  limit: number;
}

/** One match, as a search handler returns it. */
export interface SearchResult {
  /** Stable id, unique within the object. Fills `{id}` in the object's `link`. */
  id: string;
  /** The row's main line. At most 200 characters. */
  title: string;
  /** A second line: a snippet, a date, a status. At most 300 characters. */
  subtitle?: string;
  /** Values for the `link`'s other `{placeholder}`s, by name. */
  params?: Record<string, string>;
}

/**
 * The `ilike` pattern for "contains `query`": `%query%`, with LIKE's own
 * wildcards in the query escaped so a person typing `50%` or `snake_case`
 * finds those characters rather than matching everything.
 *
 * The query builder turns every `*` into `%` before Postgres sees it, so a
 * literal `*` cannot be written; it becomes `_`, which matches any one
 * character, a `*` included. Slightly broad, never empty-handed.
 */
export function containsPattern(query: string): string {
  const escaped = query
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_")
    .replace(/\*/g, "_");
  return `%${escaped}%`;
}

/**
 * Whether `value` contains `query`, ignoring case: the same rule as
 * `containsPattern`, for data the handler holds in memory. Anything that isn't
 * a string or a number never matches.
 */
export function matchesQuery(value: unknown, query: string): boolean {
  if (typeof value === "number") value = String(value);
  if (typeof value !== "string") return false;
  return value.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

/**
 * Search every declared field and return this page of the merged, ranked
 * results.
 *
 * `fetch(field, take)` returns up to `take` rows where `field` contains the
 * query, in the handler's preferred order — typically
 * `ctx.db.table("notes").select(...).ilike(field, containsPattern(query)).order("updated_at", { ascending: false }).limit(take)`.
 * `toResult` turns a row into a result; rows with the same `id` are listed
 * once, under the highest-ranked field they matched.
 *
 * Each field is asked for `offset + limit` rows, which is always enough: the
 * rows a field repeats from earlier fields are at most as many as are already
 * listed, so every field contributes all it needs to fill the page.
 */
export async function searchFields<Row>(options: {
  input: SearchInput;
  fetch: (field: string, take: number) => Promise<readonly Row[]> | readonly Row[];
  toResult: (row: Row) => SearchResult;
}): Promise<SearchResult[]> {
  const { input, fetch, toResult } = options;
  const need = input.offset + input.limit;
  if (input.limit <= 0) return [];
  const perField = await Promise.all(input.fields.map(async (field) => await fetch(field, need)));
  const seen = new Set<string>();
  const merged: SearchResult[] = [];
  for (const rows of perField) {
    for (const row of rows) {
      if (merged.length >= need) break;
      const result = toResult(row);
      if (seen.has(result.id)) continue;
      seen.add(result.id);
      merged.push(result);
    }
    if (merged.length >= need) break;
  }
  return merged.slice(input.offset, need);
}
