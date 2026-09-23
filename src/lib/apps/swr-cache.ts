/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Stale-while-revalidate cache for connector-heavy read payloads.
 *
 * Serves the last cached payload instantly, refreshes in the background once it
 * passes the soft TTL, and rebuilds synchronously only when there is no cache or
 * it is past the hard TTL. Callers pass `refresh: true` (wire it to `?refresh=1`)
 * to force a rebuild.
 *
 * WHY IT LIVES IN src/. It was written twice — once as a per-entity table,
 * rewritten as a keyed one, then copied verbatim into a third app because
 * invariant 18 forbids importing another app's modules. `docs/apps/data-freshness.md` told you to "copy it rather than
 * reinventing it" while also listing "copying a cache helper and letting it
 * drift" among its anti-patterns. Both copies carried a comment asking for this
 * promotion. Two copies of coalescing-and-generation logic is the kind of thing
 * that is correct on the day it is copied and subtly wrong a quarter later.
 *
 * WHAT MADE IT SHAREABLE. The two copies differed in exactly two ways: their
 * TTLs, and the `globalThis` key holding their process-local maps. Both are now
 * constructor arguments, which is why this is a factory and not a set of loose
 * functions — see the note on `namespace` below.
 *
 * The cache rows live in the caller's **tenant-scoped DB**, so they are inherently
 * tenant-isolated. Two process-local guards (held on `globalThis`, so they survive
 * dev hot-reload, and safe because one process serves one DB/tenant — see
 * `src/lib/db/client.ts`, which builds a single pool with no tenant parameter):
 *
 *  - `inflight` coalesces concurrent builds of the same key, so a cold page load
 *    (the page plus several widgets mounting at once) drives ONE connector build
 *    rather than N. Measured on a real page: four concurrent callers, one build.
 *  - `generations` is a per-key counter bumped on invalidation, so a build that
 *    started before a write cannot resurrect the pre-write payload — it skips its
 *    cache write when the key was invalidated mid-build.
 *
 * Caching here is a database layer, not an HTTP one. Don't reach for
 * `Cache-Control` or `revalidate` on an app route.
 *
 * SETUP. The app needs a `swr_cache` table (bare name; the platform prefixes it):
 *
 * ```sql
 * create table if not exists swr_cache (
 *   cache_key  text primary key,
 *   payload    jsonb not null,
 *   fetched_at timestamptz not null default now()
 * );
 * ```
 *
 * See docs/apps/data-freshness.md.
 */
import type { ScopedClient } from "@/lib/hooks/types";
import type { ReadOnlyScopedClient } from "@/lib/apps/scoped-db";

type Build<T> = () => Promise<T>;

export interface SwrCacheOptions {
  /**
   * A stable name for the owning app, e.g. its slug.
   *
   * This is NOT cosmetic and NOT the DB scope — the DB scope comes from the
   * `db` the caller passes. It namespaces the two process-local maps. Without
   * it, two apps that both cache under `"metrics:current"` would share one
   * `inflight` slot: app A's caller would be handed app B's build, and app B's
   * invalidation would silently cancel app A's cache write. Both symptoms are
   * intermittent and load-dependent, which is the worst kind.
   */
  namespace: string;
  /**
   * Whether entries belong to ONE PERSON or to the whole deployment. Required —
   * there is no default, because the safe answer depends on what is being cached
   * and a wrong guess is a cross-user data leak.
   *
   *  · `false` — the payload is the same for everyone. A tenant connector returns
   *    the same response regardless of who asked, so one entry serves all.
   *  · `true`  — the payload is one person's. Every call must then pass a
   *    `userId`, which is folded into both the stored key and the in-process
   *    coalescing key. Omitting it throws rather than caching.
   *
   * WHY THIS IS NOT OPTIONAL. `userScoped` connectors mean a connector can answer
   * differently per user. A cache keyed only on `"inbox"` would then serve the
   * first caller's mail to everyone. The in-flight map is the sharper edge of the
   * same problem: without the user in the key, a concurrent caller is handed
   * someone else's build directly, with no database row involved. Making this a
   * required field means the decision is made, in writing, at every call site.
   */
  userScoped: boolean;
  /** Younger than this → serve as-is, no refresh. Default 2 minutes. */
  softTtlMs?: number;
  /** Older than this → rebuild synchronously rather than serve stale. Default 1 hour. */
  hardTtlMs?: number;
  /** Cache table name, bare. Default `swr_cache`. */
  table?: string;
}

export interface SwrCache {
  /**
   * The payload for `key`, served from cache when possible.
   *
   * - `refresh: true` → always rebuild and cache.
   * - younger than the soft TTL → served as-is.
   * - between the soft and hard TTL → served stale, refreshed in the background.
   * - cold, or past the hard TTL → built synchronously (coalesced) and cached.
   *
   * `cached` tells the caller which of those happened. With `db: null` it simply
   * builds, so a route can run before the app's migration has been applied.
   */
  getCached<T>(
    db: ScopedClient | null,
    key: string,
    build: Build<T>,
    opts?: { refresh?: boolean; userId?: string },
  ): Promise<{ payload: T; cached: boolean }>;

  /**
   * A cached payload and its age, WITHOUT building or writing anything. Returns
   * null on a miss.
   *
   * This is what read-only callers need — MCP tool handlers, whose `ctx.db`
   * rejects writes and which must not kick off a multi-minute connector rebuild
   * as a side effect of a model asking a question. `getCached` cannot serve them:
   * on a cold or stale key it builds and persists, which is precisely what a
   * read-only caller must not do.
   *
   * The caller decides what an age means. An hour-old renewal book is fine to
   * quote if you say so it's an hour old; a ten-day-old one is not.
   */
  peekCached<T>(
    db: ReadOnlyScopedClient | null,
    key: string,
    opts?: { userId?: string },
  ): Promise<{ payload: T; ageMs: number } | null>;

  /**
   * Drop one entry (exact key) and invalidate any in-flight build for it, so a
   * concurrent stale rebuild can't re-insert the pre-delete payload. For
   * write-path and post-job invalidation. Best-effort.
   */
  deleteCached(
    db: ScopedClient | null,
    key: string,
    opts?: { userId?: string },
  ): Promise<void>;
}

/** An in-flight build plus the invalidation generation it started at, so a caller
 *  only joins it while it is still current. */
interface InflightBuild {
  promise: Promise<unknown>;
  gen: number;
}

interface SwrGlobals {
  /** `<namespace>\0<cache_key>` → the build currently in flight (coalesces stampedes). */
  inflight: Map<string, InflightBuild>;
  /** Same key → invalidation generation; bumped by deleteCached / refresh. */
  generations: Map<string, number>;
}

const g: SwrGlobals = ((
  globalThis as unknown as { __rosSwrCache?: SwrGlobals }
).__rosSwrCache ??= { inflight: new Map(), generations: new Map() });

export function createSwrCache(options: SwrCacheOptions): SwrCache {
  const {
    namespace,
    userScoped,
    softTtlMs = 2 * 60 * 1000,
    hardTtlMs = 60 * 60 * 1000,
    table = "swr_cache",
  } = options;

  /**
   * Fold the caller into the key when this cache holds per-person data.
   *
   * Applied ONCE at the edge of each public method, so the derived key is what
   * reaches the database row, the in-flight map and the generation counter
   * alike. Deriving it in one place is deliberate: the in-flight map is the
   * easiest of the three to forget, and the one where a miss hands another
   * user's payload over directly rather than through a row someone might notice.
   *
   * Throws on a missing `userId` rather than silently caching globally. A loud
   * failure in development is the whole point — the quiet version of this bug is
   * one person's mail rendered on another person's dashboard.
   */
  const storageKey = (key: string, userId?: string): string => {
    if (!userScoped) return key;
    if (!userId) {
      throw new Error(
        `swr-cache "${namespace}": this cache is userScoped, so every call must ` +
          `pass a userId (e.g. { userId: context.user.id }). Caching per-user ` +
          `data under a shared key would serve one person's data to another.`,
      );
    }
    return `u\0${userId}\0${key}`;
  };

  // A NUL separator can't appear in a namespace or a cache key, so no pair of
  // (namespace, key) can collide with another by concatenation.
  const scoped = (key: string) => `${namespace}\0${key}`;

  const generationOf = (key: string): number =>
    g.generations.get(scoped(key)) ?? 0;
  const bumpGeneration = (key: string): void => {
    g.generations.set(scoped(key), generationOf(key) + 1);
  };

  async function readCache<T>(
    db: ReadOnlyScopedClient,
    key: string,
  ): Promise<{ payload: T; ageMs: number } | null> {
    try {
      const { data, error } = await db
        .table(table)
        .select("payload, fetched_at")
        .eq("cache_key", key);
      if (error) return null;
      const row = (
        data as Array<{ payload?: T; fetched_at?: string | Date }> | null
      )?.[0];
      if (row?.payload == null) return null;
      const ms = row.fetched_at ? Date.parse(String(row.fetched_at)) : NaN;
      return {
        payload: row.payload,
        ageMs: Number.isFinite(ms) ? Date.now() - ms : Infinity,
      };
    } catch {
      return null;
    }
  }

  async function writeCache<T>(
    db: ScopedClient,
    key: string,
    payload: T,
  ): Promise<void> {
    // Best-effort — a failed cache write still returns fresh data to the caller.
    try {
      await db
        .table(table)
        .upsert(
          { cache_key: key, payload, fetched_at: new Date().toISOString() },
          { onConflict: "cache_key" },
        );
    } catch {
      /* ignore */
    }
  }

  /**
   * Run `build()` at most once per key across concurrent callers, and persist the
   * result only if the key wasn't invalidated while the build ran. Every coalesced
   * caller gets the built payload.
   */
  function coalescedBuild<T>(
    db: ScopedClient,
    key: string,
    build: Build<T>,
  ): Promise<T> {
    const gen = generationOf(key);

    // Join an in-flight build only if it started at the current generation. A
    // build begun before an invalidation read pre-invalidation data, so a caller
    // arriving after the invalidation must start its own rather than inherit it.
    const existing = g.inflight.get(scoped(key));
    if (existing && existing.gen === gen) return existing.promise as Promise<T>;

    const p = (async () => {
      const payload = await build();
      if (generationOf(key) === gen) await writeCache(db, key, payload);
      return payload;
    })();

    const entry: InflightBuild = { promise: p, gen };
    g.inflight.set(scoped(key), entry);
    // Free the slot once settled either way — but only if it is still THIS build;
    // a newer post-invalidation build may already have replaced it.
    const clear = () => {
      if (g.inflight.get(scoped(key)) === entry) g.inflight.delete(scoped(key));
    };
    void p.then(clear, clear);
    return p;
  }

  return {
    async getCached<T>(
      db: ScopedClient | null,
      rawKey: string,
      build: Build<T>,
      opts: { refresh?: boolean; userId?: string } = {},
    ): Promise<{ payload: T; cached: boolean }> {
      // Derived FIRST, and before the `!db` short-circuit: a userScoped cache
      // called without a userId is a programming error whether or not the app
      // has a database yet, and it should surface the same way in both cases.
      const key = storageKey(rawKey, opts.userId);
      if (!db) return { payload: await build(), cached: false };

      if (opts.refresh) {
        // Force a build reflecting any write that just happened, and make sure an
        // older in-flight build can't clobber it (bump before capturing gen).
        bumpGeneration(key);
        const gen = generationOf(key);
        const payload = await build();
        if (generationOf(key) === gen) await writeCache(db, key, payload);
        return { payload, cached: false };
      }

      const hit = await readCache<T>(db, key);
      if (hit && hit.ageMs < hardTtlMs) {
        if (hit.ageMs >= softTtlMs && !g.inflight.has(scoped(key))) {
          // Revalidate in the background (coalesced; result and errors ignored).
          void coalescedBuild<T>(db, key, build).catch(() => {});
        }
        return { payload: hit.payload, cached: true };
      }

      // Cold or past the hard TTL — build synchronously, coalescing concurrent
      // callers of the same key so a cold load doesn't stampede the connector.
      const payload = await coalescedBuild<T>(db, key, build);
      return { payload, cached: false };
    },

    async peekCached<T>(
      db: ReadOnlyScopedClient | null,
      rawKey: string,
      opts: { userId?: string } = {},
    ): Promise<{ payload: T; ageMs: number } | null> {
      const key = storageKey(rawKey, opts.userId);
      if (!db) return null;
      return readCache<T>(db, key);
    },

    async deleteCached(
      db: ScopedClient | null,
      rawKey: string,
      opts: { userId?: string } = {},
    ): Promise<void> {
      const key = storageKey(rawKey, opts.userId);
      bumpGeneration(key);
      if (!db) return;
      try {
        await db.table(table).delete().eq("cache_key", key);
      } catch {
        /* ignore */
      }
    },
  };
}
