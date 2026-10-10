/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Plain-English permissions, parsed off a provider's own scope reference page.
 *
 * WHY PARSE AT ALL. `https://api.example.com/auth/records.readonly` tells a
 * non-technical admin nothing. "View your records and settings" tells them
 * everything. The provider already writes that sentence — it is the string
 * shown on their consent screen — and nowhere else has it.
 *
 * WHY THIS RUNS AT AUTHORING TIME, NOT AT RUNTIME. A third party's HTML is not
 * a contract; it will break, quietly, the day the provider reshapes the page.
 * So the parse happens when a developer runs
 * `scripts/check-scopes.ts <connector> --write`, and the result is committed to
 * `connector.json` — reviewable in a diff, identical across installs, and
 * incapable of degrading because someone else had a bad afternoon. Nothing here
 * touches the database, and no page load depends on a third party being up.
 */

export type ScopeAccess = "read" | "write" | "read-write";

export interface DocumentedScope {
  scope: string;
  description: string;
  access: ScopeAccess;
}

/** Refuse a page that is not plausibly a docs page, rather than parse garbage. */
const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

const READ_VERBS = /\b(see|view|read|readonly|read-only)\b/;
/*
  `add` excludes `add-on`: three of Gmail's read-only add-on scopes are described
  as "... when you interact with the add-on", and a bare \badd\b matched inside
  the hyphenated word and reported them as writes. On a permissions screen an
  over-report is a false alarm an admin cannot dismiss.
*/
const WRITE_VERBS =
  /\b(send|compose|create|delete|edit|change|insert|modify|write|manage|add(?!-)|full access)\b/;
/** These imply reading as well as writing even with no read verb present. */
const BOTH_VERBS = /\b(manage|full access)\b/;

export function classifyScope(description: string): ScopeAccess {
  const text = description.toLowerCase();
  const write = WRITE_VERBS.test(text);
  const read = READ_VERBS.test(text) || BOTH_VERBS.test(text);
  if (read && write) return "read-write";
  if (write) return "write";
  return "read";
}

/** `https://www.googleapis.com/auth/gmail.readonly`, `https://mail.google.com/` */
const URL_SCOPE = /https:\/\/[\w.\-]+\/(?:auth\/)?[\w.\-]*/;

/**
 * A scope that is a name rather than a URL, recognised by its structure:
 * `channels:read`, `read:jira-work`, `Mail.ReadWrite`, `read_products`,
 * `crm.objects.contacts.read`. A `:`, `.` or `_` between word characters is
 * what tells it from the plain words a scope table also holds in its cells
 * ("Yes", "Delegated", "Read"). `/` and `-` alone do not count, or "N/A" and
 * "Read/Write" would read as scopes.
 */
const NAMED_SCOPE = /^[A-Za-z][\w-]*(?:[:.][\w-]+)+$|^[A-Za-z][A-Za-z0-9]*_[\w-]+$/;

/**
 * A scope that is a bare word, like GitHub's `repo` and `gist`. Nothing in the
 * word says it is a scope, so it is only taken from a row's first cell, and
 * only when the page sets that cell's whole text as code. A code-set word
 * further along a row is usually what the scope grants access to — Shopify
 * puts the object name `Cart` beside its scopes.
 */
const WORD_SCOPE = /^[A-Za-z][\w:.\-/]*$/;

/** Text content of an HTML fragment, entities decoded, whitespace collapsed. */
function stripTags(html: string): string {
  return (
    html
      // `<wbr>` is a line-break opportunity inside a word, not a space. Google
      // puts them inside long scope URLs.
      .replace(/<wbr\s*\/?>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/gi, "'")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** Is the whole of this cell's text inside one `<code>` (or kin) element? */
function isCodeCell(cellHtml: string, text: string): boolean {
  for (const m of cellHtml.matchAll(/<(code|kbd|samp|tt)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    if (stripTags(m[2]) === text) return true;
  }
  return false;
}

/**
 * The scope a row documents, and which cell it is in — or null.
 *
 * A scope URL wins wherever it sits, as it always has. Otherwise it is the
 * leftmost cell that is a scope by its shape, or a bare word set as code in
 * the first cell: a scope table leads with the scope, and the cells after it
 * are where a stray `false` or an object name would be.
 */
function scopeOfRow(
  cells: { html: string; text: string }[],
): { scope: string; index: number } | null {
  // A scope never contains whitespace; a cell that does is prose.
  const single = cells
    .map((cell, index) => ({ ...cell, index }))
    .filter((c) => c.text.length > 0 && !/\s/.test(c.text));

  for (const c of single) {
    const url = c.text.match(URL_SCOPE)?.[0];
    if (url) return { scope: url, index: c.index };
  }
  for (const c of single) {
    if (
      NAMED_SCOPE.test(c.text) ||
      (c.index === 0 && WORD_SCOPE.test(c.text) && isCodeCell(c.html, c.text))
    ) {
      return { scope: c.text, index: c.index };
    }
  }
  return null;
}

/**
 * Pull scope/description pairs out of a documentation page.
 *
 * Regex over the HTML rather than a parser: the shape being matched is a table
 * row containing something that looks like a scope, which is stable across
 * far more markup changes than any selector would be, and it costs no
 * dependency. A scope is a URL (Google), a name with structure
 * (`channels:read`, `Mail.Read`), or a bare word the page sets as code
 * (GitHub's `repo`) — see `scopeOfRow`. It is found *anywhere* in the row
 * rather than assumed to be the first cell — Gmail's own page puts
 * `mail.google.com` in a different column from the rest.
 */
export function parseScopeDocs(html: string): DocumentedScope[] {
  const out = new Map<string, DocumentedScope>();

  for (const row of html.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = (row.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) ?? []).map(
      (html) => ({ html, text: stripTags(html) }),
    );
    if (cells.length < 2) continue;

    const found = scopeOfRow(cells);
    if (!found) continue;
    const { scope } = found;

    // The description is the longest cell that is not the scope itself.
    const description = cells
      .filter((c, i) => i !== found.index && c.text.length > 0)
      .map((c) => c.text)
      .sort((a, b) => b.length - a.length)[0];
    if (!description) continue;

    // First row wins: a page that lists a scope twice is documenting it once
    // and cross-referencing it elsewhere.
    if (!out.has(scope)) {
      out.set(scope, {
        scope,
        description,
        access: classifyScope(description),
      });
    }
  }
  return [...out.values()];
}

/** Fetch and parse, with a timeout and a size cap. Throws a readable message. */
export async function fetchScopeDocs(url: string): Promise<DocumentedScope[]> {
  if (!url.startsWith("https://"))
    throw new Error("Reference URL is not https.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "text/html",
        /*
          Without this, providers localise. Google served this exact page in
          Hindi to a request that expressed no preference, and the descriptions
          were cached and displayed that way — classified correctly, and
          unreadable to the admin looking at them. The registry is English, so
          the request has to say so.
        */
        "accept-language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) throw new Error(`The page returned HTTP ${res.status}.`);

    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > MAX_BYTES) throw new Error("The page is too large to parse.");

    const body = await res.text();
    if (body.length > MAX_BYTES)
      throw new Error("The page is too large to parse.");

    const scopes = parseScopeDocs(body);
    if (scopes.length === 0) {
      throw new Error(
        "No scopes could be read from the page — its layout has probably changed.",
      );
    }
    return scopes;
  } finally {
    clearTimeout(timer);
  }
}
