/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An extension's identity: which extension a name in a build is, as the
 * release step records it for each app (scripts/sync-app-registry.ts), and
 * each connector and theme (scripts/sync-identities.ts).
 *
 *   - Installed from a Registry, with an install record the registry generator
 *     accepted (src/generated/registry-installs.ts): the catalogue it came
 *     from, its kind and slug, and the GitHub repository its release was
 *     downloaded from, on one line:
 *
 *       https://mixos.org app/files acme/mixos-files
 *
 *   - Anything else is `local`: a folder with no record, or with one the
 *     generator didn't accept as the folder's own.
 *
 * The version and the commit are left out, so a new release from the same
 * repository is the same extension, and updating it changes nothing here. The
 * owner and the repository's name are lowercased, as GitHub matches them.
 * Whether the folder was modified locally doesn't count either: it is still
 * the extension its record names.
 *
 * Every part is a value the install record validated, and none can hold a
 * space, so the line reads back unambiguously (parseIdentity()).
 *
 * Pure, with no imports a script or a browser can't load: the release step,
 * the server and the admin pages all use it.
 */

import type { RegistryInstall } from "./install-record";
import { sourceHost } from "./provenance";
import type { ExtensionKind } from "./types";

/** The identity of an extension with no install record. */
export const LOCAL_IDENTITY = "local";

/** Where the release step records a connector's or a theme's identity, in `platform_settings`. */
export function identitySettingKey(kind: "connector" | "theme", slug: string): string {
  return `${kind}.identity.${slug}`;
}

/** The identity of the extension of `kind` named `slug` in a build with these installs from a Registry. */
export function extensionIdentity(
  kind: ExtensionKind,
  slug: string,
  installs: readonly RegistryInstall[],
): string {
  const install = installs.find((i) => i.kind === kind && i.slug === slug);
  if (!install) return LOCAL_IDENTITY;
  const { owner, name } = install.repository;
  return `${install.source} ${kind}/${slug} ${owner.toLowerCase()}/${name.toLowerCase()}`;
}

export type ParsedIdentity =
  | { local: true }
  | {
      local: false;
      source: string;
      kind: ExtensionKind;
      slug: string;
      owner: string;
      name: string;
    };

const KINDS: readonly string[] = ["app", "connector", "theme"];

/** A recorded identity, read back; null for text that isn't one. */
export function parseIdentity(text: string): ParsedIdentity | null {
  if (text === LOCAL_IDENTITY) return { local: true };
  const parts = text.split(" ");
  if (parts.length !== 3) return null;
  const [source, kindSlug, repo] = parts;
  const [kind, slug, extra] = kindSlug.split("/");
  const [owner, name, more] = repo.split("/");
  if (extra !== undefined || more !== undefined) return null;
  if (!source || !KINDS.includes(kind) || !slug || !owner || !name) return null;
  return { local: false, source, kind: kind as ExtensionKind, slug, owner, name };
}

/**
 * An identity as an audit row records it: `"local"`, or the catalogue, the
 * kind and slug, and the repository. Text that isn't an identity is kept as
 * it is, and nothing recorded is null.
 */
export type IdentityDetails =
  | "local"
  | { source: string; kind: ExtensionKind; slug: string; repository: { owner: string; name: string } }
  | string
  | null;

export function identityDetails(text: string | null): IdentityDetails {
  if (text === null) return null;
  const parsed = parseIdentity(text);
  if (!parsed) return text;
  if (parsed.local) return LOCAL_IDENTITY;
  return {
    source: parsed.source,
    kind: parsed.kind,
    slug: parsed.slug,
    repository: { owner: parsed.owner, name: parsed.name },
  };
}

/**
 * An identity in a few words, for the admin pages and the release step's log:
 * "local, with no install record", or "from mixos.org, acme/mixos-files".
 */
export function describeIdentity(text: string | null): string {
  if (text === null) return "not recorded";
  const parsed = parseIdentity(text);
  if (!parsed) return "recorded in a form this version doesn't read";
  if (parsed.local) return "local, with no install record";
  return `from ${sourceHost(parsed.source)}, ${parsed.owner}/${parsed.name}`;
}
