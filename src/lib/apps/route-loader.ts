/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Loading an app route's module, for the gateway (./dispatch.ts) and
 * `callAppRoute` (./call.ts).
 *
 * Through the generated map of explicit imports, never a template import:
 * Turbopack resolves a template import once, against the apps on disk when
 * the importing module compiled, so a route added under `next dev` stayed a
 * 404 until a restart (scripts/route-loaders.ts).
 *
 * The three outcomes, and why they are kept apart, are ./module-map.ts's: a
 * route with no loader wants `npm run registry`, and a route whose loader
 * throws is code that failed at module scope.
 */

import { routeLoaders } from "@/generated/app-route-loaders";
import { loadFromMap, type ModuleLoad } from "@/lib/apps/module-map";
import { routeLoaderKey } from "@/lib/apps/route-modules";

export type RouteModuleLoad = ModuleLoad;

/**
 * `modulePath` is the on-disk path under `api/` (`index` for the root route).
 * The caller has already resolved the slug against the registry and the path
 * from a directory listing or the hoisted contract; the own-key lookup is a
 * second line, so no path can name a prototype property.
 */
export function loadRouteModule(appSlug: string, modulePath: string): Promise<RouteModuleLoad> {
  return loadFromMap(routeLoaders, routeLoaderKey(appSlug, modulePath));
}
