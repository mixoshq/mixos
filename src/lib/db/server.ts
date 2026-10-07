/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Canonical server-side data entry point.
//
// Two ways in, one connection pool:
//
//   createServiceClient()  — the query builder (src/lib/db/query.ts). Use this
//                            for essentially everything: it is the API apps
//                            see as `ctx.db.table(...)` and the platform's own
//                            reads and writes.
//
//   sql                    — the raw postgres.js pool, re-exported from
//                            ./client. Use ONLY where the builder cannot
//                            express the query: aggregate reporting
//                            (src/lib/analytics/queries.ts), the scheduler's
//                            atomic claim (src/lib/apps/scheduler.ts), the
//                            rate limiter's atomic token bucket
//                            (src/lib/rate-limit.ts), telemetry rollups, and
//                            calls to the schema's own functions. Apps must
//                            never reach for it (see apps/AGENTS.md invariant 18).
//
// Both run on the pool in ./client, configured from DATABASE_URL by
// ./pg-options. That is the only database setting there is: any Postgres 13 or
// later works, Supabase included.
//
// The client has full access to every table in `public`. It must never be
// constructed in code that reaches the browser — it lives behind server
// components, server actions and route handlers, and the ESLint rules in
// eslint.config.mjs keep app code from importing it at all.
import { sql } from "./client";
import { DbClient } from "./query";

let shared: DbClient | undefined;

/**
 * The platform's full-access query client. One shared instance: it holds
 * nothing but a reference to the pool, and the pool itself connects lazily, so
 * importing this costs nothing until a query runs — `next build` included.
 */
export function createServiceClient(): DbClient {
  shared ??= new DbClient(sql);
  return shared;
}

export { sql };
export { DbClient, DbError } from "./query";
export type { DbResponse, FilterQuery, Row, TableQuery } from "./query";
