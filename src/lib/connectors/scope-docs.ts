/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { sql } from "@/lib/db/client";

/**
 * Plain-English permissions, read off a provider's own scope reference page.
 *
 * WHY SCRAPE AT ALL. `https://www.googleapis.com/auth/gmail.readonly` tells a
 * non-technical admin nothing. "View your email messages and settings" tells
 * them everything. The provider already writes that sentence — it is the string
 * shown on their consent screen — and nowhere else has it.
 *
 * WHY IT IS A CACHE AND NOT A SOURCE OF TRUTH. A third party's HTML is not a
 * contract. This will break, quietly, the day Google reshapes that page. So a
 * failed refresh never blanks a good previous read (see `last_error`), and this
 * list sits *beside* the connector's own declared capability list rather than
 * replacing it — that one the build can actually verify.
 */

export type ScopeAccess = "read" | "write" | "read-write";

export interface DocumentedScope {
  scope: string;
  description: string;
  access: ScopeAccess;
}

export interface ScopeDocs {
  sourceUrl: string | null;
  scopes: DocumentedScope[];
  /** When a parse last succeeded. Null means it never has. */
  fetchedAt: number | null;
  /** When a refresh was last attempted, successful or not. */
  lastAttemptAt: number | null;
  /** Why the last attempt failed, or null if it succeeded. */
  lastError: string | null;
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

/**
 * Pull scope/description pairs out of a documentation page.
 *
 * Regex over the HTML rather than a parser: the shape being matched is a table
 * row containing something that looks like a scope URL, which is stable across
 * far more markup changes than any selector would be, and it costs no
 * dependency. The scope is found *anywhere* in the row rather than assumed to
 * be the first cell — Gmail's own page puts `mail.google.com` in a different
 * column from the rest.
 */
export function parseScopeDocs(html: string): DocumentedScope[] {
  const stripTags = (s: string) =>
    s
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();

  const scopePattern = /https:\/\/[\w.\-]+\/(?:auth\/)?[\w.\-]*/;
  const out = new Map<string, DocumentedScope>();

  for (const row of html.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = (row.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) ?? []).map(stripTags);
    if (cells.length < 2) continue;

    const scopeCell = cells.find((c) => scopePattern.test(c) && /\s/.test(c) === false);
    const scope = scopeCell?.match(scopePattern)?.[0];
    if (!scope) continue;

    // The description is the longest cell that is not the scope itself.
    const description = cells
      .filter((c) => c !== scopeCell && c.length > 0)
      .sort((a, b) => b.length - a.length)[0];
    if (!description) continue;

    // First row wins: a page that lists a scope twice is documenting it once
    // and cross-referencing it elsewhere.
    if (!out.has(scope)) {
      out.set(scope, { scope, description, access: classifyScope(description) });
    }
  }
  return [...out.values()];
}

/** Fetch and parse, with a timeout and a size cap. Throws a readable message. */
export async function fetchScopeDocs(url: string): Promise<DocumentedScope[]> {
  if (!url.startsWith("https://")) throw new Error("Reference URL is not https.");

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
    if (body.length > MAX_BYTES) throw new Error("The page is too large to parse.");

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

/**
 * Read the cached array back, tolerating a row written as a JSON *string*.
 *
 * `${JSON.stringify(scopes)}::jsonb` looked right and was not: postgres.js sees
 * a JS string bound to a jsonb column and encodes it as a JSON string, so the
 * column ended up holding `"[{...}]"` — a scalar — rather than the array. The
 * write is fixed to use `sql.json`, and this keeps rows written the old way
 * from silently reading as "no scopes found", which is exactly how the bug
 * presented: a refresh that reported success and displayed nothing.
 */
function coerceScopes(raw: unknown): DocumentedScope[] {
  if (Array.isArray(raw)) return raw as DocumentedScope[];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as DocumentedScope[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

const ms = (d: Date | null | undefined) => {
  const t = d ? new Date(d).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
};

export async function getScopeDocs(connectorName: string): Promise<ScopeDocs> {
  try {
    const rows = await sql<
      {
        source_url: string;
        scopes: DocumentedScope[];
        fetched_at: Date | null;
        last_attempt_at: Date | null;
        last_error: string | null;
      }[]
    >`
      select source_url, scopes, fetched_at, last_attempt_at, last_error
        from public.connector_scope_docs
       where connector_name = ${connectorName}
    `;
    const row = rows[0];
    if (!row) {
      return {
        sourceUrl: null,
        scopes: [],
        fetchedAt: null,
        lastAttemptAt: null,
        lastError: null,
      };
    }
    return {
      sourceUrl: row.source_url,
      scopes: coerceScopes(row.scopes),
      fetchedAt: ms(row.fetched_at),
      lastAttemptAt: ms(row.last_attempt_at),
      lastError: row.last_error,
    };
  } catch {
    return {
      sourceUrl: null,
      scopes: [],
      fetchedAt: null,
      lastAttemptAt: null,
      lastError: null,
    };
  }
}

/**
 * Refresh one connector's cached scope docs.
 *
 * A failure records the reason and the attempt time but leaves `scopes` and
 * `fetched_at` untouched, so the dialog keeps showing the last good read and
 * says how old it is. Blanking a permissions list because a docs page moved
 * would be a worse outcome than showing accurate but dated information.
 */
export async function refreshScopeDocs(
  connectorName: string,
  url: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const scopes = await fetchScopeDocs(url);
    await sql`
      insert into public.connector_scope_docs
        (connector_name, source_url, scopes, fetched_at, last_attempt_at, last_error)
      values (${connectorName}, ${url}, ${sql.json(scopes as never)}, now(), now(), null)
      on conflict (connector_name) do update
        set source_url = excluded.source_url,
            scopes = excluded.scopes,
            fetched_at = now(),
            last_attempt_at = now(),
            last_error = null
    `;
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "The refresh failed.";
    await sql`
      insert into public.connector_scope_docs
        (connector_name, source_url, last_attempt_at, last_error)
      values (${connectorName}, ${url}, now(), ${message})
      on conflict (connector_name) do update
        set last_attempt_at = now(), last_error = ${message}
    `.catch(() => {});
    return { ok: false, error: message };
  }
}
