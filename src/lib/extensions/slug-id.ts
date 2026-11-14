/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Slug ids: the eight hex characters at the end of an extension's slug,
 * `sales-tracker-3f9a2c1b`.
 *
 * A slug is an extension's name everywhere: its folder, URL, database schema,
 * `data-theme` value, Registry listing. Plain names collide as more people
 * publish, so a slug ends in an id: the first eight hex characters of a UUID,
 * minted once and never derived again. Collisions are still possible, but two
 * people would have to choose the same name and draw the same 32-bit id.
 *
 * The slug is written down in the extension's own manifest, as `registryId`,
 * and its folder is named after it. It is minted when the extension is created
 * (`npm run new`, scripts/new-extension.ts), or when one is renamed here
 * (`npm run rename`, scripts/rename.ts), and every reader takes it from the
 * manifest: the build, an install, and mixos.org, which lists the extension
 * under it rather than minting one of its own.
 *
 * Mirrors mixos.org's src/lib/registry/slug-id.ts. Pure, with no imports: the
 * generator, the release step and the CLIs all load it. See
 * docs/plans/20261110_0018-slug-ids.md and docs/plans/20261114_0947-registry-id.md.
 */

/** Hex characters in an id. */
export const SLUG_ID_LENGTH = 8;

const ID_PART = new RegExp(`^[0-9a-f]{${SLUG_ID_LENGTH}}$`);

/** A slug's base and its id, or null when it doesn't end in one. */
export function splitSlug(slug: string): { base: string; id: string } | null {
  const cut = slug.lastIndexOf("-");
  if (cut <= 0) return null;
  const id = slug.slice(cut + 1);
  return ID_PART.test(id) ? { base: slug.slice(0, cut), id } : null;
}

/** Whether `slug` ends in an id. */
export function hasSlugId(slug: string): boolean {
  return splitSlug(slug) !== null;
}

/** A new id: the first eight hex characters of a random UUID. */
export function mintSlugId(): string {
  return crypto.randomUUID().slice(0, SLUG_ID_LENGTH);
}

/** `base` with a new id after it. */
export function withSlugId(base: string): string {
  return `${base}-${mintSlugId()}`;
}

/**
 * Orders slugs by name, then id: `mixos-<id>` before `mixos-dark-<id>`
 * whichever ids they drew. Plain `localeCompare` on the whole slug would let
 * a random id decide which of the two sorts first, and the first theme is the
 * one a fresh install shows (themes/AGENTS.md invariant 19).
 */
export function compareSlugs(a: string, b: string): number {
  const base = (s: string) => splitSlug(s)?.base ?? s;
  return base(a).localeCompare(base(b)) || a.localeCompare(b);
}

/**
 * A `registryId`: a lowercase name, a hyphen, and an id, `sales-tracker-3f9a2c1b`.
 * The same letters, digits and single hyphens as a slug anywhere else, so the
 * folder named after it is also a URL segment, a database schema and a
 * `data-theme` value.
 */
export const REGISTRY_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{8}$/;

/** The longest `registryId`: the longest slug mixos.org lists. */
export const REGISTRY_ID_MAX_LENGTH = 48;

/**
 * The id the `_template` folders carry in their `registryId`, so they pass the
 * schema. `npm run new` replaces it with a minted one, and the build refuses
 * it anywhere else.
 */
export const PLACEHOLDER_SLUG_ID = "00000000";

/** The files whose `registryId` names an extension, and the npm script that renames one. */
type Kind = "app" | "connector" | "theme";
const KIND_DIR: Record<Kind, string> = { app: "apps", connector: "connectors", theme: "themes" };

/**
 * Why the manifest `file` in `folder` can't be the extension it says it is,
 * or null when it can. Its `registryId` must have a minted id, not the
 * templates' placeholder, and the folder must be named after it: a folder has
 * one name, so two extensions on an instance can't share one.
 */
export function registryIdProblem(kind: Kind, file: string, registryId: string, folder: string): string | null {
  if (splitSlug(registryId)?.id === PLACEHOLDER_SLUG_ID) {
    return (
      `${file} "registryId" is "${registryId}", the template's placeholder. ` +
      `Create an extension with \`npm run new -- ${kind} <name>\`, which mints its id.`
    );
  }
  if (registryId !== folder) {
    return (
      `${file} "registryId" is "${registryId}", but its folder is ${KIND_DIR[kind]}/${folder}. ` +
      `An extension's folder is named after its registryId: rename the folder to "${registryId}", ` +
      `or run \`npm run rename -- ${kind}/${folder}\` to give it a new one.`
    );
  }
  return null;
}

/** The manifest file of each kind, which holds its `registryId`. */
export const MANIFEST_FILE: Record<Kind, string> = {
  app: "app.json",
  connector: "connector.json",
  theme: "theme.json",
};

/**
 * `manifest` with `registryId` set, right after `$schema` where the schema
 * puts it (or first, without one), and every other key in its place. What
 * `npm run new`, `npm run rename` and the pre-commit stamp write.
 */
export function withRegistryId(manifest: Record<string, unknown>, registryId: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!("$schema" in manifest)) out.registryId = registryId;
  for (const [key, value] of Object.entries(manifest)) {
    if (key === "registryId") continue;
    out[key] = value;
    if (key === "$schema") out.registryId = registryId;
  }
  return out;
}
