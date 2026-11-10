/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `$schema` URL of each JSON file an extension carries.
 *
 * Every one of them says which shape it is, as a URL naming a JSON Schema that
 * mixos.org publishes: `"$schema": "https://mixos.org/schemas/app/v1.json"`.
 * Each file has its own version, so a new shape of one doesn't move the others.
 * Editors that read `$schema` complete and check the file as it is typed.
 *
 * The schemas themselves are generated from the Zod schemas MixOS validates
 * with (scripts/json-schemas.ts) into docs/schemas/, and mixos.org copies them
 * from there. See docs/plans/20261110_0018-slug-ids.md.
 *
 * Pure, with no imports: the generator, the release step and the site can all
 * load it.
 */

/** Where the schemas are published. */
export const SCHEMA_BASE = "https://mixos.org/schemas";

/** Each schema, the file it describes, and the version of it this MixOS writes. */
export const SCHEMA_FILES = {
  app: { describes: "app.json", version: 1 },
  connector: { describes: "connector.json", version: 1 },
  theme: { describes: "theme.json", version: 1 },
  "release-notes": { describes: "release-notes.json", version: 1 },
  "registry-install": { describes: ".registry.json", version: 1 },
} as const satisfies Record<string, { describes: string; version: number }>;

export type SchemaFile = keyof typeof SCHEMA_FILES;

export const SCHEMA_FILE_NAMES = Object.keys(SCHEMA_FILES) as SchemaFile[];

/** The URL of `file`'s schema at `version`, the current one by default. */
export function schemaUrl(file: SchemaFile, version: number = SCHEMA_FILES[file].version): string {
  return `${SCHEMA_BASE}/${file}/v${version}.json`;
}

/** The schema and version a URL names, or null when it isn't one of MixOS's. */
export function parseSchemaUrl(url: string): { file: SchemaFile; version: number } | null {
  const prefix = `${SCHEMA_BASE}/`;
  if (!url.startsWith(prefix)) return null;
  const m = /^([a-z-]+)\/v([1-9][0-9]*)\.json$/.exec(url.slice(prefix.length));
  if (!m || !Object.hasOwn(SCHEMA_FILES, m[1])) return null;
  return { file: m[1] as SchemaFile, version: Number(m[2]) };
}

/**
 * Why `value`, the `$schema` of the file `where` names, isn't the schema this
 * MixOS reads `file` with, or null when it is.
 *
 * A file is read at exactly one version: the one this MixOS writes. A newer one
 * is for a newer MixOS, and an older one is a shape this MixOS no longer reads.
 * Each is refused with what to do, before the file's fields are looked at, so
 * the reader hears about its shape rather than a list of fields that don't fit
 * it.
 */
export function schemaProblem(file: SchemaFile, value: unknown, where: string): string | null {
  const url = schemaUrl(file);
  const add = `Add "$schema": "${url}" as its first key.`;
  if (value === undefined) {
    return `${where} has no "$schema", which says which shape it is and so which MixOS reads it. ${add}`;
  }
  if (typeof value !== "string") return `${where}: "$schema" is a URL, as a string. ${add}`;
  if (value === url) return null;

  const named = parseSchemaUrl(value);
  if (!named) return `${where}: "$schema" is "${value}", which isn't one of MixOS's schemas. Use "${url}".`;
  const { describes, version } = SCHEMA_FILES[file];
  if (named.file !== file) {
    return `${where}: "$schema" is the schema of ${SCHEMA_FILES[named.file].describes}, not of ${describes}. Use "${url}".`;
  }
  return named.version > version
    ? `${where} is version ${named.version} of ${describes}, and this MixOS reads version ${version}. It needs a newer MixOS.`
    : `${where} is version ${named.version} of ${describes}, which this MixOS no longer reads. Bring it to version ${version}: "${url}".`;
}
