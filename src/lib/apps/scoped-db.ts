/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createServiceClient } from "@/lib/db/server";

/**
 * Per-app database handle. Every table name an app asks for is rewritten to
 * `_app_<slug>_<name>`, which is the entire basis of app data isolation: an app
 * cannot name another app's table, and cannot name a platform table either.
 * The prefix is applied here and nowhere else — see docs/apps/database.md and
 * the matching rewrite in scripts/migrate.ts.
 */
export function tablePrefix(appSlug: string): string {
  return `_app_${appSlug.replace(/-/g, "_")}_`;
}

export function createScopedClient(appSlug: string) {
  const db = createServiceClient();
  const prefix = tablePrefix(appSlug);
  return {
    // The builder refuses any name that is not a plain identifier, so `name`
    // cannot carry a quote, a dot or a schema out of the prefix.
    table: (name: string) => db.from(`${prefix}${name}`),
  };
}

/** The full read/write handle apps receive as `context.db`. */
export type ScopedClient = ReturnType<typeof createScopedClient>;
type QueryBuilder = ReturnType<ScopedClient["table"]>;

/**
 * The subset of the query builder a read-only caller may use. The mutating
 * verbs are absent from the type, so `ctx.db.table("x").insert(...)` is a
 * compile error.
 */
export type ReadOnlyChain = Omit<
  QueryBuilder,
  "insert" | "update" | "upsert" | "delete"
>;

export interface ReadOnlyScopedClient {
  table: (name: string) => ReadOnlyChain;
}

/** Builder methods that write. Removed from the type *and* trapped at runtime. */
const MUTATING_METHODS = new Set(["insert", "update", "upsert", "delete"]);

/**
 * A scoped DB client that can only read. Used by MCP tool handlers, which are
 * read-only by contract (see docs/apps/mcp.md).
 *
 * The type alone would satisfy an honest caller; the Proxy is here for the
 * dishonest one. `ctx.db as any` is a one-token bypass of the compiler, and the
 * blast radius — a model-driven caller writing to an app's tables — is bad
 * enough to warrant the runtime trap as well. Throwing (rather than silently
 * no-op'ing) keeps the failure loud and attributable in logs.
 */
export function createReadOnlyScopedClient(appSlug: string): ReadOnlyScopedClient {
  const scoped = createScopedClient(appSlug);

  const guard = <T extends object>(builder: T, name: string): T =>
    new Proxy(builder, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && MUTATING_METHODS.has(prop)) {
          throw new Error(
            `MCP tools are read-only: "${prop}()" is not available on context.db (app "${appSlug}", table "${name}").`,
          );
        }
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;

        return (...args: unknown[]) => {
          const result = (value as (...a: unknown[]) => unknown).apply(target, args);
          // The builders are not uniform: filter methods mutate and return
          // `this`, while the table's `.select()` hands back a NEW builder.
          // Re-wrap either kind so the trap survives every hop of the chain —
          // returning the raw result on the first `.select()` would drop it.
          // `.then()` and friends return promises, which must pass through
          // untouched or awaiting the query would hang.
          if (result === target) return receiver;
          if (result && typeof result === "object" && !(result instanceof Promise)) {
            return guard(result as object, name);
          }
          return result;
        };
      },
    });

  return {
    table: (name: string) =>
      guard(scoped.table(name) as object, name) as ReadOnlyChain,
  };
}
