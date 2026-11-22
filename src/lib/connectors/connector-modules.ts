/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The key a connector's loader is filed under in the generated map
 * (src/generated/connector-loaders.ts).
 *
 * One rule for the registry generator, which writes the map
 * (scripts/connector-loaders.ts), and for the loader that reads it
 * (./loader.ts). Two copies would drift, and a key the runtime spells
 * differently from the generator is a connector that never loads with its
 * loader sitting right there.
 *
 * Nothing here imports the generated files, so the generator can import it
 * before they exist.
 */

/**
 * `<name>/index`: the import specifier less its `@connectors/`, so a log line
 * naming the key names the file. No extension: `.ts` and `.tsx` both resolve.
 */
export function connectorLoaderKey(name: string): string {
  return `${name}/index`;
}

/** The files a connector's module may be, any one of which gets it a loader. */
export const CONNECTOR_INDEX_FILES = ["index.ts", "index.tsx"] as const;
