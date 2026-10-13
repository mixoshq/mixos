/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ciSkipMarker } from "@/lib/repository/hand-back";
import { InstallRecordSchema, type InstallRecord } from "@/lib/repository/install-record";
import {
  extensionFolder,
  isReleaseTag,
  parseProposalBranch,
  proposalBranch,
  proposalCommitMessage,
  proposalTitle,
  renderPreviewMarker,
  updateBranch,
  updateTitle,
} from "./names";

const record: InstallRecord = {
  source: "https://mixos.org",
  kind: "app",
  slug: "files",
  version: "1.2.0",
  gitTag: "v1.2.0",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  contentHash: `sha256-${"A".repeat(43)}=`,
  filesHash: `sha256-${"B".repeat(43)}=`,
  repository: { owner: "acme", name: "mixos-files", subpath: "apps/files" },
  requiresMixOS: "0.1.0",
};

describe("a proposal's names", () => {
  test("the branch, folder, title and commit message", () => {
    assert.equal(proposalBranch("app", "files"), "mixos/install/app-files");
    assert.equal(proposalBranch("connector", "stripe-billing"), "mixos/install/connector-stripe-billing");
    assert.equal(extensionFolder("theme", "paper"), "themes/paper");
    assert.equal(proposalTitle(record), "Add app files 1.2.0 from mixos.org [skip preview]");
    const untagged: InstallRecord = { ...record, version: "3f2a9c1", gitTag: null };
    assert.equal(proposalTitle(untagged), "Add app files 3f2a9c1 from mixos.org [skip preview]");
    const message = proposalCommitMessage(record);
    assert.equal(message.split("\n")[0], "Add app files 1.2.0 from mixos.org");
    assert.match(message, /^Registry-Files-Hash: sha256-B{43}=$/m);
    assert.match(message, /^Registry-Listing: https:\/\/mixos\.org\/extend\/apps\/files$/m);
    assert.match(message, /https:\/\/github\.com\/acme\/mixos-files\/tree\/0123456789abcdef0123456789abcdef01234567\/apps\/files/);
  });

  test("a branch is built from a kind and a slug the Registry validates, and read back", () => {
    for (const slug of ["Files", "a", "../x", "x/y", "files [skip ci]", "files\nskip-checks: true"]) {
      assert.throws(() => proposalBranch("app", slug), slug);
    }
    assert.throws(() => proposalBranch("plugin" as "app", "files"));
    assert.deepEqual(parseProposalBranch("mixos/install/connector-stripe-billing"), {
      action: "install",
      kind: "connector",
      slug: "stripe-billing",
    });
    for (const ref of ["main", "mixos/install/plugin-x", "mixos/install/app-Files", "mixos/install/app-x/y", "mixos/install/app-"]) {
      assert.equal(parseProposalBranch(ref), null, ref);
    }
  });

  test("a value that could hold a marker is never one a record accepts", () => {
    for (const bad of [
      { version: "1.2.0 [skip ci]" },
      { version: "1.2.0\nskip-checks: true" },
      { gitTag: "v1 [render preview]" },
      { source: "https://mixos.org/[skip ci]" },
      { slug: "files [skip ci]" },
    ]) {
      assert.equal(InstallRecordSchema.safeParse({ ...record, ...bad }).success, false, JSON.stringify(bad));
      // The title is built from the source, kind, slug and version only.
      if (!("gitTag" in bad)) assert.throws(() => proposalTitle({ ...record, ...bad } as InstallRecord));
      assert.throws(() => proposalCommitMessage({ ...record, ...bad } as InstallRecord));
    }
  });

  test("no title or message built from valid identifiers holds a marker", () => {
    const versions = ["0.0.1", "1.2.0-rc.1+build.5", "10.20.30", "abcdef0", "0123456789abcdef0123456789abcdef01234567"];
    const slugs = ["skip-ci", "ci-skip", "render-preview", "no-ci", "skip-checks", "actions-skip"];
    const sources = ["https://mixos.org", "http://localhost:4321", "http://[::1]:8791", "http://127.0.0.1:4430"];
    for (const version of versions) {
      for (const slug of slugs) {
        for (const source of sources) {
          for (const kind of ["app", "connector", "theme"] as const) {
            const r = { ...record, version, slug, source, kind, gitTag: null };
            const title = proposalTitle(r);
            const message = proposalCommitMessage(r);
            assert.equal(ciSkipMarker(title), null, title);
            assert.equal(renderPreviewMarker(title), null, title);
            assert.equal(ciSkipMarker(message), null, message);
            assert.equal(renderPreviewMarker(message), null, message);
            assert.ok(!/[\n\r]/.test(title));
            assert.ok(title.endsWith(" [skip preview]"));
          }
        }
      }
    }
  });

  test("the markers are found however they are spelled", () => {
    for (const text of ["[render preview]", "[Render  Preview]", "x [ render-preview ] y", "[preview render]", "[RENDER_PREVIEW]"]) {
      assert.ok(renderPreviewMarker(text), text);
    }
    assert.equal(renderPreviewMarker("[skip preview]"), null);
    assert.equal(renderPreviewMarker("render a preview"), null);
    for (const text of ["[skip ci]", "[CI SKIP]", "[no ci]", "[skip actions]", "[actions skip]", "x\nskip-checks: true\n", "  Skip-Checks : yes"]) {
      assert.ok(ciSkipMarker(text), text);
    }
  });
});

describe("a MixOS update's names", () => {
  test("the branch and the title, from a release tag the list's schema accepts", () => {
    assert.equal(updateBranch("v0.5.0"), "mixos/update-v0.5.0");
    assert.equal(updateBranch("v0.5.0-rc.1"), "mixos/update-v0.5.0-rc.1");
    assert.equal(updateTitle("v0.5.0"), "Update MixOS to v0.5.0 [skip preview]");
    assert.equal(ciSkipMarker(updateTitle("v10.20.30")), null);
    assert.equal(renderPreviewMarker(updateTitle("v10.20.30")), null);
    for (const bad of ["0.5.0", "v0.5", "v01.5.0", "v0.5.0 [skip ci]", "v0.5.0\nskip-checks: true", "main", "v0.5.0/x", "", "v0.5.0-"]) {
      assert.equal(isReleaseTag(bad), false, bad);
      assert.throws(() => updateBranch(bad), bad);
      assert.throws(() => updateTitle(bad), bad);
    }
  });

  test("an update branch is read back, and told from an install's and from rank 31's", () => {
    assert.deepEqual(parseProposalBranch("mixos/update-v0.5.0"), { action: "mixos-update", tag: "v0.5.0" });
    assert.deepEqual(parseProposalBranch("mixos/update-v0.5.0-rc.1"), { action: "mixos-update", tag: "v0.5.0-rc.1" });
    for (const ref of ["mixos/update/app-files", "mixos/update-0.5.0", "mixos/update-v0.5", "mixos/update-", "mixos/update-v0.5.0/x", "mixos/updates-v0.5.0"]) {
      assert.equal(parseProposalBranch(ref), null, ref);
    }
  });
});
