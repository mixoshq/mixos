/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Can the sign-in page offer to sign anyone in? Every way in checks a user
 * against the database, so the page asks before it draws the form, and draws
 * "contact your administrator" instead while there is no database to check
 * against. Three ways there isn't, all with the same answer:
 *
 *   1. None is configured: no `DATABASE_URL`, and no `PG*` fields. The pool
 *      throws on its first query, before there is a promise to wait on.
 *   2. It can't be reached, or doesn't answer within 2s: readiness's budget
 *      for the same ping (`./readiness.ts`).
 *   3. It answers, but without the platform schema this build expects, a
 *      fresh database included (`./schema-version.ts`). The page asks
 *      `maintenanceState()`, which is what the proxy acts on, so the page
 *      and the sign-in it posts to agree on whether the instance is behind.
 *
 * No imports from src/generated or the shared pool, as in readiness: the page
 * hands in the checks, so every branch can be tested without a database.
 */

import { withTimeout } from "@/lib/timeout";

export interface SignInDatabaseChecks {
  /** Any query: it only has to come back. */
  ping: () => PromiseLike<unknown>;
  /** The platform schema is provably behind this build. */
  platformBehind: () => Promise<boolean>;
}

const PING_TIMEOUT_MS = 2000;

export async function databaseReadyForSignIn(
  checks: SignInDatabaseChecks,
  {
    pingTimeoutMs = PING_TIMEOUT_MS,
    log = console.error,
  }: { pingTimeoutMs?: number; log?: (...args: unknown[]) => void } = {},
): Promise<boolean> {
  try {
    // `then(ping)` rather than `ping()`, so a pool with no database configured,
    // which throws before it returns a promise, is caught like one that rejects.
    await withTimeout(
      Promise.resolve().then(checks.ping),
      pingTimeoutMs,
      () => new Error("db check timeout"),
    );
  } catch (err) {
    // On every load rather than once: whoever is asked to fix it looks here.
    log("sign-in unavailable, no database to check against:", err);
    return false;
  }

  // `maintenanceState()` logs the versions itself, once per refresh.
  return !(await checks.platformBehind());
}
