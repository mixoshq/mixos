/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What a proposal calls things on GitHub: its branch, its commit message and
 * its pull request's title.
 *
 * Each is built only from validated identifiers: the kind, the slug
 * (`SlugSchema`), the version (dotted or hex), the commit, the hashes and the
 * catalogue's origin, all checked by the install record's schema
 * (src/lib/repository/install-record.ts). Never from the manifest's `name`,
 * which can be any non-empty string, or anything else a publisher wrote:
 *
 *   - in a commit message, `[skip ci]` and its siblings, or a `skip-checks:`
 *     trailer, turn off the repository's workflows for that commit, and so the
 *     check that is meant to run on it (ciSkipMarker());
 *   - in a title, `[render preview]` starts a Render preview in Manual mode,
 *     and a preview copies the base service's environment, database URL
 *     included (renderPreviewMarker()).
 *
 * Each name is checked for both before it is returned, and
 * ./repository.ts checks again before anything is sent.
 */

import { ciSkipMarker } from "@/lib/repository/hand-back";
import {
  InstallRecordSchema,
  recordListingUrl,
  recordSourceUrl,
  type InstallRecord,
} from "@/lib/repository/install-record";
import { kindDir } from "@/lib/repository/pending";
import { sourceHost } from "@/lib/repository/provenance";
import { EXTENSION_KINDS, SlugSchema, type ExtensionKind } from "@/lib/repository/types";

/**
 * Every branch the App writes is under this. ./repository.ts refuses a ref
 * outside it, and the Apps page lists pull requests from branches in it.
 */
export const APP_BRANCH_PREFIX = "mixos/";

/**
 * What a branch under `mixos/` proposes. Rank 31 adds updating and removing an
 * extension (`mixos/update/…`, `mixos/remove/…`); rank 32, a MixOS update.
 */
export type ProposalAction = "install";

/** What Render reads in a pull request's title, telling it to skip a preview in Automatic mode. */
export const SKIP_PREVIEW = "[skip preview]";

/** `apps/files`: the one folder a proposal for this extension writes. */
export function extensionFolder(kind: ExtensionKind, slug: string): string {
  assertIdentifiers(kind, slug);
  return `${kindDir(kind)}/${slug}`;
}

/** `mixos/install/app-files`. A fixed name, so a second proposal of the same extension fails cleanly. */
export function proposalBranch(kind: ExtensionKind, slug: string): string {
  assertIdentifiers(kind, slug);
  return `${APP_BRANCH_PREFIX}install/${kind}-${slug}`;
}

/** What a branch the App made proposes, from its name alone, or null for any other branch. */
export function parseProposalBranch(
  ref: string,
): { action: ProposalAction; kind: ExtensionKind; slug: string } | null {
  const m = /^mixos\/install\/(app|connector|theme)-([a-z0-9-]+)$/.exec(ref);
  if (!m || !SlugSchema.safeParse(m[2]).success) return null;
  return { action: "install", kind: m[1] as ExtensionKind, slug: m[2] };
}

function assertIdentifiers(kind: ExtensionKind, slug: string): void {
  if (!EXTENSION_KINDS.includes(kind) || !SlugSchema.safeParse(slug).success) {
    throw new Error("A proposal's names are built from a kind and a slug the Registry validates.");
  }
}

/**
 * The first thing in `text` that makes Render build a preview, or null:
 * `[render preview]`, in any case and spacing, and the same words the other way
 * round. Matched loosely, as ciSkipMarker() is.
 */
export function renderPreviewMarker(text: string): string | null {
  const m = /\[\s*render[\s_-]*preview\s*\]|\[\s*preview[\s_-]*render\s*\]/i.exec(text);
  return m ? m[0] : null;
}

/** Throws unless `text` is one line holding neither marker. */
function assertClean(text: string, what: string): string {
  const marker = ciSkipMarker(text) ?? renderPreviewMarker(text);
  if (marker) throw new Error(`A proposal's ${what} would hold ${JSON.stringify(marker)}.`);
  return text;
}

/** The record, checked: every value in it is an identifier. */
function checked(record: InstallRecord): InstallRecord {
  return InstallRecordSchema.parse(record);
}

const TitleFields = InstallRecordSchema.pick({ source: true, kind: true, slug: true, version: true });

/**
 * `Add app files 1.2.0 from mixos.org [skip preview]`. It needs only the
 * release's identifiers, so the propose dialog can show it before anything is
 * downloaded.
 */
export function proposalTitle(release: Pick<InstallRecord, "source" | "kind" | "slug" | "version">): string {
  const r = TitleFields.parse({ source: release.source, kind: release.kind, slug: release.slug, version: release.version });
  const title = `Add ${r.kind} ${r.slug} ${r.version} from ${sourceHost(r.source)} ${SKIP_PREVIEW}`;
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(title)) throw new Error("A proposal's title is one line.");
  return assertClean(title, "title");
}

/**
 * The commit's message: a subject, what it is, and the provenance trailers
 * the hand-back's message has (src/lib/repository/hand-back.ts), every one a
 * validated value.
 */
export function proposalCommitMessage(record: InstallRecord): string {
  const r = checked(record);
  const folder = extensionFolder(r.kind, r.slug);
  const host = sourceHost(r.source);
  const source = recordSourceUrl(r);
  const message = [
    `Add ${r.kind} ${r.slug} ${r.version} from ${host}`,
    "",
    `Release ${r.version} at commit ${r.commitSha.slice(0, 12)}, downloaded and checked against the`,
    `hash ${host} published, then proposed through the GitHub App.`,
    `${folder}/.registry.json records what was verified.`,
    ...(source ? ["", `The source at that commit: ${source}`] : []),
    "",
    `Registry-Source: ${r.source}`,
    `Registry-Version: ${r.version}`,
    `Registry-Commit: ${r.commitSha}`,
    `Registry-Content-Hash: ${r.contentHash}`,
    `Registry-Files-Hash: ${r.filesHash}`,
    `Registry-Listing: ${recordListingUrl(r)}`,
  ].join("\n");
  return assertClean(message, "commit message");
}
