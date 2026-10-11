/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { appRegistry } from "@/generated/app-registry";
import { maintenanceState } from "@/lib/platform/maintenance";
import type { AppPagePath, MaintenanceState } from "@/lib/platform/maintenance-gate";
import { isAppActive } from "./access";
import { publicPageAccess } from "./public-page";

/**
 * The app gate: may this app's code run now?
 *
 * Importing a module runs its top-level code, so a check made after the import
 * stops the handler but not the app. Everything that imports an app's server
 * code asks this first: the gateway (`dispatch.ts`), `callAppRoute()`
 * (`call.ts`), the scheduler's jobs and syncs (`scheduler.ts`), an App Services
 * provider (`services.ts`), the hooks loader (`src/lib/hooks/loader.ts`),
 * which also asks it each time a hook fires, both page routes before they load
 * a page, and the MCP server before it loads a tool. Pages and MCP tools check
 * the admin's switch first, through `hasAppGrant` and `isAppActive`, as they
 * always have.
 *
 * One function, so a reason to keep an app's code from running is added once
 * and holds everywhere. There are two, checked in this order:
 *
 *   - `inactive`: an admin switched the app off. Deactivating is the incident
 *     response, so it has to stop everything the app runs, not just its pages.
 *   - `updating`: the app's own migrations are behind this build
 *     (`maintenanceState().appsBehind`, the answer the proxy keeps for 15
 *     seconds). Its code was written for tables the database doesn't have
 *     yet, so none of it runs until the release step has applied them. Asked
 *     only of an active app, so a switched-off app answers as it always has,
 *     whatever its migrations say.
 *
 * A refusal names its reason, and each caller answers in its own terms. For
 * `inactive`: a 404 from the gateway, a job left unrun, `PROVIDER_INACTIVE` for
 * an App Services consumer. For `updating`: "This app is being updated. Try
 * again shortly." with a 503 and `Retry-After` from the gateway and the proxy,
 * an `UNAVAILABLE` `AppError`, a job left unrun and still due,
 * `PROVIDER_UPDATING`, and an MCP tool that refuses. A new reason is a new
 * member of `AppGateReason`, checked here, and each caller decides how to say
 * it.
 *
 * Fails closed on activation: `isAppActive` reads a failed lookup, a missing
 * row and an app this build doesn't carry as inactive. Not on the update: a
 * check that can't tell whether the migrations are behind counts as not
 * behind, as readiness does, so a database blip doesn't take an app's pages
 * down. Activation is not cached beyond the request, so a switch takes effect
 * on the next one. The update's answer is kept, so the app runs again within
 * 30 seconds of the release step, with no restart.
 */

/** Why an app's code may not run now. */
export type AppGateReason = "inactive" | "updating";

export type AppGate = { open: true } | { open: false; reason: AppGateReason };

const OPEN: AppGate = { open: true };

/** What the gate reads. Parameters, so the order can be tested without a database. */
export interface AppGateChecks {
  isAppActive: (slug: string) => Promise<boolean>;
  maintenanceState: () => Promise<MaintenanceState>;
}

export async function appGateOf(slug: string, checks: AppGateChecks): Promise<AppGate> {
  if (!(await checks.isAppActive(slug))) return { open: false, reason: "inactive" };
  if ((await checks.maintenanceState()).appsBehind.has(slug)) {
    return { open: false, reason: "updating" };
  }
  return OPEN;
}

export function checkAppGate(slug: string): Promise<AppGate> {
  return appGateOf(slug, { isAppActive, maintenanceState });
}

/**
 * Whether the gate holds this page back for an update: what the proxy asks
 * (`src/proxy.ts`), so it can answer with a 503 before the page renders. It
 * asks only for an app in `appsBehind`.
 *
 * A public page is answered as its route decides it (`./public-page.ts`): a
 * page the manifest doesn't open, or a switched-off app's, stays a 404. A
 * signed-in page is answered before the grant is checked, because the proxy
 * doesn't read the session, so anyone signed in who opens an active app's page
 * while it is being updated sees that it is.
 */
export async function isUpdatingAppPage({ surface, slug, pageKey }: AppPagePath): Promise<boolean> {
  if (surface === "p") {
    const access = await publicPageAccess(slug, pageKey, appRegistry, checkAppGate);
    return access.kind === "updating";
  }
  if (!appRegistry.find((a) => a.slug === slug)?.hasPages) return false;
  const gate = await checkAppGate(slug);
  return !gate.open && gate.reason === "updating";
}
