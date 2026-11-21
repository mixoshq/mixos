/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A search object's `link` template, filled from one result.
 *
 * The template was held to its shape at build time (`searchLinkProblem` in
 * scripts/manifest-schemas.ts): a page path of the app, then name=value pairs
 * whose value is literal or one `{placeholder}`. So the path is copied as it
 * stands, and the only thing a result contributes is a query value, which is
 * URL-encoded here. Whatever a handler returns, the link stays under
 * `/apps/<slug>/`.
 */

const PLACEHOLDER = /^\{([a-zA-Z][a-zA-Z0-9_]*)\}$/;

/**
 * The href for one result, or null when the result lacks a value the template
 * needs (a `{key}` with no `params[key]`), which the caller drops: a row that
 * opens the wrong page is worse than a row left out.
 */
export function fillSearchLink(
  slug: string,
  template: string,
  result: { id: string; params?: Record<string, string> },
): string | null {
  const at = template.indexOf("?");
  const path = at === -1 ? template : template.slice(0, at);
  const query = at === -1 ? "" : template.slice(at + 1);

  const pairs: string[] = [];
  if (query) {
    for (const pair of query.split("&")) {
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq);
      const raw = pair.slice(eq + 1);
      const placeholder = PLACEHOLDER.exec(raw);
      if (!placeholder) {
        pairs.push(`${name}=${raw}`);
        continue;
      }
      const key = placeholder[1];
      const value = key === "id" ? result.id : result.params?.[key];
      if (value === undefined) return null;
      pairs.push(`${name}=${encodeURIComponent(value)}`);
    }
  }

  return `/apps/${encodeURIComponent(slug)}${path ? `/${path}` : ""}${pairs.length > 0 ? `?${pairs.join("&")}` : ""}`;
}
