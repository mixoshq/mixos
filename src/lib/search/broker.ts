/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { checkAppGate } from "@/lib/apps/app-gate";
import { buildReadOnlyAppContext } from "@/lib/apps/read-only-context";
import { refusalMessage } from "@/lib/apps/read-only";
import type { SearchInput, SearchResult } from "@/lib/apps/search";
import type { AppManifest, SearchObjectDefinition } from "@/lib/apps/types";
import type { SearchContext } from "@/lib/hooks/types";
import { safeErrorMessage } from "@/lib/safe-error";
import { fillSearchLink } from "./link";
import type { SearchHit } from "./types";

/**
 * The search broker: the one path from the ⌘K modal to an app's data.
 *
 * The MCP broker's stance (src/lib/mcp/broker.ts), for a person rather than a
 * model: the caller has already been checked to hold the app (./server.ts asks
 * `getUserApps`), the app gate is asked before the handler's module is
 * imported, the context is the app's own narrowed to reads, and every handler
 * runs bounded — a timeout, a cap on what it returns, and output checked
 * before any of it reaches the browser. One object failing costs that object's
 * rows and nothing else.
 */

/**
 * 5s, not MCP's 30s: a person is watching the modal, and one slow app should
 * show as one missing section rather than hold every other app's rows back.
 */
const SEARCH_TIMEOUT_MS = 5_000;

/** What a person sees when an object could not be searched. Never the error itself. */
const UNAVAILABLE = "Couldn't search this right now.";
const UPDATING = "This app is being updated.";

export type SearchHandler = (ctx: SearchContext, input: SearchInput) => unknown | Promise<unknown>;

/**
 * Import a search handler. Template-literal import, as the platform loads MCP
 * tools, jobs and services. Null when the module or its default export is
 * missing, which the generator refuses, so it means a broken checkout.
 */
async function loadSearchHandler(slug: string, name: string): Promise<SearchHandler | null> {
  let mod: { default?: unknown };
  try {
    mod = await import(`@apps/${slug}/search/${name}`);
  } catch (err) {
    console.error(`[search] failed to import ${slug}/search/${name}:`, err);
    return null;
  }
  return typeof mod.default === "function" ? (mod.default as SearchHandler) : null;
}

/** A string, or a number written as one: what an id or a param may be. */
const stringish = z.union([z.string(), z.number().finite()]).transform(String);

/**
 * What a handler may return. Strings are trimmed to the lengths the modal has
 * room for rather than refused: a long title is the app's data, not its bug.
 */
const ResultSchema = z.object({
  id: stringish.pipe(z.string().min(1).max(200)),
  title: z.string().transform((s) => s.trim().slice(0, 200)),
  subtitle: z
    .string()
    .nullish()
    .transform((s) => (s ? s.trim().slice(0, 300) : null)),
  params: z.record(z.string(), stringish).optional(),
});

const ResultsSchema = z.array(z.unknown());

/** One object's page, or why it has none. */
export type ObjectPage =
  | { ok: true; hits: SearchHit[]; hasMore: boolean }
  | { ok: false; error: string };

/**
 * A person's view of one app for one search: its read-only context, built
 * once and shared by every object the app declares.
 */
export interface AppSearchSession {
  manifest: AppManifest;
  /** Null once the app turned out to be closed (switched off, or updating). */
  ctx: SearchContext | null;
  closed: string | null;
}

/**
 * Open an app for searching: the app gate, then its read-only context. A
 * gate that is shut, or a context that can't be built, leaves `ctx` null and
 * says why in words a person can read.
 */
export async function openAppForSearch(
  manifest: AppManifest,
  dbUser: { id: string; email: string; display_name: string; is_admin: boolean },
): Promise<AppSearchSession> {
  const gate = await checkAppGate(manifest.slug);
  if (!gate.open) {
    return { manifest, ctx: null, closed: gate.reason === "updating" ? UPDATING : UNAVAILABLE };
  }
  try {
    const readOnly = await buildReadOnlyAppContext(manifest.slug, dbUser);
    return {
      manifest,
      ctx: {
        user: readOnly.user,
        connectors: readOnly.connectors,
        db: readOnly.db,
        services: readOnly.services,
        manifest: readOnly.manifest,
        caller: { kind: "search" },
      },
      closed: null,
    };
  } catch (err) {
    console.error(`[search] could not build ${manifest.slug}'s context:`, err);
    return { manifest, ctx: null, closed: UNAVAILABLE };
  }
}

/**
 * One page of one object: `limit` hits from `offset`, and whether there are
 * more. Asks the handler for one more than it shows, which is how it knows.
 */
export async function searchObjectPage(
  session: AppSearchSession,
  object: SearchObjectDefinition,
  query: string,
  offset: number,
  limit: number,
): Promise<ObjectPage> {
  if (!session.ctx) return { ok: false, error: session.closed ?? UNAVAILABLE };
  const { slug } = session.manifest;
  const where = `${slug}/search/${object.name}`;

  const handler = await loadSearchHandler(slug, object.name);
  if (!handler) return { ok: false, error: UNAVAILABLE };

  const input: SearchInput = {
    query,
    fields: object.fields.map((f) => f.key),
    offset,
    limit: limit + 1,
  };

  let raw: unknown;
  try {
    raw = await withTimeout(Promise.resolve(handler(session.ctx, input)), SEARCH_TIMEOUT_MS, where);
  } catch (err) {
    console.error(
      `[search] ${where} failed:`,
      refusalMessage(err) ?? safeErrorMessage(err, "the handler threw"),
      err,
    );
    return { ok: false, error: UNAVAILABLE };
  }

  const list = ResultsSchema.safeParse(raw);
  if (!list.success) {
    console.error(`[search] ${where} returned ${describe(raw)}, not an array of results.`);
    return { ok: false, error: UNAVAILABLE };
  }

  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const item of list.data.slice(0, limit + 1)) {
    const parsed = ResultSchema.safeParse(item);
    if (!parsed.success || !parsed.data.title) {
      dropped++;
      continue;
    }
    const result: SearchResult = {
      id: parsed.data.id,
      title: parsed.data.title,
      ...(parsed.data.params ? { params: parsed.data.params } : {}),
    };
    if (seen.has(result.id)) continue;
    const href = fillSearchLink(slug, object.link, result);
    if (!href) {
      dropped++;
      continue;
    }
    seen.add(result.id);
    hits.push({ id: result.id, title: result.title, subtitle: parsed.data.subtitle, href });
  }
  if (dropped > 0) {
    console.error(
      `[search] ${where} returned ${dropped} result(s) without a usable id, title or link parameter; they were left out.`,
    );
  }

  return { ok: true, hits: hits.slice(0, limit), hasMore: list.data.length > limit };
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : typeof value;
}

function withTimeout<T>(p: Promise<T>, ms: number, where: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${where} took longer than ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
