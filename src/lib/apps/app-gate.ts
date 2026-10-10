/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isAppActive } from "./access";

/**
 * The app gate: may this app's code run now?
 *
 * Importing a module runs its top-level code, so a check made after the import
 * stops the handler but not the app. Everything that imports an app's server
 * code asks this first: the gateway (`dispatch.ts`), `callAppRoute()`
 * (`call.ts`), the scheduler's jobs and syncs (`scheduler.ts`), an App Services
 * provider (`services.ts`) and the hooks loader (`src/lib/hooks/loader.ts`),
 * which also asks it each time a hook fires. Pages and MCP tools check the same
 * switch, through `hasAppGrant` and `isAppActive`, before they load.
 *
 * One function, so a reason to keep an app's code from running is added once
 * and holds everywhere. Today there is one: an admin switched the app off.
 * Deactivating is the incident response, so it has to stop everything the app
 * runs, not just its pages. A refusal names its reason, and each caller
 * answers in its own terms: a 404 from the gateway, a job left unrun, a
 * `ServiceRequestError` for the consumer. A new reason is a new member of
 * `AppGateReason`, checked here, and each caller decides how to say it.
 *
 * Fails closed: `isAppActive` reads a failed lookup, a missing row and an app
 * this build doesn't carry as inactive. Not cached beyond the request, so an
 * activation takes effect on the next one.
 */

/** Why an app's code may not run now. */
export type AppGateReason = "inactive";

export type AppGate = { open: true } | { open: false; reason: AppGateReason };

const OPEN: AppGate = { open: true };

export async function checkAppGate(slug: string): Promise<AppGate> {
  if (!(await isAppActive(slug))) return { open: false, reason: "inactive" };
  return OPEN;
}
