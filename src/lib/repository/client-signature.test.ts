/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `fetchInstallManifest` refuses a manifest it can't verify the catalogue
 * signed, as it arrives, before anything reads it. See ./release-signature.ts.
 */

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type net from "node:net";
import { RepositoryError, fetchInstallManifest } from "./client";
import { TEST_REPOSITORY_KEYS, signedForTest } from "./test-signing";

const commitSha = "3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39";
const MANIFEST = signedForTest({
  kind: "app",
  slug: "standup",
  name: "Standup",
  version: "1.2.0",
  commitSha,
  gitTag: "v1.2.0",
  tarballUrl: `https://codeload.github.com/acme/standup/tar.gz/${commitSha}`,
  contentHash: "sha256-PLACEHOLDER-standup",
  subpath: null,
  permissions: [],
  requiresMixOS: null,
  yanked: false,
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** A catalogue on this machine answering `body`, trusted with `keys`, until the test ends. */
async function serve(t: TestContext, body: unknown, keys: string | undefined): Promise<void> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  const previous = { url: process.env.MIXOS_REPOSITORY_URL, keys: process.env.MIXOS_REPOSITORY_KEYS };
  process.env.MIXOS_REPOSITORY_URL = `http://127.0.0.1:${port}`;
  restore("MIXOS_REPOSITORY_KEYS", keys);
  t.after(() => {
    server.closeAllConnections();
    server.close();
    restore("MIXOS_REPOSITORY_URL", previous.url);
    restore("MIXOS_REPOSITORY_KEYS", previous.keys);
  });
}

const refused = (failure: string, message: RegExp) => (err: unknown) =>
  err instanceof RepositoryError && err.failure === failure && message.test(err.message);

test("a manifest signed with a trusted key is read", async (t) => {
  await serve(t, MANIFEST, TEST_REPOSITORY_KEYS);
  assert.equal((await fetchInstallManifest("app", "standup", "1.2.0")).commitSha, commitSha);
});

test("a manifest with no signature is refused as unsigned", async (t) => {
  const unsigned: Record<string, unknown> = { ...MANIFEST };
  delete unsigned.signature;
  await serve(t, unsigned, TEST_REPOSITORY_KEYS);
  await assert.rejects(fetchInstallManifest("app", "standup", "1.2.0"), refused("unsigned", /isn't signed/));
});

test("a manifest changed after it was signed is refused", async (t) => {
  const swapped = "f".repeat(40);
  await serve(
    t,
    { ...MANIFEST, commitSha: swapped, tarballUrl: `https://codeload.github.com/acme/standup/tar.gz/${swapped}` },
    TEST_REPOSITORY_KEYS,
  );
  await assert.rejects(fetchInstallManifest("app", "standup", "1.2.0"), refused("unsigned", /doesn't match the release/));
});

test("a development catalogue's key isn't trusted unless MIXOS_REPOSITORY_KEYS names it", async (t) => {
  await serve(t, MANIFEST, undefined);
  await assert.rejects(fetchInstallManifest("app", "standup", "1.2.0"), refused("unsigned", /doesn't trust/));
});

test("a malformed MIXOS_REPOSITORY_KEYS is a configuration error, not trust", async (t) => {
  await serve(t, MANIFEST, "nonsense");
  await assert.rejects(fetchInstallManifest("app", "standup", "1.2.0"), refused("config", /MIXOS_REPOSITORY_KEYS/));
});
