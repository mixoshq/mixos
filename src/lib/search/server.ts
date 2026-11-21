/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Global search for one person: which sources they can search, in their
 * order, and the fan-out to each. Server only; the endpoint is
 * src/app/api/search/route.ts and the settings page reads `searchSourcesFor`.
 *
 * WHO CAN SEARCH WHAT. A source is an app the person installed and still holds
 * (`getUserApps`: active, and granted or global) that declares `search`, plus
 * the Apps group. The same set the menu bar's app list comes from, so search
 * can never reach an app the person couldn't open from the menu bar.
 */

import { appRegistry } from "@/generated/app-registry";
import { getUserApps, getUserById } from "@/lib/apps/access";
import { matchesQuery } from "@/lib/apps/search";
import type { AppManifest } from "@/lib/apps/types";
import { openAppForSearch, searchObjectPage, type ObjectPage } from "./broker";
import { getSearchPreferences } from "./preferences";
import {
  APPS_OBJECT,
  APPS_SOURCE,
  FIRST_PAGE,
  MIN_OBJECT_QUERY,
  orderSources,
  type SearchGroup,
  type SearchHit,
  type SearchMoreResponse,
  type SearchPreferences,
  type SearchResponse,
  type SearchSection,
  type SearchSourceView,
} from "./types";

const APPS_GROUP_NAME = "Apps";
const APPS_GROUP_ICON = "layout-grid";

interface Sources {
  prefs: SearchPreferences;
  /** Installed, held apps with pages: the Apps group's rows. */
  openable: AppManifest[];
  /** Installed, held apps that declare search. */
  searchable: AppManifest[];
  /** Every source key, in the person's order. */
  ordered: string[];
}

async function sourcesFor(userId: string): Promise<Sources> {
  const [prefs, installed] = await Promise.all([getSearchPreferences(userId), getUserApps(userId)]);
  const held = new Set(installed);
  // Registry order is the default order: stable, and the order the build lists apps.
  const apps = appRegistry.filter((a) => held.has(a.slug));
  const openable = apps.filter((a) => a.hasPages && a.pageCount > 0);
  const searchable = apps.filter((a) => a.search.length > 0);
  const ordered = orderSources([APPS_SOURCE, ...searchable.map((a) => a.slug)], prefs.order);
  return { prefs, openable, searchable, ordered };
}

/** The settings page's list: every source the person can search, in their order. */
export async function searchSourcesFor(
  userId: string,
): Promise<{ prefs: SearchPreferences; sources: SearchSourceView[] }> {
  const { prefs, searchable, ordered } = await sourcesFor(userId);
  const disabled = new Set(prefs.disabled);
  const bySlug = new Map(searchable.map((a) => [a.slug, a]));
  const sources = ordered.map((key): SearchSourceView => {
    if (key === APPS_SOURCE) {
      return {
        key,
        name: APPS_GROUP_NAME,
        icon: APPS_GROUP_ICON,
        objects: ["Open an app by its name"],
        enabled: !disabled.has(key),
      };
    }
    const app = bySlug.get(key)!;
    return {
      key,
      name: app.name,
      icon: app.icon,
      objects: app.search.map((o) => o.label),
      enabled: !disabled.has(key),
    };
  });
  return { prefs, sources };
}

/** The installed apps whose name contains the query, starts-with first, then by name. */
function appHits(openable: AppManifest[], query: string): SearchHit[] {
  const q = query.toLocaleLowerCase();
  return openable
    .filter((a) => matchesQuery(a.name, query))
    .sort((a, b) => {
      const pa = a.name.toLocaleLowerCase().startsWith(q) ? 0 : 1;
      const pb = b.name.toLocaleLowerCase().startsWith(q) ? 0 : 1;
      return pa - pb || a.name.localeCompare(b.name);
    })
    .map((a) => ({
      id: a.slug,
      title: a.name,
      subtitle: a.tagline ?? (a.description || null),
      href: `/apps/${encodeURIComponent(a.slug)}`,
      icon: a.icon,
    }));
}

function section(
  object: string,
  label: string,
  icon: string,
  page: ObjectPage,
): SearchSection {
  return page.ok
    ? { object, label, icon, hits: page.hits, hasMore: page.hasMore, error: null }
    : { object, label, icon, hits: [], hasMore: false, error: page.error };
}

/** Thrown when the person has search off, or no longer exists. The route answers 403. */
export class SearchUnavailableError extends Error {
  constructor() {
    super("Search is turned off.");
    this.name = "SearchUnavailableError";
  }
}

async function searchingUser(userId: string) {
  const dbUser = await getUserById(userId);
  if (!dbUser) throw new SearchUnavailableError();
  return dbUser;
}

/**
 * Every source's first page for `query`, in the person's order, sources
 * switched off left out. A group with no hits and no error is left out too, so
 * the modal lists only what matched. Below MIN_OBJECT_QUERY characters only
 * the Apps group is searched.
 */
export async function globalSearch(userId: string, query: string): Promise<SearchResponse> {
  const { prefs, openable, searchable, ordered } = await sourcesFor(userId);
  if (!prefs.showIcon && !prefs.shortcutEnabled) throw new SearchUnavailableError();
  const dbUser = await searchingUser(userId);
  const disabled = new Set(prefs.disabled);
  const bySlug = new Map(searchable.map((a) => [a.slug, a]));

  const groups = await Promise.all(
    ordered
      .filter((key) => !disabled.has(key))
      .map(async (key): Promise<SearchGroup | null> => {
        if (key === APPS_SOURCE) {
          const hits = appHits(openable, query);
          if (hits.length === 0) return null;
          return {
            source: APPS_SOURCE,
            name: APPS_GROUP_NAME,
            icon: APPS_GROUP_ICON,
            sections: [
              {
                object: APPS_OBJECT,
                label: APPS_GROUP_NAME,
                icon: APPS_GROUP_ICON,
                hits: hits.slice(0, FIRST_PAGE),
                hasMore: hits.length > FIRST_PAGE,
                error: null,
              },
            ],
          };
        }
        if (query.length < MIN_OBJECT_QUERY) return null;
        const app = bySlug.get(key)!;
        const session = await openAppForSearch(app, dbUser);
        const sections = await Promise.all(
          app.search.map(async (o) =>
            section(o.name, o.label, o.icon ?? app.icon, await searchObjectPage(session, o, query, 0, FIRST_PAGE)),
          ),
        );
        const shown = sections.filter((s) => s.hits.length > 0 || s.error !== null);
        if (shown.length === 0) return null;
        return { source: app.slug, name: app.name, icon: app.icon, sections: shown };
      }),
  );

  return { query, groups: groups.filter((g): g is SearchGroup => g !== null) };
}

/**
 * The next page of one source's object. Answers nothing (an empty page) for a
 * source or object the person can't search, the same as one with no more
 * matches: whether an app the person doesn't hold declares an object is not
 * theirs to learn.
 */
export async function searchMore(
  userId: string,
  query: string,
  source: string,
  object: string,
  offset: number,
  limit: number,
): Promise<SearchMoreResponse> {
  const { prefs, openable, searchable } = await sourcesFor(userId);
  if (!prefs.showIcon && !prefs.shortcutEnabled) throw new SearchUnavailableError();
  const none: SearchMoreResponse = { hits: [], hasMore: false, error: null };
  if (prefs.disabled.includes(source)) return none;

  if (source === APPS_SOURCE) {
    if (object !== APPS_OBJECT) return none;
    const hits = appHits(openable, query);
    return { hits: hits.slice(offset, offset + limit), hasMore: hits.length > offset + limit, error: null };
  }

  if (query.length < MIN_OBJECT_QUERY) return none;
  const app = searchable.find((a) => a.slug === source);
  const declared = app?.search.find((o) => o.name === object);
  if (!app || !declared) return none;

  const dbUser = await searchingUser(userId);
  const session = await openAppForSearch(app, dbUser);
  const page = await searchObjectPage(session, declared, query, offset, limit);
  return page.ok
    ? { hits: page.hits, hasMore: page.hasMore, error: null }
    : { hits: [], hasMore: false, error: page.error };
}
