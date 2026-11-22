/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The key an app handler's loader is filed under, for an MCP tool, a search
 * handler, a sync, a job or a service.
 *
 * One rule for the registry generator, which writes the five generated maps
 * (scripts/handler-loaders.ts), and for the callers that read them. Two copies
 * would drift, and a key the runtime spells differently from the generator is
 * a handler that never loads with its loader sitting right there.
 *
 * Nothing here imports the generated files, so the generator can import it
 * before they exist. Routes have their own rule, in ./route-modules.ts, since
 * their path is a directory and not a name.
 */

/** The directory under `apps/<slug>/` each kind of handler lives in. */
export type HandlerKind = "mcp" | "search" | "sync" | "jobs" | "services";

/**
 * `<slug>/<kind>/<name>`: the import specifier less its `@apps/`, so a log line
 * naming the key names the file. No extension: `.ts` and `.tsx` both resolve.
 */
export function handlerLoaderKey(appSlug: string, kind: HandlerKind, name: string): string {
  return `${appSlug}/${kind}/${name}`;
}
