/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Writes the JSON Schema of every JSON file an extension carries into
 * docs/schemas/, from the Zod schemas MixOS validates them with, so the two
 * can't disagree. mixos.org copies docs/schemas/ to /schemas/ (its
 * `npm run sync:docs`), which is where each file's `$schema` URL points
 * (src/lib/extensions/schema-urls.ts).
 *
 *   npx tsx scripts/json-schemas.ts           # write docs/schemas/
 *   npx tsx scripts/json-schemas.ts --check   # exit 1 when they are stale
 *
 * docs/schemas/<file>/v<N>.json is the schema, with `$schema` required and
 * fixed to its own URL. docs/schemas/index.json lists every schema with
 * `since`, the first MixOS release that reads it: "unreleased" until a release
 * PR is prepared, when scripts/release-prep.ts writes the version in
 * (stampSchemaSince()). mixos.org
 * reads `since` to set the minimum MixOS version of a release whose files name
 * the schema, because an older MixOS refuses the `$schema` key itself.
 *
 * A schema that has been released never changes: a new shape is a new version,
 * written beside it. This writes the current version of each file, and keeps
 * whatever else is already there.
 *
 * The exceptions so far, each made while no extension of that kind had been
 * published under the schema: app, connector and theme v1 gained a required
 * `registryId` after 0.7.0 (docs/plans/20261114_0947-registry-id.md), and
 * connector v1 an optional `scopes` on each `telemetry` entry after 0.8.0
 * (docs/plans/20261115_1111-connector-method-scopes.md). Each time `since` went
 * back to "unreleased" by hand, because buildIndex() keeps an existing one, so
 * the release that reads the new shape stamps itself as the first reader.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SCHEMA_FILES, SCHEMA_FILE_NAMES, schemaUrl, type SchemaFile } from "../src/lib/extensions/schema-urls";
import { InstallRecordFileSchema } from "../src/lib/repository/install-record";
import { RawAppManifestSchema, RawConnectorManifestSchema, RawThemeManifestSchema } from "./manifest-schemas";
import { ExtensionRenamesFileSchema } from "./extension-renames";
import { ReleaseNotesFileSchema } from "./release-notes";
import { UNRELEASED } from "./release-prep";

const ROOT = path.resolve(__dirname, "..");
export const SCHEMAS_DIR = path.join("docs", "schemas");
export const INDEX_FILE = "index.json";

/** What each schema says the file is, for an editor's hover and the published page. */
const DESCRIPTION: Record<SchemaFile, string> = {
  app: "A MixOS app's manifest, apps/<slug>/app.json.",
  connector: "A MixOS connector's manifest, connectors/<slug>/connector.json.",
  theme: "A MixOS theme's manifest, themes/<slug>/theme.json.",
  "release-notes":
    "An extension's release notes, release-notes.json beside its manifest: one line each, newest first.",
  "registry-install":
    "The record a Registry install writes into an extension's folder, .registry.json. Written by MixOS, never by hand.",
  "extension-renames":
    "The rename ledger at the root of a MixOS checkout, extension-renames.json: each extension renamed there, so every instance's data follows it. Written by `npm run rename`.",
};

/** The Zod schema of each file, as it is at its current version. */
function zodSchemaOf(file: SchemaFile): z.ZodType {
  switch (file) {
    case "app":
      return RawAppManifestSchema;
    case "connector":
      return RawConnectorManifestSchema;
    case "theme":
      return RawThemeManifestSchema;
    case "release-notes":
      return ReleaseNotesFileSchema;
    case "registry-install":
      return InstallRecordFileSchema;
    case "extension-renames":
      return ExtensionRenamesFileSchema;
  }
}

type JsonObject = Record<string, unknown>;

/** The JSON Schema of `file` at its current version, with `$schema` required and fixed to its URL. */
export function buildSchema(file: SchemaFile): JsonObject {
  const url = schemaUrl(file);
  const converted = z.toJSONSchema(zodSchemaOf(file), { target: "draft-2020-12", io: "input" }) as JsonObject;
  const { $schema: dialect, properties, required, ...rest } = converted;
  // The Zod schema fixes `$schema` to this URL itself, which is what MixOS
  // reads the file with. A schema that didn't would publish one MixOS doesn't
  // keep to.
  const { $schema: own, ...fields } = (properties ?? {}) as JsonObject;
  if ((own as JsonObject | undefined)?.const !== url || !(required as string[] | undefined)?.includes("$schema")) {
    throw new Error(`The Zod schema of ${SCHEMA_FILES[file].describes} doesn't require "$schema": "${url}".`);
  }
  return {
    $schema: dialect,
    $id: url,
    title: SCHEMA_FILES[file].describes,
    description: DESCRIPTION[file],
    ...rest,
    properties: {
      $schema: { ...(own as JsonObject), description: "This file's shape, and the version of it." },
      ...fields,
    },
    required: ["$schema", ...(required as string[]).filter((key) => key !== "$schema")],
  };
}

export interface IndexEntry {
  file: SchemaFile;
  describes: string;
  version: number;
  url: string;
  /** The first MixOS release that reads it, or "unreleased". */
  since: string;
}

export interface SchemaIndex {
  $comment: string;
  schemas: IndexEntry[];
}

const INDEX_COMMENT =
  "Generated by scripts/json-schemas.ts. `since` is the first MixOS release that reads each schema; scripts/release-prep.ts writes it.";

/** The index, keeping `since` for every schema `previous` already lists. */
export function buildIndex(previous: SchemaIndex | null): SchemaIndex {
  const known = new Map((previous?.schemas ?? []).map((e) => [e.url, e]));
  const current = SCHEMA_FILE_NAMES.map((file) => {
    const url = schemaUrl(file);
    return {
      file,
      describes: SCHEMA_FILES[file].describes,
      version: SCHEMA_FILES[file].version,
      url,
      since: known.get(url)?.since ?? UNRELEASED,
    };
  });
  // Versions that are no longer current stay listed: they were published.
  const kept = (previous?.schemas ?? []).filter((e) => !current.some((c) => c.url === e.url));
  const schemas = [...kept, ...current].sort((a, b) =>
    a.file === b.file ? a.version - b.version : a.file.localeCompare(b.file),
  );
  return { $comment: INDEX_COMMENT, schemas };
}

export const serialize = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Every file under docs/schemas/ this writes, by its path there, and its text. */
export function render(root: string = ROOT): Map<string, string> {
  const files = new Map<string, string>();
  for (const file of SCHEMA_FILE_NAMES) {
    files.set(`${file}/v${SCHEMA_FILES[file].version}.json`, serialize(buildSchema(file)));
  }
  const indexPath = path.join(root, SCHEMAS_DIR, INDEX_FILE);
  const previous = fs.existsSync(indexPath) ? (JSON.parse(fs.readFileSync(indexPath, "utf8")) as SchemaIndex) : null;
  files.set(INDEX_FILE, serialize(buildIndex(previous)));
  return files;
}

/** The files under docs/schemas/ that are missing or differ from `render()`. */
export function staleFiles(root: string = ROOT): string[] {
  const stale: string[] = [];
  for (const [rel, text] of render(root)) {
    const abs = path.join(root, SCHEMAS_DIR, rel);
    if (!fs.existsSync(abs) || fs.readFileSync(abs, "utf8") !== text) stale.push(path.join(SCHEMAS_DIR, rel));
  }
  return stale;
}

function main() {
  if (process.argv.includes("--check")) {
    const stale = staleFiles();
    if (stale.length > 0) {
      console.error(
        `These are out of date with the Zod schemas: ${stale.join(", ")}.\n` +
          "Run `npx tsx scripts/json-schemas.ts` and commit the result. A released schema never changes, " +
          "so if one of them was released, give its file a new version in src/lib/extensions/schema-urls.ts instead.",
      );
      process.exit(1);
    }
    console.log("docs/schemas/ is up to date.");
    return;
  }
  for (const [rel, text] of render()) {
    const abs = path.join(ROOT, SCHEMAS_DIR, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  console.log(`Wrote ${SCHEMAS_DIR}/.`);
}

if (require.main === module) main();
