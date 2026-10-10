/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Is this instance behind its database? The answer `src/proxy.ts` acts on, on
 * every request it sees.
 *
 * It combines the two checks the readiness probe runs (`./schema-version.ts`):
 *
 *   - `platformBehind`: the platform schema is provably behind this build.
 *     While it is, the proxy answers everything but the health probes with the
 *     maintenance response (`./maintenance-gate.ts`).
 *   - `appsBehind`: the apps with a migration this build carries that the
 *     database hasn't applied. The proxy doesn't act on it, and readiness
 *     reports it.
 *
 * "Can't tell" (the database unreachable, a query failing, no answer in time)
 * counts as not behind, as it does in readiness.
 *
 * ── WHY PER REQUEST, AND NOT AT BOOT ────────────────────────────────────────
 *
 * `register()` in `src/instrumentation.ts` runs once before requests are
 * served, but it also runs inside `next build`, where there is no database
 * (see `./schema-version.ts`). The proxy runs only for requests, and in this
 * version of Next only on the Node.js runtime, so it can use the shared pool.
 * The answer is kept for 15 seconds, so that is one read per 15 seconds per
 * server, not one per request.
 */

import { cachedMaintenanceState, maintenanceStateOf, type MaintenanceState } from "./maintenance-gate";
import { appMigrationStatus, schemaVersionStatus } from "./schema-version";

export type { MaintenanceState };

const cached = cachedMaintenanceState(async () => {
  const [schema, apps] = await Promise.all([schemaVersionStatus(), appMigrationStatus()]);
  // Once per refresh, not per request. The message names both versions and
  // the release step; the response only says the instance is being updated.
  if (!schema.ok) console.error(`Serving the maintenance page: ${schema.message}`);
  return maintenanceStateOf(schema, apps);
});

/** Cached for 15 seconds. */
export function maintenanceState(): Promise<MaintenanceState> {
  return cached();
}
