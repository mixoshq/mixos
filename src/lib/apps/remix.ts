/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Remix: a component of one installed app, rebuilt inside another
 * (docs/apps/remix.md, docs/plans/20261015_2343-remix.md).
 *
 * The remixing app records each remix in its `app.json`, under `remixedFrom`:
 * where it came from — the source app, the exact commit, its catalogue listing —
 * what was taken, and what the developer decided about each of its actions. The
 * schema for an entry is `RemixEntrySchema` in scripts/manifest-schemas.ts. This
 * module is everything else about entries that more than one place needs:
 *
 *   - anchors, the stable names a remix is counted against;
 *   - keyword normalization, the same on the instance and on mixos.org;
 *   - edit detection, for the pre-commit hook and Danger: an entry is a moment
 *     in time, written once and never changed.
 *
 * Pure, and with no import a script can't load: the registry generator, the
 * pre-commit check and Danger read it, as does the admin app dialog.
 */

import type { RemixEntry } from "../../../scripts/manifest-schemas";

/** One remix in this build, as src/generated/remix-index.ts lists it. */
export interface RemixIndexEntry {
  /** The app that took it: whose `app.json` records the entry. */
  app: string;
  entry: RemixEntry;
  /** The entry's keywords normalized, as mixos.org counts them. */
  keywords: string[];
}

/** The remixes an app took, newest first. */
export function remixesFrom(index: readonly RemixIndexEntry[], slug: string): RemixIndexEntry[] {
  return index.filter((r) => r.app === slug).sort(byNewest);
}

/**
 * The remixes taken from an app, newest first. Only those naming it as their
 * source: a remix of a remix is credited to the app it was taken from, not to
 * that app's own sources.
 */
export function remixesInto(index: readonly RemixIndexEntry[], slug: string): RemixIndexEntry[] {
  return index.filter((r) => r.entry.source.app === slug).sort(byNewest);
}

function byNewest(a: RemixIndexEntry, b: RemixIndexEntry): number {
  return b.entry.remixedAt.localeCompare(a.entry.remixedAt);
}

/* -------------------------------------------------------------------------- */
/*  Anchors                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What a remix is counted against: a part of the source app named by something
 * that is already stable in it. A rename splits the count; that is accepted
 * (decision 12 of the plan).
 *
 *   widget:<id>              the widget's id, its file name without extension
 *   page:<path>              the page's path inside the app, "/" for its root
 *   route:<METHOD> <path>    a declared route, as the typed client names it
 *   job:<name>               a scheduled job
 *
 * The first anchor of an entry is the component the developer pointed at, so it
 * is a widget or a page; the rest are what it drew on.
 */
export type RemixAnchor =
  | { kind: "widget"; id: string }
  | { kind: "page"; path: string }
  | { kind: "route"; method: string; path: string }
  | { kind: "job"; name: string };

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** "/", or "/" followed by segments of letters, digits, `-`, `_`, or a `[param]`. */
const APP_PATH = /^\/(?:(?:[a-z0-9][a-z0-9_-]*|\[[a-zA-Z][a-zA-Z0-9_]*\])(?:\/(?:[a-z0-9][a-z0-9_-]*|\[[a-zA-Z][a-zA-Z0-9_]*\]))*)?$/;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/** An anchor's parts, or null when it isn't one. */
export function parseAnchor(raw: string): RemixAnchor | null {
  const colon = raw.indexOf(":");
  if (colon < 1) return null;
  const kind = raw.slice(0, colon);
  const rest = raw.slice(colon + 1);
  switch (kind) {
    case "widget":
      return NAME.test(rest) ? { kind, id: rest } : null;
    case "job":
      return NAME.test(rest) ? { kind, name: rest } : null;
    case "page":
      return APP_PATH.test(rest) ? { kind, path: rest } : null;
    case "route": {
      const space = rest.indexOf(" ");
      if (space < 1) return null;
      const method = rest.slice(0, space);
      const path = rest.slice(space + 1);
      return METHODS.has(method) && APP_PATH.test(path) ? { kind, method, path } : null;
    }
    default:
      return null;
  }
}

/** How an anchor reads to a person: "the widget application-pipeline". */
export function describeAnchor(raw: string): string {
  const a = parseAnchor(raw);
  if (!a) return raw;
  switch (a.kind) {
    case "widget":
      return `widget ${a.id}`;
    case "page":
      return a.path === "/" ? "main page" : `page ${a.path}`;
    case "route":
      return `${a.method} ${a.path}`;
    case "job":
      return `job ${a.name}`;
  }
}

/* -------------------------------------------------------------------------- */
/*  Keywords                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Different words for one idea, mapped to one of them so counts add up across
 * apps. Extend it freely: mixos.org re-normalizes when it aggregates, so a
 * synonym added later merges counts recorded before it. mixos.org keeps a copy,
 * in its src/lib/registry/remix.ts; add a synonym there too.
 *
 * What it must never do is decide whether an entry is valid. The build checks a
 * keyword's shape only, because an entry can't be edited (decision 19): judging
 * old entries against a list that grows would fail an app's build with no way to
 * fix it. The list is applied once, when the remix is written (scripts/remix.ts).
 */
export const REMIX_KEYWORD_SYNONYMS: Readonly<Record<string, string>> = {
  dnd: "drag-and-drop",
  "drag-drop": "drag-and-drop",
  draggable: "drag-and-drop",
  "drag-n-drop": "drag-and-drop",
  "data-grid": "table",
  datagrid: "table",
  "data-table": "table",
  "kanban-board": "kanban",
  modal: "dialog",
  popup: "dialog",
  "pie-graph": "pie-chart",
  "bar-graph": "bar-chart",
  "line-graph": "line-chart",
  datepicker: "date-picker",
  "date-range-picker": "date-range",
  "inline-editing": "inline-edit",
  "edit-in-place": "inline-edit",
  "infinite-scrolling": "infinite-scroll",
  "empty-states": "empty-state",
  "csv-download": "csv-export",
  "export-csv": "csv-export",
  wizard: "stepper",
  "multi-step-form": "stepper",
  "toast-notification": "toast",
  "status-badge": "status-pill",
};

/**
 * Words that describe nothing, so a keyword list holding them says less than
 * it seems to. Applied at remix time, like the synonyms, never by the build.
 */
export const REMIX_KEYWORD_STOPWORDS: ReadonlySet<string> = new Set([
  "feature",
  "features",
  "component",
  "components",
  "page",
  "pages",
  "app",
  "apps",
  "ui",
  "data",
  "view",
  "views",
]);

/** The shape every recorded keyword has: what normalizeRemixKeyword returns. */
export const REMIX_KEYWORD_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const REMIX_KEYWORD_MAX_LENGTH = 40;
export const REMIX_KEYWORDS_MIN = 2;
export const REMIX_KEYWORDS_MAX = 5;

/**
 * One keyword in its recorded form, or null when nothing is left of it:
 *
 *   1. lowercase; spaces, underscores, slashes and dots become hyphens; other
 *      punctuation goes;
 *   2. a synonym becomes its canonical term;
 *   3. a word that describes nothing is dropped.
 *
 * No stemming: `status` must not become `statu`.
 */
export function normalizeRemixKeyword(raw: string): string | null {
  const shaped = raw
    .toLowerCase()
    .trim()
    .replace(/[\s_/.]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!shaped || shaped.length > REMIX_KEYWORD_MAX_LENGTH) return null;
  const canonical = REMIX_KEYWORD_SYNONYMS[shaped] ?? shaped;
  if (REMIX_KEYWORD_STOPWORDS.has(canonical)) return null;
  return canonical;
}

/** A keyword list normalized and deduplicated, in its first-seen order. */
export function normalizeRemixKeywords(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const k of raw) {
    const n = normalizeRemixKeyword(k);
    if (n !== null && !out.includes(n)) out.push(n);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Entries are written once                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What identifies an entry across two versions of `app.json`: the source app,
 * the component pointed at, and the day it was taken. Two entries with the same
 * identity and different contents are one remix that was edited.
 */
export function remixEntryIdentity(entry: unknown): string | null {
  if (!isRecord(entry) || !isRecord(entry.source)) return null;
  const { app, anchors } = entry.source;
  const first = Array.isArray(anchors) ? anchors[0] : undefined;
  if (typeof app !== "string" || typeof first !== "string" || typeof entry.remixedAt !== "string") {
    return null;
  }
  return `${app} ${first} ${entry.remixedAt}`;
}

/** `remixedFrom` from an `app.json`'s text; [] when the file or field is absent or unreadable. */
export function remixEntriesFromAppJson(text: string | null | undefined): unknown[] {
  if (!text) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) && Array.isArray(parsed.remixedFrom) ? parsed.remixedFrom : [];
  } catch {
    return [];
  }
}

/**
 * The entries that exist in both versions under the same identity but no longer
 * match: each one a remix whose record was changed. Adding an entry is a new
 * remix and deleting one says the remix is gone; neither is reported.
 *
 * Compared by content with keys in a fixed order, so reformatting `app.json`
 * changes nothing here.
 */
export function editedRemixEntries(before: readonly unknown[], after: readonly unknown[]): string[] {
  const now = new Map<string, string[]>();
  for (const entry of after) {
    const id = remixEntryIdentity(entry);
    if (id === null) continue;
    now.set(id, [...(now.get(id) ?? []), canonicalJson(entry)]);
  }
  const edited: string[] = [];
  for (const entry of before) {
    const id = remixEntryIdentity(entry);
    if (id === null) continue;
    const candidates = now.get(id);
    if (candidates && !candidates.includes(canonicalJson(entry))) edited.push(id);
  }
  return edited;
}

/** JSON with every object's keys sorted, so two equal values serialize equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* -------------------------------------------------------------------------- */
/*  Adapt or rebuild                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Licenses whose code a remix may adapt outright. MPL-2.0 is file-level
 * copyleft: a copied file stays MPL, which the copy's own notice says.
 */
const ADAPTABLE = new Set([
  "MIT",
  "MIT-0",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "CC0-1.0",
  "Unlicense",
  "Zlib",
  "BSL-1.0",
  "MPL-2.0",
]);

/** GPL, LGPL and AGPL: derivatives carry the same license, so only into an app that already does. */
const COPYLEFT = /^(?:A|L)?GPL-[0-9.]+(?:-only|-or-later|\+)?$/;

export interface LicenseVerdict {
  mode: "adapted" | "rebuilt";
  /** Why, in a sentence for the plan. */
  reason: string;
}

/**
 * Whether a remix may adapt the source's code, from the two apps' declared
 * licenses (decisions 3, 4 and 16 of the plan). Conservative where it can't
 * tell: an identifier it doesn't know, or an expression it can't read, means
 * rebuild.
 *
 * Reads `A OR B` (either will do), `A AND B` (both must), and drops a `WITH`
 * exception. Parentheses are not read.
 */
export function licenseVerdict(source: string | null | undefined, target: string | null | undefined): LicenseVerdict {
  if (!source) {
    return { mode: "rebuilt", reason: "The source app declares no license, so its code is all rights reserved." };
  }
  if (source === "UNLICENSED") {
    return { mode: "rebuilt", reason: "The source app is UNLICENSED: not redistributable." };
  }
  if (/[()]/.test(source)) {
    return { mode: "rebuilt", reason: `"${source}" is a license expression this check doesn't read, so it rebuilds to be safe.` };
  }
  const bare = (id: string) => id.replace(/\s+WITH\s+.+$/, "").trim();
  const targetId = target ? bare(target) : null;
  const allows = (id: string) => ADAPTABLE.has(id) || (COPYLEFT.test(id) && id === targetId);

  for (const alternative of source.split(/\s+OR\s+/)) {
    const ids = alternative.split(/\s+AND\s+/).map(bare);
    if (ids.every(allows)) {
      const copyleft = ids.find((id) => COPYLEFT.test(id));
      return {
        mode: "adapted",
        reason: copyleft
          ? `${alternative} permits derivatives under the same license, which the target app already declares.`
          : `${alternative} permits adapting the code, keeping its license notice.`,
      };
    }
  }
  const copyleft = source.split(/\s+(?:OR|AND)\s+/).map(bare).find((id) => COPYLEFT.test(id));
  return {
    mode: "rebuilt",
    reason: copyleft
      ? `${source} permits derivatives only under the same license, and the target app declares ${target ?? "none"}.`
      : `${source} isn't a license this check knows permits adapting, so it rebuilds to be safe.`,
  };
}
