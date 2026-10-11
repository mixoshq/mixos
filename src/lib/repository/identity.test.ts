/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An extension's identity, as the release step records it: what changes it,
 * what doesn't, and how it reads back. The release step's use of it is tested
 * against a real Postgres in scripts/sync-app-registry.integration.test.ts and
 * scripts/sync-identities.integration.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LOCAL_IDENTITY,
  describeIdentity,
  extensionIdentity,
  identityDetails,
  identitySettingKey,
  parseIdentity,
} from "./identity";
import type { RegistryInstall } from "./install-record";

function install(fields: Partial<RegistryInstall> = {}): RegistryInstall {
  return {
    kind: "app",
    slug: "files",
    version: "1.2.0",
    gitTag: "v1.2.0",
    commitSha: "a".repeat(40),
    source: "https://mixos.org",
    repository: { owner: "acme", name: "mixos-files", subpath: null },
    requiresMixOS: null,
    modified: false,
    ...fields,
  };
}

const FILES = "https://mixos.org app/files acme/mixos-files";

test("an extension with no install record is local", () => {
  assert.equal(extensionIdentity("app", "files", []), LOCAL_IDENTITY);
  // A record for another kind or slug isn't this extension's.
  assert.equal(extensionIdentity("connector", "files", [install()]), LOCAL_IDENTITY);
  assert.equal(extensionIdentity("app", "notes", [install()]), LOCAL_IDENTITY);
});

test("one installed from a Registry is its catalogue, kind, slug and repository", () => {
  assert.equal(extensionIdentity("app", "files", [install()]), FILES);
});

test("a new version, commit, tag, floor or folder from the same repository is the same extension", () => {
  const update = install({
    version: "2.0.0",
    gitTag: null,
    commitSha: "b".repeat(40),
    requiresMixOS: "0.4.0",
    repository: { owner: "acme", name: "mixos-files", subpath: "apps/files" },
  });
  assert.equal(extensionIdentity("app", "files", [update]), FILES);
});

test("a folder modified locally is still the extension its record names", () => {
  assert.equal(extensionIdentity("app", "files", [install({ modified: true })]), FILES);
});

test("the owner and the repository name match as GitHub matches them, without case", () => {
  const renamed = install({ repository: { owner: "ACME", name: "MixOS-Files", subpath: null } });
  assert.equal(extensionIdentity("app", "files", [renamed]), FILES);
});

test("another repository, owner or catalogue is a different extension", () => {
  for (const other of [
    install({ repository: { owner: "acme", name: "files-fork", subpath: null } }),
    install({ repository: { owner: "mallory", name: "mixos-files", subpath: null } }),
    install({ source: "http://localhost:4321" }),
  ]) {
    assert.notEqual(extensionIdentity("app", "files", [other]), FILES);
  }
});

test("a recorded identity reads back", () => {
  assert.deepEqual(parseIdentity(LOCAL_IDENTITY), { local: true });
  assert.deepEqual(parseIdentity(FILES), {
    local: false,
    source: "https://mixos.org",
    kind: "app",
    slug: "files",
    owner: "acme",
    name: "mixos-files",
  });
  for (const text of ["", "Local", "https://mixos.org app/files", "https://mixos.org plugin/files a/b", "a b/c/d e/f", "a b/c d/e/f", "a b/c d/e x"]) {
    assert.equal(parseIdentity(text), null, text);
  }
});

test("an audit row records it as local, or with the repository spelled out", () => {
  assert.equal(identityDetails(LOCAL_IDENTITY), "local");
  assert.deepEqual(identityDetails(FILES), {
    source: "https://mixos.org",
    kind: "app",
    slug: "files",
    repository: { owner: "acme", name: "mixos-files" },
  });
  assert.equal(identityDetails("something else"), "something else");
  assert.equal(identityDetails(null), null);
});

test("an admin reads it in a few words", () => {
  assert.equal(describeIdentity(LOCAL_IDENTITY), "local, with no install record");
  assert.equal(describeIdentity(FILES), "from mixos.org, acme/mixos-files");
  assert.equal(describeIdentity("http://localhost:4321 app/files acme/mixos-files"), "from localhost:4321, acme/mixos-files");
  assert.equal(describeIdentity(null), "not recorded");
  assert.equal(describeIdentity("??"), "recorded in a form this version doesn't read");
});

test("a connector's and a theme's are kept under their own platform_settings keys", () => {
  assert.equal(identitySettingKey("connector", "acme-crm"), "connector.identity.acme-crm");
  assert.equal(identitySettingKey("theme", "dusk"), "theme.identity.dusk");
});
