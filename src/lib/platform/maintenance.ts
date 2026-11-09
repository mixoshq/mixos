/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Is this instance behind its database? The answer `src/proxy.ts` acts on, on
 * every request it sees, and the routes it leaves out ask for themselves: the
 * app API gateway (`src/lib/apps/dispatch.ts`) and the webhook route.
 *
 * It combines the two checks the readiness probe runs (`./schema-version.ts`):
 *
 *   - `platformBehind`: the platform schema is provably behind this build.
 *     While it is, everything but the health probes gets the maintenance
 *     response (`./maintenance-gate.ts`), and the sign-in page says sign-in
 *     is unavailable (`./sign-in-database.ts`).
 *   - `appsBehind`: the apps with a migration this build carries that the
 *     database hasn't applied. Each of them alone answers "This app is being
 *     updated": the app gate (`src/lib/apps/app-gate.ts`) holds back its code,
 *     and the proxy answers its pages. Readiness reports it too.
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

import {
  cachedMaintenanceState,
  maintenanceStateOf,
  type MaintenanceState,
  type MaintenanceStateStore,
} from "./maintenance-gate";
import { appMigrationStatus, schemaVersionStatus } from "./schema-version";

export type { MaintenanceState };

// On globalThis, as the checks' own caches are (`./schema-version.ts`). The
// proxy is bundled apart from the routes, each with its own copy of this
// module, and one kept answer per process means a page the proxy serves and
// its app's API never disagree about whether the app is being updated. Dev
// hot-reload keeps it too.
const globalForMaintenance = globalThis as unknown as {
  __maintenanceState?: MaintenanceStateStore;
};

const cached = cachedMaintenanceState(async () => {
  const [schema, apps] = await Promise.all([schemaVersionStatus(), appMigrationStatus()]);
  const state = maintenanceStateOf(schema, apps);
  // Once per refresh, not per request. The message names both versions, or
  // each pending app migration file, and the release step; the response only
  // says the instance, or the app, is being updated. While the whole instance
  // waits, its line is the one that applies.
  if (state.platformBehind) {
    console.error(`Serving the maintenance page: ${schema.message}`);
  } else if (state.appsBehind.size > 0) {
    console.error(`Serving "being updated" for ${[...state.appsBehind].join(", ")}: ${apps.message}`);
  }
  return state;
}, { store: (globalForMaintenance.__maintenanceState ??= {}) });

/** Cached for 15 seconds. */
export function maintenanceState(): Promise<MaintenanceState> {
  return cached();
}
