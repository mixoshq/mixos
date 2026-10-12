/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The release check's request, `fetchCoreReleases()`, against a catalogue on
 * this machine that answers `GET /api/v1/mixos/releases` as mixos.org does
 * (src/pages/api/v1/mixos/releases.ts and src/lib/core-releases.mjs there):
 * what it sends, how it reads the list, and each way it can fail. Also that
 * the 512 KB cap and the `User-Agent` are this request's alone.
 */

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type net from "node:net";
import {
  CORE_RELEASES_MAX_BYTES,
  RepositoryError,
  fetchCoreReleases,
  requestJson,
  searchRepository,
} from "./client";

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A catalogue on this machine that records each request and answers with `reply`. */
async function catalogue(
  t: TestContext,
  reply: (req: Seen, res: http.ServerResponse) => void,
): Promise<{ origin: string; port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      const entry = { method: req.method ?? "", url: req.url ?? "/", headers: req.headers, body };
      seen.push(entry);
      reply(entry, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address() as net.AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, port, seen };
}

function useCatalogue(t: TestContext, origin: string): void {
  const previous = process.env.MIXOS_REPOSITORY_URL;
  process.env.MIXOS_REPOSITORY_URL = origin;
  t.after(() => {
    if (previous === undefined) delete process.env.MIXOS_REPOSITORY_URL;
    else process.env.MIXOS_REPOSITORY_URL = previous;
  });
}

/** Make `https://127.0.0.1:<port>` reach the plaintext server on that port: see client-redirects.test.ts. */
function terminateTls(t: TestContext, port: number): void {
  const secure = `https://127.0.0.1:${port}`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin === secure) url.protocol = "http:";
    return realFetch(url, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
}

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/** A RepositoryError with this failure, and status when given. */
function failure(kind: RepositoryError["failure"], status?: number) {
  return (err: unknown) => {
    assert.ok(err instanceof RepositoryError, `expected a RepositoryError, got: ${String(err)}`);
    assert.equal(err.failure, kind, err.message);
    if (status !== undefined) assert.equal(err.status, status);
    return true;
  };
}

/** mixos.org's list as it is today (src/data/core-releases.json there). */
const FIRST_RELEASE = {
  tag: "v0.1.0",
  commitSha: "3d8ff03eb7acd9cd5da34e183f7e5ea360400a3b",
  publishedAt: "2026-10-11T03:52:59Z",
  prerelease: false,
  notes:
    "The first tagged release of MixOS. What changed on the way here is in [WHATS-NEW.md](https://github.com/mixoshq/mixos/blob/v0.1.0/WHATS-NEW.md).",
};

const release = (tag: string, over: Record<string, unknown> = {}) => ({
  tag,
  commitSha: "9f2b4c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39",
  publishedAt: "2026-10-20T09:00:00Z",
  prerelease: tag.includes("-"),
  notes: `### Fixes\n\n- the notes for ${tag}`,
  ...over,
});

// ── what is sent ────────────────────────────────────────────────────────────

test("a GET with User-Agent: MixOS and nothing about this instance, and mixos.org's list parsed", async (t) => {
  const site = await catalogue(t, (_req, res) => json(res, 200, { releases: [FIRST_RELEASE] }));
  useCatalogue(t, site.origin);

  const list = await fetchCoreReleases();

  assert.equal(site.seen.length, 1);
  const [request] = site.seen;
  assert.equal(request.method, "GET");
  assert.equal(request.url, "/api/v1/mixos/releases");
  assert.equal(request.body, "");
  assert.equal(request.headers["user-agent"], "MixOS");
  assert.equal(request.headers.accept, "application/json");
  for (const header of ["cookie", "authorization", "content-type", "content-length", "referer"]) {
    assert.equal(request.headers[header], undefined, header);
  }

  assert.deepEqual(list, { releases: [FIRST_RELEASE], ignored: 0 });
});

test("the other catalogue requests are as they were: no MixOS User-Agent, and the 4 MB cap", async (t) => {
  // A page of search results a little over 512 KB, which the release list's cap would refuse.
  const page = { items: [], page: 1, pageSize: 24, total: 0, padding: "x".repeat(600 * 1024) };
  const site = await catalogue(t, (_req, res) => json(res, 200, page));
  useCatalogue(t, site.origin);

  await searchRepository({ kind: "app" });
  assert.notEqual(site.seen[0].headers["user-agent"], "MixOS");
  assert.match(site.seen[0].headers["user-agent"] ?? "", /\S/);
});

// ── how it reads the list ───────────────────────────────────────────────────

test("a malformed entry is left out, and the rest of the list kept", async (t) => {
  const notesAtCap = "é".repeat(10 * 1024); // 20 KB in UTF-8, 10 K characters
  const site = await catalogue(t, (_req, res) =>
    json(res, 200, {
      releases: [
        release("v0.3.0", { changelogUrl: "https://evil.example/", notes: notesAtCap }),
        release("v0.2.1", { notes: `${notesAtCap}a` }),
        release("v0.2.0", { commitSha: "9f2b4c1" }),
        release("v0.1.9", { commitSha: "9F2B4C1D8E7B6A5F4E3D2C1B0A9F8E7D6C5B4A39" }),
        release("v0.1.8", { publishedAt: "yesterday" }),
        release("v0.1.7", { prerelease: "false" }),
        release("v0.1.6", { notes: null }),
        release("v0.1.5", { tag: undefined }),
        release("0.1.4"),
        release("v0.1.4 "),
        release("v0.1.3-rc..1"),
        release("v01.1.3"),
        release("v0.1.3+build"),
        release("v0.1.3-rc-1"),
        release("V0.1.3"),
        "v0.1.2",
        null,
        [release("v0.1.1")],
        release("v0.2.0-rc.1", { publishedAt: "2026-10-18T09:00:00+00:00" }),
        FIRST_RELEASE,
      ],
      generatedAt: "2026-10-20T09:00:00Z",
    }),
  );
  useCatalogue(t, site.origin);

  const list = await fetchCoreReleases();
  assert.deepEqual(
    list.releases.map((r) => r.tag),
    ["v0.3.0", "v0.2.0-rc.1", "v0.1.0"],
  );
  assert.equal(list.ignored, 17);
  // Unknown keys are dropped, and notes at exactly 20 KB are kept whole.
  assert.deepEqual(Object.keys(list.releases[0]).sort(), ["commitSha", "notes", "prerelease", "publishedAt", "tag"]);
  assert.equal(list.releases[0].notes, notesAtCap);
});

test("a list that isn't one is malformed", async (t) => {
  let body: unknown = {};
  const site = await catalogue(t, (_req, res) => json(res, 200, body));
  useCatalogue(t, site.origin);

  for (const answer of [{}, { releases: "v0.1.0" }, { releases: { tag: "v0.1.0" } }, [FIRST_RELEASE], null, "v0.1.0"]) {
    body = answer;
    await assert.rejects(fetchCoreReleases(), failure("malformed"), JSON.stringify(answer));
  }
  body = { releases: [] };
  assert.deepEqual(await fetchCoreReleases(), { releases: [], ignored: 0 });
});

// ── how it fails ────────────────────────────────────────────────────────────

test("an answer that isn't JSON, or is over 512 KB, is malformed", async (t) => {
  let reply: (res: http.ServerResponse) => void = () => {};
  const site = await catalogue(t, (_req, res) => reply(res));
  useCatalogue(t, site.origin);

  reply = (res) => res.writeHead(200, { "content-type": "text/html" }).end("<html>");
  await assert.rejects(fetchCoreReleases(), failure("malformed"));

  // 512 KB is the whole list's cap on mixos.org, so a list that size is read…
  const filler = (bytes: number) => {
    const body = JSON.stringify({ releases: [FIRST_RELEASE], padding: "" });
    return body.replace('"padding":""', `"padding":"${"x".repeat(bytes - body.length)}"`);
  };
  assert.equal(Buffer.byteLength(filler(CORE_RELEASES_MAX_BYTES)), 512 * 1024);
  reply = (res) => res.writeHead(200, { "content-type": "application/json" }).end(filler(CORE_RELEASES_MAX_BYTES));
  assert.equal((await fetchCoreReleases()).releases.length, 1);

  // …and one byte more is not.
  reply = (res) => res.writeHead(200, { "content-type": "application/json" }).end(filler(CORE_RELEASES_MAX_BYTES + 1));
  await assert.rejects(fetchCoreReleases(), (err: unknown) => {
    failure("malformed")(err);
    assert.match((err as Error).message, /exceeded 524288 bytes/);
    return true;
  });
});

test("a cap asked for above 4 MB is cut to 4 MB", async (t) => {
  const site = await catalogue(t, (_req, res) => res.writeHead(200).end(Buffer.alloc(4 * 1024 * 1024 + 1, 0x20)));
  useCatalogue(t, site.origin);
  await assert.rejects(requestJson("/api/v1/mixos/releases", { maxBytes: 64 * 1024 * 1024 }), failure("malformed"));
  await assert.rejects(requestJson("/api/v1/mixos/releases", { maxBytes: Number.NaN }), failure("malformed"));
});

test("a 404 is not-found, and a refusal carries its Retry-After, as seconds or a date", async (t) => {
  let status = 404;
  let headers: Record<string, string> = {};
  const site = await catalogue(t, (_req, res) => json(res, status, { error: { code: "x", message: "Slow down." } }, headers));
  useCatalogue(t, site.origin);

  await assert.rejects(fetchCoreReleases(), failure("not-found", 404));

  // Cloudflare's rate limit in front of mixos.org, and the API's own switch.
  for (const code of [429, 403, 503]) {
    status = code;
    headers = { "retry-after": "120" };
    await assert.rejects(fetchCoreReleases(), (err: unknown) => {
      failure("status", code)(err);
      assert.equal((err as RepositoryError).retryAfterSeconds, 120);
      assert.doesNotMatch((err as Error).message, /Slow down/);
      return true;
    });
  }
  status = 429;
  headers = { "retry-after": new Date(Date.now() + 3600_000).toUTCString() };
  await assert.rejects(fetchCoreReleases(), (err: unknown) => {
    const seconds = (err as RepositoryError).retryAfterSeconds ?? 0;
    assert.ok(seconds > 3500 && seconds <= 3600, String(seconds));
    return true;
  });
});

test("no answer, or no whole answer, within 8 seconds is unreachable", async (t) => {
  const site = await catalogue(t, (_req, res) => {
    // The headers and the start of a list, then nothing.
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"releases": [');
  });
  useCatalogue(t, site.origin);

  const started = Date.now();
  await assert.rejects(fetchCoreReleases(), failure("unreachable"));
  const took = Date.now() - started;
  assert.ok(took >= 7_500 && took < 15_000, `${took}ms`);
});

// ── redirects ───────────────────────────────────────────────────────────────

test("a redirect within the catalogue is followed, with the same User-Agent", async (t) => {
  const site = await catalogue(t, (req, res) => {
    if (req.url === "/api/v1/mixos/releases") {
      res.writeHead(308, { location: "/api/v1/mixos/releases/" });
      return res.end();
    }
    json(res, 200, { releases: [FIRST_RELEASE] });
  });
  useCatalogue(t, site.origin);

  assert.equal((await fetchCoreReleases()).releases.length, 1);
  assert.deepEqual(
    site.seen.map((s) => [s.url, s.headers["user-agent"]]),
    [
      ["/api/v1/mixos/releases", "MixOS"],
      ["/api/v1/mixos/releases/", "MixOS"],
    ],
  );
});

test("a redirect to another host, or from https to http, is refused before anything is sent there", async (t) => {
  const elsewhere = await catalogue(t, (_req, res) => json(res, 200, { releases: [FIRST_RELEASE] }));
  let to = "";
  const site = await catalogue(t, (_req, res) => {
    res.writeHead(302, { location: to });
    res.end();
  });

  useCatalogue(t, site.origin);
  to = `${elsewhere.origin}/api/v1/mixos/releases`;
  await assert.rejects(fetchCoreReleases(), (err: unknown) => {
    failure("status", 302)(err);
    // Where it pointed is the other end's choice, and isn't repeated.
    assert.doesNotMatch((err as Error).message, new RegExp(String(elsewhere.port)));
    return true;
  });

  const secure = `https://127.0.0.1:${site.port}`;
  terminateTls(t, site.port);
  useCatalogue(t, secure);
  to = `http://127.0.0.1:${site.port}/api/v1/mixos/releases`;
  await assert.rejects(fetchCoreReleases(), failure("status", 302));

  assert.deepEqual(elsewhere.seen, []);
  assert.equal(site.seen.length, 2);
});
