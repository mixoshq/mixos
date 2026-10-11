/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A download's redirects. GitHub answers for an archive on api.github.com with
 * a redirect to codeload.github.com, so a download follows redirects, by hand,
 * and puts each one through the same checks as the URL it started from.
 *
 * Downloads go only to GitHub, over https, so these replace `fetch` with one
 * that answers as GitHub would and records what it was asked.
 */

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { SourceFetchError, fetchExtensionTree } from "./fetch-source";

const commitSha = "3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39";
const API = `https://api.github.com/repos/acme/standup/tarball/${commitSha}`;
const CODELOAD = `https://codeload.github.com/acme/standup/legacy.tar.gz/${commitSha}`;

/** A gzipped ustar archive of one file, under one top-level folder as GitHub's are. */
function archive(name: string, text: string): Uint8Array<ArrayBuffer> {
  const data = Buffer.from(text);
  const header = Buffer.alloc(512);
  header.write(`acme-standup-${commitSha.slice(0, 7)}/${name}`, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "latin1");
  header.write("0000000\0", 108, 8, "latin1");
  header.write("0000000\0", 116, 8, "latin1");
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12, "latin1");
  header.write("00000000000\0", 136, 12, "latin1");
  header.fill(0x20, 148, 156);
  header.write("0", 156, 1, "latin1");
  header.write("ustar\0", 257, 6, "latin1");
  header.write("00", 263, 2, "latin1");
  let sum = 0;
  for (const b of header) sum += b;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return new Uint8Array(zlib.gzipSync(Buffer.concat([header, data, pad, Buffer.alloc(1024)])));
}

const realFetch = globalThis.fetch;

/** Answer from `routes` until the test ends. Returns every URL asked for, in order. */
function github(t: TestContext, routes: Record<string, () => Response>): string[] {
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    asked.push(url);
    const route = routes[url];
    if (!route) throw new Error(`unexpected request to ${url}`);
    return route();
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  return asked;
}

const redirectTo = (location: string) => () =>
  new Response(null, { status: 302, headers: { location } });

const download = () => fetchExtensionTree({ tarballUrl: API, commitSha });

const refused = (pattern: RegExp) => (err: unknown) =>
  err instanceof SourceFetchError && pattern.test(err.message);

test("GitHub's redirect to codeload is followed, and the archive read from there", async (t) => {
  const asked = github(t, {
    [API]: redirectTo(CODELOAD),
    [CODELOAD]: () => new Response(archive("app.json", "{}")),
  });
  const entries = await download();
  assert.deepEqual(
    entries.map((e) => [e.path, e.data.toString()]),
    [["app.json", "{}"]],
  );
  assert.deepEqual(asked, [API, CODELOAD]);
});

test("each redirect goes back through the host allowlist, https and the commit pin", async (t) => {
  const cases: [string, RegExp][] = [
    [`https://objects.example.com/acme/standup/${commitSha}.tar.gz`, /only accepted from GitHub/],
    [`http://codeload.github.com/acme/standup/legacy.tar.gz/${commitSha}`, /must use https/],
    ["https://codeload.github.com/acme/standup/legacy.tar.gz/main", /not pinned to commit/],
  ];
  for (const [target, refusal] of cases) {
    const asked = github(t, { [API]: redirectTo(target) });
    await assert.rejects(download(), refused(refusal), target);
    assert.deepEqual(asked, [API], `${target} is not requested`);
  }
});

test("a download stops at its fourth redirect", async (t) => {
  const hop = (n: number) => `${CODELOAD}?hop=${n}`;
  const asked = github(t, {
    [API]: redirectTo(hop(1)),
    [hop(1)]: redirectTo(hop(2)),
    [hop(2)]: redirectTo(hop(3)),
    [hop(3)]: redirectTo(hop(4)),
  });
  await assert.rejects(download(), refused(/redirected more than 3 times/));
  assert.deepEqual(asked, [API, hop(1), hop(2), hop(3)]);
});
