/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the App may do, what each token asks for, the manifest that creates the
 * App, and the identifiers allowed into a path.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  UPSTREAM_REPOSITORY_ID,
  isAppName,
  isBranchName,
  isLogin,
  isManifestCode,
  isRepositoryName,
  isUpstream,
} from "./identifiers";
import {
  APP_PERMISSIONS,
  LISTING_PERMISSIONS,
  TOKEN_SHAPES,
  appManifest,
  appSettingsUrl,
  defaultAppName,
  installationSettingsUrl,
  newAppUrl,
  permissionsWithin,
  tokenPermissionsMatch,
} from "./manifest";

test("the App asks for exactly contents and pull requests to write, checks, statuses and metadata to read", () => {
  assert.deepEqual(APP_PERMISSIONS, {
    contents: "write",
    pull_requests: "write",
    metadata: "read",
    checks: "read",
    statuses: "read",
  });
  for (const never of ["workflows", "administration", "actions", "secrets", "members", "organization_administration"]) {
    assert.equal(never in APP_PERMISSIONS, false, never);
  }
});

test("the two token shapes, and the listing token, ask for no more than they need", () => {
  assert.deepEqual(TOKEN_SHAPES.write, { contents: "write", pull_requests: "write" });
  assert.deepEqual(TOKEN_SHAPES.read, { contents: "read", checks: "read", statuses: "read", pull_requests: "read" });
  assert.deepEqual(LISTING_PERMISSIONS, { metadata: "read" });
  for (const shape of [TOKEN_SHAPES.write, TOKEN_SHAPES.read, LISTING_PERMISSIONS]) {
    assert.ok(permissionsWithin(shape, APP_PERMISSIONS));
  }
});

test("the manifest: private, those permissions, no events, an inactive webhook, URLs on this instance", () => {
  const manifest = appManifest("https://mixos.example.com", "MixOS mixos.example.com");
  assert.equal(manifest.public, false);
  assert.deepEqual(manifest.default_permissions, APP_PERMISSIONS);
  assert.deepEqual(manifest.default_events, []);
  assert.equal(manifest.hook_attributes.active, false);
  assert.equal(manifest.redirect_url, "https://mixos.example.com/api/admin/github/created");
  assert.equal(manifest.setup_url, "https://mixos.example.com/api/admin/github/installed");
  assert.equal(manifest.setup_on_update, true);
  assert.equal(manifest.request_oauth_on_install, false);
  assert.ok(manifest.hook_attributes.url.startsWith("https://mixos.example.com/"));
  // Exactly these keys: nothing GitHub would read as a callback or an event.
  assert.deepEqual(Object.keys(manifest).sort(), [
    "default_events",
    "default_permissions",
    "description",
    "hook_attributes",
    "name",
    "public",
    "redirect_url",
    "request_oauth_on_install",
    "setup_on_update",
    "setup_url",
    "url",
  ]);
});

test("where the manifest is posted, and the App's and installation's settings, for a user and an organization", () => {
  assert.equal(newAppUrl({ type: "user" }, "s t/ate"), "https://github.com/settings/apps/new?state=s%20t%2Fate");
  assert.equal(
    newAppUrl({ type: "organization", login: "acme-org" }, "abc"),
    "https://github.com/organizations/acme-org/settings/apps/new?state=abc",
  );
  assert.equal(appSettingsUrl({ login: "acme", type: "User" }, "mixos-app"), "https://github.com/settings/apps/mixos-app");
  assert.equal(
    appSettingsUrl({ login: "acme-org", type: "Organization" }, "mixos-app"),
    "https://github.com/organizations/acme-org/settings/apps/mixos-app",
  );
  assert.equal(installationSettingsUrl({ login: "acme", type: "User" }, 7), "https://github.com/settings/installations/7");
});

test("the default name fits GitHub's 34 characters", () => {
  assert.equal(defaultAppName("https://mixos.example.com"), "MixOS mixos.example.com");
  const long = defaultAppName("https://a-very-long-subdomain-name.of-some-company.example.com");
  assert.ok(long.length <= 34 && isAppName(long), long);
  assert.equal(defaultAppName("not a url"), "MixOS");
});

test("permissions: read is within write, nothing outside the App's is, and a token answer matches only what was asked", () => {
  assert.ok(permissionsWithin({ contents: "read", metadata: "read" }, APP_PERMISSIONS));
  assert.ok(!permissionsWithin({ workflows: "write" }, APP_PERMISSIONS));
  assert.ok(!permissionsWithin({ checks: "write" }, APP_PERMISSIONS));
  assert.ok(!permissionsWithin({ administration: "read" }, APP_PERMISSIONS));

  const read = TOKEN_SHAPES.read;
  assert.ok(tokenPermissionsMatch({ ...read, metadata: "read" }, read));
  assert.ok(tokenPermissionsMatch({ ...read }, read));
  assert.ok(!tokenPermissionsMatch({ ...read, contents: "write" }, read));
  assert.ok(!tokenPermissionsMatch({ ...read, workflows: "write" }, read));
  assert.ok(!tokenPermissionsMatch({ contents: "read" }, read));
  assert.ok(!tokenPermissionsMatch({ ...read, metadata: "write" }, read));
});

test("upstream MixOS is one repository id, compared as an id", () => {
  assert.equal(UPSTREAM_REPOSITORY_ID, 1345491436);
  assert.ok(isUpstream(1345491436));
  assert.ok(!isUpstream(1345491437));
});

test("identifiers that reach a path are GitHub's own shapes, and nothing stranger", () => {
  for (const ok of ["acme", "acme-org", "a", "A1-b2", "x".repeat(39)]) assert.ok(isLogin(ok), ok);
  for (const bad of ["", "-acme", "ac me", "acme/x", "x".repeat(40), "acme.org", "%2e"]) assert.ok(!isLogin(bad), bad);
  for (const ok of ["mixos", "mixos.org", "my_repo-2", ".github"]) assert.ok(isRepositoryName(ok), ok);
  for (const bad of ["", ".", "..", "a/b", "a b", "x".repeat(101), "a%2f"]) assert.ok(!isRepositoryName(bad), bad);
  for (const ok of ["main", "master", "release/1.0", "dev_2"]) assert.ok(isBranchName(ok), ok);
  for (const bad of ["", "a..b", "a//b", "a/", "/a", "-a", "a.lock", "a/.hidden", "a b", "a:b", "a~1", "a^", "a?"]) {
    assert.ok(!isBranchName(bad), bad);
  }
  assert.ok(isManifestCode("a180b1a3d263c81bc6441d7b990bae27d4c10679"));
  for (const bad of ["", "short", "a/b/c/d/e/f", "../../app", "x".repeat(129)]) assert.ok(!isManifestCode(bad), bad);
  assert.ok(isAppName("MixOS mixos.example.com"));
  for (const bad of ["", " padded ", "x".repeat(35), "a\nb", "a‮b"]) assert.ok(!isAppName(bad), JSON.stringify(bad));
});
