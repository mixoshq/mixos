/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The mixos.org repository contract — the read and install half of it.
 *
 * ── WHERE THIS COMES FROM ───────────────────────────────────────────────────
 *
 * mixos.org owns this shape. Its executable spec is `src/lib/repository/types.ts`
 * in the mixos-org repository, and `ARCHITECTURE.md` beside it describes the
 * flow. This file is the CLIENT half: the subset a MixOS instance needs to
 * search the catalogue and install from it. The publishing side
 * (`RepositoryPublishing`, `ListingDraft`) is deliberately absent — nothing in
 * an instance publishes.
 *
 * ── WHY THESE ARE ZOD SCHEMAS AND NOT JUST INTERFACES ───────────────────────
 *
 * Every value here arrives over the network from a service this instance does
 * not control, and one of them (`tarballUrl`) is then used to make a second
 * request, while another (`slug`) becomes a path on disk. A TypeScript
 * interface asserts the shape; it does not check it. So the wire types are
 * parsed, and the TS types are inferred from the parsers rather than written
 * twice — a field that drifts on the server surfaces as a parse error naming
 * the field, not as `undefined` three call frames later.
 *
 * Objects here are LOOSE, not strict: mixos.org adding a field must not break
 * every installed instance. Unknown keys are dropped by `z.object`, which is
 * the behaviour we want. The strictness lives on the fields we actually read.
 *
 * ── THE ONE-LINE VERSION OF THE MODEL ───────────────────────────────────────
 *
 * mixos.org is an INDEX, not a package host. It stores metadata and identity;
 * GitHub stores code. An instance asks mixos.org *what* to fetch and *how to
 * verify it*, then fetches from GitHub itself and refuses on a hash mismatch.
 * See `install.ts` for the pipeline that does that.
 */

import { z } from "zod";

/** The three things that can be installed into an instance. */
export const ExtensionKindSchema = z.enum(["app", "connector", "theme"]);
export type ExtensionKind = z.infer<typeof ExtensionKindSchema>;

export const EXTENSION_KINDS: readonly ExtensionKind[] = [
  "app",
  "connector",
  "theme",
];

/**
 * Plural, URL-safe segment per kind — `/extend/apps`, `/api/v1/apps/...`.
 *
 * This is also the directory each kind installs into, which is not a
 * coincidence worth relying on: `INSTALL_DIR` in `install.ts` states it
 * separately so that a change to one of mixos.org's URL segments cannot
 * silently redirect a write on this filesystem.
 */
export const KIND_SEGMENT: Record<ExtensionKind, string> = {
  app: "apps",
  connector: "connectors",
  theme: "themes",
};

export const SEGMENT_KIND: Record<string, ExtensionKind> = {
  apps: "app",
  connectors: "connector",
  themes: "theme",
};

/** Singular and plural labels, for headings and counts. */
export const KIND_LABEL: Record<ExtensionKind, { one: string; many: string }> = {
  app: { one: "App", many: "Apps" },
  connector: { one: "Connector", many: "Connectors" },
  theme: { one: "Theme", many: "Themes" },
};

/**
 * The publisher.
 *
 * `handle` is a GitHub login and can be renamed — mixos.org joins on the
 * immutable `githubId`. Do not treat the handle as an identity anywhere.
 */
export const AuthorSchema = z.object({
  handle: z.string(),
  githubId: z.number().nullish(),
  name: z.string().nullish(),
  url: z.string().nullish(),
  avatarUrl: z.string().nullish(),
  /**
   * A badge mixos.org assigns to a PUBLISHER. It is not an audit of the code,
   * and this instance renders it as exactly that much — see `extension-card`.
   */
  verified: z.boolean().default(false),
});
export type Author = z.infer<typeof AuthorSchema>;

/** The GitHub repo holding one extension's code. Not "the repository". */
export const SourceRepoSchema = z.object({
  host: z.literal("github"),
  owner: z.string().min(1),
  name: z.string().min(1),
  url: z.string(),
  /** Subdirectory holding the extension. No leading or trailing slash. */
  subpath: z.string().nullish(),
  defaultBranch: z.string().nullish(),
});
export type SourceRepo = z.infer<typeof SourceRepoSchema>;

/**
 * A content hash as mixos.org records it: `sha256-<base64>`.
 *
 * Pinned to sha256 by the pattern rather than accepting `<alg>-<digest>`
 * generally. An algorithm agility field that the client resolves at runtime is
 * a downgrade attack waiting to be written — a server that can name the
 * algorithm can name a weak one. Adding a second algorithm here should be a
 * deliberate code change with a floor, not a string the server picks.
 *
 * NOTE WHERE THIS IS AND IS NOT APPLIED. It is a semantic check
 * (`isVerifiableHash`), never a parse rule on the wire types. A repository that
 * publishes a placeholder in this field — mixos.org's seeded catalogue
 * currently publishes `sha256-PLACEHOLDER-<slug>` — is sending a well-formed
 * response whose content says "this release cannot be verified". Rejecting the
 * whole payload as malformed would report that as the repository being broken,
 * and would take the browse grid down over a fact that only matters at the
 * moment of installing.
 */
export const CONTENT_HASH_PATTERN = /^sha256-[A-Za-z0-9+/]{43}=$/;

/** Full 40-character lowercase commit SHA. Never a branch, never a bare tag. */
export const CommitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "expected a full 40-character commit SHA");

/**
 * One published release.
 *
 * The three-field arrangement is the whole security model: `gitTag` is mutable
 * and for humans, `commitSha` is what the tag pointed at when mixos.org
 * resolved it, and `contentHash` is what those files hashed to. Installs fetch
 * the commit and verify the hash, so moving a tag afterwards changes nothing.
 */
export const ReleaseSchema = z.object({
  version: z.string(),
  gitTag: z.string(),
  commitSha: CommitShaSchema,
  /** Display only here; see CONTENT_HASH_PATTERN on why this is not validated. */
  contentHash: z.string(),
  releasedAt: z.string(),
  notes: z.string().nullish(),
  requiresMixOS: z.string().nullish(),
  yanked: z.boolean().nullish(),
  yankedReason: z.string().nullish(),
});
export type Release = z.infer<typeof ReleaseSchema>;

/**
 * A permission the extension asks for, in the publisher's words.
 *
 * ADVISORY ONLY, and the UI says so. What this instance actually enforces comes
 * from the manifest on disk after download — `egress`, `escapes`, `connectors`,
 * `defaultRole` — which is the copy that has been through the registry checks.
 * These two can disagree, and when they do the manifest is the truth.
 */
export const PermissionSchema = z.object({
  scope: z.string(),
  reason: z.string(),
});
export type Permission = z.infer<typeof PermissionSchema>;

export const ScreenshotSchema = z.object({
  url: z.string(),
  alt: z.string(),
  width: z.number().nullish(),
  height: z.number().nullish(),
  caption: z.string().nullish(),
});
export type Screenshot = z.infer<typeof ScreenshotSchema>;

export const ListingStatusSchema = z.enum([
  "draft",
  "in_review",
  "published",
  "rejected",
  "unpublished",
]);
export type ListingStatus = z.infer<typeof ListingStatusSchema>;

/**
 * A slug as mixos.org validates it, re-validated here.
 *
 * This value becomes a DIRECTORY NAME on this filesystem, so it is checked
 * against the same pattern mixos.org enforces rather than trusted: lowercase
 * letters, digits and single interior hyphens, 2–48 characters. That
 * incidentally excludes `.`, `..`, `/` and every other path metacharacter,
 * which is the property `install.ts` depends on — and it re-derives its own
 * containment check anyway, because one guard for a filesystem write is one
 * guard too few.
 */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SlugSchema = z
  .string()
  .min(2)
  .max(48)
  .regex(SLUG_PATTERN, "invalid slug");

/**
 * What `/api/v1/search` returns per item — a SUMMARY, not a full listing.
 *
 * This distinction is not cosmetic and was learned the expensive way: the
 * client was first written against the spec's `Extension`, and every real
 * search response was then rejected as malformed because a summary carries no
 * `sourceRepo` and no `releases`. A page of 24 stays small precisely by leaving
 * those out, so the browse grid has to be built from what is here — notably
 * `latestVersion` instead of `releases[0].version`.
 *
 * Anything needing the repository, the description, the screenshots or the
 * release list fetches the detail endpoint. `RegisterDialog` is the one screen
 * that does, because it is the one screen where those facts matter.
 */
export const ExtensionSummarySchema = z.object({
  slug: SlugSchema,
  kind: ExtensionKindSchema,
  name: z.string(),
  tagline: z.string().default(""),
  categories: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
  author: AuthorSchema,
  license: z.string().default(""),
  iconUrl: z.string().nullish(),
  /** Cumulative installs, ever. Monotonic. */
  installCount: z.number().default(0),
  /** Installs currently reporting in. A different fact from `installCount`. */
  activeInstalls: z.number().nullish(),
  /** Null when unrated. Not 0 — that reads as "bad" rather than "unknown". */
  rating: z.object({ average: z.number(), count: z.number() }).nullish(),
  featured: z.boolean().default(false),
  /** The current release's version. Absent means nothing is installable. */
  latestVersion: z.string().nullish(),
  updatedAt: z.string().nullish(),
});
export type ExtensionSummary = z.infer<typeof ExtensionSummarySchema>;

/** One full catalogue listing, from `/api/v1/<kind>/<slug>`. */
export const ExtensionSchema = ExtensionSummarySchema.extend({
  status: ListingStatusSchema.nullish(),
  statusReason: z.string().nullish(),
  sourceRepo: SourceRepoSchema,
  description: z.string().default(""),
  /** Newest first. `releases[0]` is current. Empty means nothing installable. */
  releases: z.array(ReleaseSchema).default([]),
  screenshots: z.array(ScreenshotSchema).default([]),
  permissions: z.array(PermissionSchema).default([]),
  homepageUrl: z.string().nullish(),
  issuesUrl: z.string().nullish(),
  createdAt: z.string().nullish(),
});
export type Extension = z.infer<typeof ExtensionSchema>;

/** A page of search results plus what pagination needs. */
export const PageSchema = z.object({
  items: z.array(ExtensionSummarySchema),
  page: z.number().default(1),
  pageSize: z.number().default(24),
  total: z.number().default(0),
  totalPages: z.number().default(1),
});
export type ExtensionPage = z.infer<typeof PageSchema>;

export const SORT_KEYS = ["relevance", "popular", "recent", "name"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export const SORT_LABEL: Record<SortKey, string> = {
  relevance: "Best match",
  popular: "Most installed",
  recent: "Recently updated",
  name: "Name (A–Z)",
};

/** Everything the browse UI can ask for. Each field is one URL search param. */
export interface ListQuery {
  kind?: ExtensionKind;
  q?: string;
  category?: string;
  author?: string;
  sort?: SortKey;
  page?: number;
  pageSize?: number;
  featured?: boolean;
}

/**
 * What mixos.org answers when asked how to install something.
 *
 * It never serves the code. It answers "which exact bytes, and how do I know I
 * got them" — this instance then fetches from GitHub directly and refuses on a
 * mismatch. An unverified download would make the rest of this pointless.
 */
export const InstallManifestSchema = z.object({
  kind: ExtensionKindSchema,
  slug: SlugSchema,
  name: z.string(),
  version: z.string(),
  commitSha: CommitShaSchema,
  gitTag: z.string(),
  /**
   * Where to fetch from, pinned to `commitSha`.
   *
   * SERVER-SUPPLIED URL. `fetch-source.ts` will not request it until it has
   * passed a host allowlist and been confirmed to carry this exact SHA — a
   * remote-controlled URL that this instance fetches server-side is an SSRF
   * primitive, and "it came from mixos.org" is not a control.
   */
  tarballUrl: z.string(),
  /**
   * Parsed as a plain string, NOT checked against `CONTENT_HASH_PATTERN`.
   *
   * A repository that publishes something which is not a hash — mixos.org's
   * seeded catalogue currently publishes `sha256-PLACEHOLDER-<slug>` — is not
   * sending a malformed response; it is sending a well-formed response that
   * says this release cannot be verified. Those are different problems with
   * different fixes, and collapsing them into one schema error tells the admin
   * "the repository is broken" when the truth is "this release has no checksum
   * yet". `isVerifiableHash` below is where that decision is made and named.
   */
  contentHash: z.string(),
  subpath: z.string().nullish(),
  permissions: z.array(PermissionSchema).default([]),
  requiresMixOS: z.string().nullish(),
  yanked: z.boolean().nullish(),
  yankedReason: z.string().nullish(),
});
export type InstallManifest = z.infer<typeof InstallManifestSchema>;

/**
 * Is this a checksum that can actually verify anything?
 *
 * Separate from parsing so the answer can be reported as what it is. The one
 * thing this must never do is degrade to "install it anyway" — a release
 * without a real hash is a release nothing can be checked against, which is
 * exactly the situation the whole pipeline exists to refuse.
 */
export function isVerifiableHash(contentHash: string): boolean {
  return CONTENT_HASH_PATTERN.test(contentHash);
}
