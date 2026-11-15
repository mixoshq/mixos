/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The rename ledger: `extension-renames.json` at the root of the checkout, a
 * record of every extension renamed here, so each instance's data follows it to
 * its new slug.
 *
 *   {
 *     "$schema": "https://mixos.org/schemas/extension-renames/v1.json",
 *     "renames": [
 *       { "kind": "app", "from": "wall-e", "to": "wall-e-3f9a2c1b", "date": "2026-11-10" }
 *     ]
 *   }
 *
 * A slug is an extension's name everywhere an instance keeps something for it:
 * an app's grants, settings, API keys, widgets, schema and role; a connector's
 * credentials and every user's connection; the applied theme. A folder renamed
 * by hand is a new extension to every instance, which keeps everything under
 * the old slug (scripts/sync-app-registry.ts). A rename recorded here is moved
 * instead, by the release step (scripts/sync-renames.ts).
 *
 * WHY A LEDGER AND NOT A MANIFEST FIELD. A manifest is its publisher's. A field
 * saying "I am what `x` was" would let any Registry release claim another
 * extension's grants, keys, credentials and tables. This file is written only by
 * `npm run rename` (scripts/rename.ts), in the checkout's own repository, and
 * reviewed in its own commit: the same trust as the code the checkout deploys.
 *
 * The registry generator checks it against the build and writes it to
 * src/generated/extension-renames.ts, which the release step reads:
 *
 *  - every `from` is a slug the build doesn't carry, renamed once;
 *  - no `to` is a slug an earlier entry renamed away, so a chain of renames is
 *    followed in order, and a cycle can't be written;
 *  - every name is a slug of its kind.
 *
 * A `to` the build doesn't carry is an extension removed since it was renamed
 * (`npm run remove`, or Remove in the admin). Its data moves to the new slug
 * all the same and stays there, as a removed extension's data does, for a
 * reinstall to find. Refusing it would make a renamed extension impossible to
 * remove, as the generator runs without it before the removal is kept.
 *
 * Entries stay. A rename whose old slug holds nothing on an instance, a fresh
 * one or one that has moved it already, does nothing there.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { appSlugProblem } from "../src/lib/apps/app-identifiers";
import { schemaProblem, schemaUrl } from "../src/lib/extensions/schema-urls";
import { FatalManifestError } from "./manifest-errors";
import { formatZodError } from "./manifest-schemas";

export const RENAMES_FILE = "extension-renames.json";

export const RENAME_KINDS = ["app", "connector", "theme"] as const;
export type RenameKind = (typeof RENAME_KINDS)[number];

const renameSchema = z.strictObject({
  kind: z.enum(RENAME_KINDS),
  from: z.string().min(1),
  to: z.string().min(1),
  /** The day it was renamed. */
  date: z.iso.date('expected the day it was renamed, as "2026-11-10"'),
});

export const ExtensionRenamesFileSchema = z.strictObject({
  /** Which shape the file is: src/lib/extensions/schema-urls.ts. */
  $schema: z.literal(schemaUrl("extension-renames")),
  renames: z.array(renameSchema),
});

export type ExtensionRename = z.infer<typeof renameSchema>;

/** The ledger in `root`, oldest first, or none when there is no file. Throws for one that breaks its shape. */
export function readRenames(root: string): ExtensionRename[] {
  const file = path.join(root, RENAMES_FILE);
  if (!fs.existsSync(file)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    throw new FatalManifestError(`${RENAMES_FILE} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const shape = schemaProblem("extension-renames", (raw as { $schema?: unknown } | null)?.$schema, RENAMES_FILE);
  if (shape) throw new FatalManifestError(shape);
  const parsed = ExtensionRenamesFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new FatalManifestError(`${RENAMES_FILE} failed validation:\n${formatZodError(parsed.error)}`);
  }
  return parsed.data.renames;
}

/** The ledger's text, as `npm run rename` writes it. */
export function serializeRenames(renames: readonly ExtensionRename[]): string {
  const file = { $schema: schemaUrl("extension-renames"), renames };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Lowercase letters and digits in words joined by single hyphens: a connector's name or a theme's slug. */
const HYPHENATED = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Why `slug` can't name an extension of `kind`, or null when it can. */
export function slugProblem(kind: RenameKind, slug: string): string | null {
  if (kind === "app") return appSlugProblem(slug);
  return HYPHENATED.test(slug)
    ? null
    : `"${slug}" is not a ${kind} ${kind === "connector" ? "name" : "slug"}: use lowercase letters and digits, in words joined by single hyphens.`;
}

/** The slugs of each kind in a build. */
export type BuildSlugs = Record<RenameKind, readonly string[]>;

/** Every way the ledger doesn't fit the build, one line each. */
export function renameProblems(renames: readonly ExtensionRename[], build: BuildSlugs): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  renames.forEach((r, i) => {
    const at = `${RENAMES_FILE}: renames.${i} (${r.kind} ${r.from} → ${r.to})`;
    for (const slug of [r.from, r.to]) {
      const problem = slugProblem(r.kind, slug);
      if (problem) problems.push(`${at}: ${problem}`);
    }
    if (r.from === r.to) problems.push(`${at}: renames a slug to itself.`);

    const key = `${r.kind}/${r.from}`;
    if (seen.has(key)) problems.push(`${at}: ${r.from} is renamed twice; each slug moves once.`);
    seen.add(key);

    if (build[r.kind].includes(r.from)) {
      problems.push(
        `${at}: the build still carries ${r.kind} ${r.from}, so its data can't move to ${r.to}. ` +
          `Remove the folder, or the entry.`,
      );
    }
    // The data would stop at `to`, having already left it; or, for a cycle,
    // come back to a name it left. A `to` the build doesn't carry is fine: see
    // the note at the top of this file.
    const earlier = renames.slice(0, i).findIndex((prev) => prev.kind === r.kind && prev.from === r.to);
    if (earlier !== -1) {
      problems.push(
        `${at}: renames.${earlier} renamed ${r.to} away before this entry, so its data would stop at ${r.to}. ` +
          `A chain is listed in order, and doesn't come back to a slug it left.`,
      );
    }
  });
  return problems;
}
