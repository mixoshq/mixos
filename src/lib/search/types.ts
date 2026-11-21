/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Global search's shapes and pure rules, shared by the server (./server.ts,
 * src/app/api/search/route.ts) and the browser (src/components/search/).
 * Nothing here reads the database.
 */

/**
 * The source key of the Apps group: open an app by its name. `@` because no
 * app slug can start with one, so it can sit in the same lists as slugs.
 */
export const APPS_SOURCE = "@apps";

/** The Apps group's one object, as `/api/search?source=@apps&object=` names it. */
export const APPS_OBJECT = "apps";

/** How many results each object shows first, and how many each Show more adds. */
export const FIRST_PAGE = 5;
export const MORE_PAGE = 10;

/** Below this, only the Apps group is searched: a one-letter query matches everything. */
export const MIN_OBJECT_QUERY = 2;
export const MAX_QUERY = 100;

/** The deepest Show more reaches. Each field is asked for offset + limit rows. */
export const MAX_OFFSET = 500;

export interface SearchPreferences {
  /** The search icon in the menu bar. */
  showIcon: boolean;
  /** ⌘K / Ctrl+K. */
  shortcutEnabled: boolean;
  /** Source keys, first searched first. Unlisted sources go after, in build order. */
  order: string[];
  /** Source keys switched off. */
  disabled: string[];
  /**
   * Objects switched off inside an app, as `objectKey(slug, name)`. Kept
   * apart from `disabled`, so switching an app off and on again leaves its
   * objects as the person set them.
   */
  disabledObjects: string[];
}

export const DEFAULT_SEARCH_PREFERENCES: SearchPreferences = {
  showIcon: true,
  shortcutEnabled: true,
  order: [],
  disabled: [],
  disabledObjects: [],
};

/**
 * The key one app's object is switched off by: `<slug>/<object>`. Neither an
 * app slug nor an object name can hold a `/`, so the pair splits one way.
 */
export function objectKey(source: string, object: string): string {
  return `${source}/${object}`;
}

/** With both ways in turned off, search is not available at all. */
export function searchAvailable(prefs: Pick<SearchPreferences, "showIcon" | "shortcutEnabled">): boolean {
  return prefs.showIcon || prefs.shortcutEnabled;
}

/**
 * `keys` in the person's order: those listed in `order` first, as listed, then
 * the rest in the order given. A key in `order` that isn't in `keys` (an app
 * since uninstalled) is skipped, and kept in the stored list in case it comes
 * back.
 */
export function orderSources<T extends string>(keys: readonly T[], order: readonly string[]): T[] {
  const present = new Set<string>(keys);
  const listed = order.filter((key, i) => present.has(key) && order.indexOf(key) === i) as T[];
  const inOrder = new Set<string>(listed);
  return [...listed, ...keys.filter((key) => !inOrder.has(key))];
}

/**
 * A new order for the stored list after the person rearranged `visible`: the
 * visible keys as arranged, then every stored key that isn't visible right now
 * (an app uninstalled, or switched off since), so a reorder never forgets them.
 */
export function mergeOrder(visible: readonly string[], stored: readonly string[]): string[] {
  const shown = new Set(visible);
  return [...visible, ...stored.filter((key) => !shown.has(key))];
}

/** One row in the modal. */
export interface SearchHit {
  /** Unique within its section. */
  id: string;
  title: string;
  subtitle: string | null;
  /** Where Enter goes: always a path under `/apps/<slug>`. */
  href: string;
  /** This row's own Lucide icon, when it differs from its section's: an app in the Apps group. */
  icon?: string;
}

/** One object's results inside an app's group: "Notes", "Candidates". */
export interface SearchSection {
  /** The object's name, for Show more. */
  object: string;
  label: string;
  /** The object's Lucide icon, for its heading and its rows. */
  icon: string;
  hits: SearchHit[];
  hasMore: boolean;
  /** The object could not be searched; its rows are absent. Never internals. */
  error: string | null;
}

/** One source's results: an app, or the Apps group. */
export interface SearchGroup {
  /** The source key: an app slug, or APPS_SOURCE. */
  source: string;
  name: string;
  icon: string;
  sections: SearchSection[];
}

/** `GET /api/search?q=`: every source's first page. */
export interface SearchResponse {
  query: string;
  groups: SearchGroup[];
}

/** `GET /api/search?q=&source=&object=&offset=`: the next page of one object. */
export interface SearchMoreResponse {
  hits: SearchHit[];
  hasMore: boolean;
  /** The page could not be fetched; the rows already shown stay. Never internals. */
  error: string | null;
}

/** A searchable source as the settings page lists it. */
export interface SearchSourceView {
  key: string;
  name: string;
  icon: string;
  /**
   * What the app searches: each object's name, label, icon and searchable
   * field keys, title first. Whether each is on is the person's live setting
   * (`SearchPreferences.disabledObjects`), never read from here.
   */
  objects: { name: string; label: string; icon: string; fields: string[] }[];
  /** A line in place of `objects`, for a source with none: the Apps group. */
  note: string | null;
  enabled: boolean;
}
