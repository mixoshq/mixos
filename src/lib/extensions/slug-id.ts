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
 * minted once and never derived again. mixos.org mints it when an extension is
 * first listed; `npm run rename` mints one for an extension renamed here, or
 * takes the one mixos.org minted (scripts/rename.ts). Collisions are still
 * possible, but two people would have to choose the same name and draw the
 * same 32-bit id.
 *
 * The build accepts a slug without one: an extension gets its id when it is
 * first listed, and nothing published before ids has one.
 *
 * Mirrors mixos.org's src/lib/registry/slug-id.ts. Pure, with no imports: the
 * generator, the release step and the rename CLI all load it. See
 * docs/plans/20261110_0018-slug-ids.md.
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
