/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the readiness probe, `/api/health/ready`, answers: can this pod serve
 * traffic right now? Three questions, in order, because each is only
 * meaningful if the one before it passes:
 *
 *   1. Is the database reachable? Pings with a 2s cap. Unreachable returns 503
 *      so an external monitor removes this pod from the Service until it
 *      recovers — without restarting it.
 *   2. Does the database have the schema this build expects? A revision whose
 *      migrations have not been applied yet will start cleanly and then fail on
 *      whichever request first touches a missing column, so it must not be
 *      routed to. See ./schema-version.ts for why the check lives here rather
 *      than at boot, and ./maintenance.ts for what the proxy does meanwhile.
 *   3. Has it applied every app migration this build carries? The same failure,
 *      for an app's own tables: a release step whose app migrations failed
 *      leaves them missing. See ./app-migrations.ts.
 *
 * The probe is public, with no session and no rate limit, so the answer is
 * `status` and, when the database is behind, `reason`, and nothing else: no
 * schema version, no count, no file name. The server log names those, and the
 * step that fixes them.
 *
 * No imports from src/generated or the shared pool: the route hands in the
 * checks, so every branch can be tested without a database.
 */

import { withTimeout } from "@/lib/timeout";
import type { AppMigrationStatus } from "./app-migrations";
import type { SchemaVersionStatus } from "./schema-version";

export type ReadinessBody =
  | { status: "ok" }
  | { status: "unavailable"; reason?: "schema-behind" | "app-migrations-behind" };

export interface Readiness {
  httpStatus: 200 | 503;
  body: ReadinessBody;
}

export interface ReadinessChecks {
  /** Any query: it only has to come back. */
  ping: () => PromiseLike<unknown>;
  schema: () => Promise<SchemaVersionStatus>;
  apps: () => Promise<AppMigrationStatus>;
}

const PING_TIMEOUT_MS = 2000;

export async function readiness(
  checks: ReadinessChecks,
  {
    pingTimeoutMs = PING_TIMEOUT_MS,
    log = console.error,
  }: { pingTimeoutMs?: number; log?: (...args: unknown[]) => void } = {},
): Promise<Readiness> {
  try {
    await withTimeout(Promise.resolve(checks.ping()), pingTimeoutMs, () => new Error("db check timeout"));
  } catch (err) {
    log("readiness probe failed:", err);
    return { httpStatus: 503, body: { status: "unavailable" } };
  }

  // Cached for a few seconds inside the helper: the answer changes once per
  // deployment and this endpoint is polled continuously.
  const schema = await checks.schema();
  if (!schema.ok) {
    // Loud on every probe rather than once. This is the state where an operator
    // is looking for a reason a rollout is stuck, and the log is where they look.
    log(`readiness probe failed: ${schema.message}`);
    return { httpStatus: 503, body: { status: "unavailable", reason: "schema-behind" } };
  }

  const apps = await checks.apps();
  if (!apps.ok) {
    log(`readiness probe failed: ${apps.message}`);
    return { httpStatus: 503, body: { status: "unavailable", reason: "app-migrations-behind" } };
  }

  return { httpStatus: 200, body: { status: "ok" } };
}
