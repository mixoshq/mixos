/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Loading an app module from one of the generated maps of explicit imports:
 * routes (./route-loader.ts), MCP tools, search handlers, syncs, jobs and
 * services.
 *
 * The maps exist because a template import, `import(\`@apps/${slug}/…\`)`, is
 * resolved by Turbopack against the files on disk, and is not always resolved
 * again when an app gains one under `next dev`: the gateway's wasn't, and a new
 * app's routes were a 404 until a restart (scripts/route-loaders.ts,
 * scripts/handler-loaders.ts). A generated file of literal imports is
 * rewritten by `npm run registry`, Next recompiles it, and the new module is in
 * the graph.
 *
 * The three outcomes are kept apart because they are different faults. A key
 * with no loader is on disk but not in the registry this server was built
 * from, and `npm run registry` fixes it. A loader that throws is code that
 * failed at module scope, and the error is the thing to read. Reporting the
 * second as the first cost real debugging time once already.
 *
 * Pure: the caller passes the map, so each caller's module graph holds only
 * its own kind of app code.
 */

export type ModuleLoaders = Record<string, () => Promise<Record<string, unknown>>>;

export type ModuleLoad =
  | { kind: "loaded"; key: string; module: Record<string, unknown> }
  | { kind: "missing"; key: string }
  | { kind: "failed"; key: string; error: unknown };

/**
 * Own keys only, so no key can reach a prototype property. Callers have already
 * resolved the slug against the registry and the name from the manifest; this
 * is a second line, not the first.
 */
export async function loadFromMap(loaders: ModuleLoaders, key: string): Promise<ModuleLoad> {
  if (!Object.hasOwn(loaders, key)) return { kind: "missing", key };
  try {
    return { kind: "loaded", key, module: await loaders[key]() };
  } catch (error) {
    return { kind: "failed", key, error };
  }
}
