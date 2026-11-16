/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where an app route's module is, and the key its loader is filed under.
 *
 * One rule for the registry generator, which writes
 * src/generated/app-route-loaders.ts, and for the runtime that reads it
 * (./route-loader.ts). Two copies of it would drift, and a key the runtime
 * spells differently from the generator is a route that 404s with its loader
 * sitting right there.
 *
 * Nothing here imports the generated files, so the generator can import it
 * before they exist.
 */

/**
 * A route's on-disk path under `api/`, from its declaration key: the root route
 * is declared as `""` and lives at `api/index/route.ts`. Dynamic segments stay
 * as they are on disk (`items/[id]`).
 */
export function routeModulePath(routePath: string): string {
  return routePath === "" ? "index" : routePath;
}

/**
 * `<slug>/api/<modulePath>/route`: the import specifier less its `@apps/`, so a
 * log line naming the key names the file.
 */
export function routeLoaderKey(appSlug: string, modulePath: string): string {
  return `${appSlug}/api/${modulePath}/route`;
}
