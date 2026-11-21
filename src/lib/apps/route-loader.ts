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
 * The three outcomes are kept apart because they are different faults. A
 * route with no loader is on disk but not in the registry this server was
 * built from, and `npm run registry` fixes it. A route whose loader throws is
 * code that failed at module scope, and the error is the thing to read.
 * Reporting the second as the first cost real debugging time once already.
 */

import { routeLoaders } from "@/generated/app-route-loaders";
import { routeLoaderKey } from "@/lib/apps/route-modules";

export type RouteModuleLoad =
  | { kind: "loaded"; key: string; module: Record<string, unknown> }
  | { kind: "missing"; key: string }
  | { kind: "failed"; key: string; error: unknown };

/**
 * `modulePath` is the on-disk path under `api/` (`index` for the root route).
 * The caller has already resolved the slug against the registry and the path
 * from a directory listing or the hoisted contract; the own-key lookup is a
 * second line, so no path can name a prototype property.
 */
export async function loadRouteModule(
  appSlug: string,
  modulePath: string,
): Promise<RouteModuleLoad> {
  const key = routeLoaderKey(appSlug, modulePath);
  if (!Object.hasOwn(routeLoaders, key)) return { kind: "missing", key };
  try {
    return { kind: "loaded", key, module: await routeLoaders[key]() };
  } catch (error) {
    return { kind: "failed", key, error };
  }
}
