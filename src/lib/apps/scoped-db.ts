/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createServiceClient } from "@/lib/db/server";
import { appSchemaName } from "./app-identifiers";
import { ReadOnlyError } from "./read-only";

/**
 * Per-app database handle: the query builder, pinned to the app's own schema,
 * `app_<slug>` (./app-identifiers.ts). `context.db.table("orders")` is
 * `app_<slug>.orders`, the table the app's migration created as `orders`. An app
 * cannot name another app's table, or a platform table, through it.
 *
 * It connects as the platform's role, like every other query, and reaches the
 * app's tables because that role is a member of the app's. What app SQL could
 * leave behind for that role to run is bounded when the migration is checked
 * (scripts/app-sql-policy.ts). See docs/apps/database.md.
 */
export function createScopedClient(appSlug: string) {
  const db = createServiceClient().schema(appSchemaName(appSlug));
  return {
    // The builder refuses any name that is not a plain identifier, so `name`
    // cannot carry a quote, a dot or another schema out of this one.
    table: (name: string) => db.from(name),
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
 * read-only by contract (see docs/apps/mcp.md), and by an App Services provider
 * answering a request from one.
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
          throw new ReadOnlyError(
            `MCP tools and search handlers are read-only: "${prop}()" is not available on context.db (app "${appSlug}", table "${name}").`,
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
