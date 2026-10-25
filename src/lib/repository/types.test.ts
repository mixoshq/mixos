/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { signedForTest } from "./test-signing";
import { ExtensionSchema, InstallManifestSchema } from "./types";

// ── fixtures ────────────────────────────────────────────────────────────────

const commitSha = "3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39";

/** What mixos.org's install endpoint returns for a release published from the website. */
const websiteInstall = signedForTest({
  kind: "app",
  slug: "standup",
  name: "Standup",
  version: commitSha.slice(0, 7),
  commitSha,
  gitTag: null,
  tarballUrl: `https://codeload.github.com/acme/standup/tar.gz/${commitSha}`,
  contentHash: "sha256-PLACEHOLDER-standup",
  contentHashAlgorithm: "mixos-tree-v1",
  subpath: null,
  permissions: [],
  requiresMixOS: null,
  yanked: false,
  yankedReason: null,
});

const release = (gitTag: string | null) => ({
  version: gitTag ?? commitSha.slice(0, 7),
  gitTag,
  commitSha,
  contentHash: "sha256-PLACEHOLDER-standup",
  releasedAt: "2026-10-01T12:00:00.000Z",
});

const listing = (releases: unknown[]) => ({
  slug: "standup",
  kind: "app",
  name: "Standup",
  author: { handle: "acme" },
  sourceRepo: { host: "github", owner: "acme", name: "standup", url: "https://github.com/acme/standup" },
  releases,
});

// ── untagged releases ───────────────────────────────────────────────────────

test("an install manifest for an untagged release parses, pinned to its commit", () => {
  const parsed = InstallManifestSchema.safeParse(websiteInstall);
  assert.ok(parsed.success, parsed.error?.message);
  assert.equal(parsed.data.gitTag, null);
  assert.equal(parsed.data.commitSha, commitSha);

  const withoutTag: Record<string, unknown> = { ...websiteInstall };
  delete withoutTag.gitTag;
  assert.ok(InstallManifestSchema.safeParse(withoutTag).success);
});

test("a tagged release still carries its tag", () => {
  const parsed = InstallManifestSchema.safeParse({ ...websiteInstall, gitTag: "v1.2.0" });
  assert.ok(parsed.success);
  assert.equal(parsed.data.gitTag, "v1.2.0");
});

test("a listing whose releases mix tagged and untagged parses", () => {
  const parsed = ExtensionSchema.safeParse(listing([release(null), release("v1.0.0")]));
  assert.ok(parsed.success, parsed.error?.message);
  assert.deepEqual(
    parsed.data.releases.map((r) => r.gitTag),
    [null, "v1.0.0"],
  );
});

test("the commit is still required to be a full SHA", () => {
  assert.equal(
    InstallManifestSchema.safeParse({ ...websiteInstall, commitSha: commitSha.slice(0, 7) }).success,
    false,
  );
});
