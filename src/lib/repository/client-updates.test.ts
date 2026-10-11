/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The update check's request, `checkUpdates()`, against a catalogue on this
 * machine: what it sends, how it reads the answer, and each way it can fail.
 * It is `requestJson()`'s one POST, so this is also where a POST's rules are
 * shown: no redirect is ever followed, and a Retry-After is passed on.
 */

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type net from "node:net";
import { RepositoryError, checkUpdates, parseRetryAfter, requestJson } from "./client";
import type { UpdateItem } from "./types";

const INSTANCE = "3f2b9c10-5d1e-4f6a-9b7c-2d4e6f8a0b1c";
const ITEMS: UpdateItem[] = [
  { kind: "app", slug: "files", version: "1.2.0" },
  { kind: "connector", slug: "relay", version: "3e1f0a2" },
];

interface Seen {
  method: string;
  url: string;
  type: string | undefined;
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
      const entry = { method: req.method ?? "", url: req.url ?? "/", type: req.headers["content-type"], body };
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

/** mixos.org's answer for one item, every field as its endpoint sends it. */
function entry(item: UpdateItem, over: Record<string, unknown> = {}) {
  return {
    kind: item.kind,
    slug: item.slug,
    listingStatus: "published",
    installedVersion: item.version,
    installedYanked: false,
    installedYankedReason: null,
    latestVersion: item.version,
    latestGitTag: null,
    latestCommitSha: "9f2b4c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39",
    latestContentHash: "sha256-K7tY0XOkXkPq0yJcq5lK3m9T0p5c2h8G1vR4aW6bN2E=",
    latestReleasedAt: "2026-09-30T12:00:00+00:00",
    latestRequiresMixOS: null,
    differsFromInstalled: false,
    tarballUrl: "https://codeload.github.com/acme/files/tar.gz/9f2b4c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39",
    ...over,
  };
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

// ── what is sent ────────────────────────────────────────────────────────────

test("it sends the instance ID and each item's kind, slug and version, and nothing else", async (t) => {
  const site = await catalogue(t, (_req, res) =>
    json(res, 200, { checkedAt: "2026-10-11T09:14:03.120Z", items: ITEMS.map((i) => entry(i)) }),
  );
  useCatalogue(t, site.origin);

  // A caller's objects can carry more than the three fields; none of it is sent.
  const loaded = ITEMS.map((i) => ({ ...i, source: site.origin, modified: true, mixosVersion: "0.1.0" }));
  const answer = await checkUpdates(INSTANCE, loaded);

  assert.equal(site.seen.length, 1);
  const [request] = site.seen;
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/api/v1/updates");
  assert.equal(request.type, "application/json");
  const body = JSON.parse(request.body);
  assert.deepEqual(body, { instanceId: INSTANCE, items: ITEMS });
  assert.deepEqual(Object.keys(body), ["instanceId", "items"]);
  for (const item of body.items) assert.deepEqual(Object.keys(item), ["kind", "slug", "version"]);

  assert.equal(answer.checkedAt, "2026-10-11T09:14:03.120Z");
  assert.deepEqual(
    answer.items.map((i) => `${i.kind}/${i.slug}@${i.installedVersion}`),
    ["app/files@1.2.0", "connector/relay@3e1f0a2"],
  );
  // Read for the notices only: no download URL or hash is kept from it.
  for (const item of answer.items) {
    assert.ok(!("tarballUrl" in item) && !("latestContentHash" in item) && !("latestCommitSha" in item));
  }
});

test("a malformed entry is dropped, and the rest of the answer kept", async (t) => {
  const site = await catalogue(t, (_req, res) =>
    json(res, 200, {
      items: [
        entry(ITEMS[0], { installedYanked: true, installedYankedReason: "Data loss" }),
        { ...entry(ITEMS[1]), installedYanked: "yes" },
        { kind: "plugin", slug: "x" },
        "not an object",
        null,
        entry({ kind: "theme", slug: "dusk", version: "1.0.0" }, { listingStatus: "archived", newField: 1 }),
      ],
    }),
  );
  useCatalogue(t, site.origin);

  const answer = await checkUpdates(INSTANCE, ITEMS);
  assert.deepEqual(
    answer.items.map((i) => [i.slug, i.installedYanked, i.listingStatus]),
    [
      ["files", true, "published"],
      ["dusk", false, "archived"],
    ],
  );
  assert.equal(answer.items[0].installedYankedReason, "Data loss");
  assert.equal(answer.checkedAt, null);
});

test("an answer with no items list is malformed", async (t) => {
  const site = await catalogue(t, (_req, res) => json(res, 200, { checkedAt: "now" }));
  useCatalogue(t, site.origin);
  await assert.rejects(checkUpdates(INSTANCE, ITEMS), failure("malformed"));
});

// ── how it fails ────────────────────────────────────────────────────────────

test("a 503 is a status failure that carries its Retry-After", async (t) => {
  let headers: Record<string, string> = {};
  const site = await catalogue(t, (_req, res) =>
    json(res, 503, { error: { code: "service_unavailable", message: "The MixOS Registry API is temporarily unavailable." } }, headers),
  );
  useCatalogue(t, site.origin);

  headers = { "retry-after": "3600" };
  await assert.rejects(checkUpdates(INSTANCE, ITEMS), (err: unknown) => {
    failure("status", 503)(err);
    assert.equal((err as RepositoryError).retryAfterSeconds, 3600);
    // The other end's message is not repeated.
    assert.doesNotMatch((err as Error).message, /temporarily/);
    return true;
  });

  headers = { "retry-after": new Date(Date.now() + 7200_000).toUTCString() };
  await assert.rejects(checkUpdates(INSTANCE, ITEMS), (err: unknown) => {
    const seconds = (err as RepositoryError).retryAfterSeconds ?? 0;
    assert.ok(seconds > 7100 && seconds <= 7200, String(seconds));
    return true;
  });

  headers = {};
  await assert.rejects(checkUpdates(INSTANCE, ITEMS), (err: unknown) => {
    failure("status", 503)(err);
    assert.equal((err as RepositoryError).retryAfterSeconds, undefined);
    return true;
  });
});

test("Retry-After reads seconds or a date, and nothing else", () => {
  const now = Date.parse("2026-10-11T12:00:00Z");
  assert.equal(parseRetryAfter("120", now), 120);
  assert.equal(parseRetryAfter(" 0 ", now), 0);
  assert.equal(parseRetryAfter("Sun, 11 Oct 2026 13:00:00 GMT", now), 3600);
  assert.equal(parseRetryAfter("Sun, 11 Oct 2026 11:00:00 GMT", now), 0);
  for (const value of [null, "", "soon", "-5", "1.5"]) assert.equal(parseRetryAfter(value, now), undefined, String(value));
});

test("an answer that isn't JSON, or is over 4 MB, is malformed", async (t) => {
  let reply: (res: http.ServerResponse) => void = () => {};
  const site = await catalogue(t, (_req, res) => reply(res));
  useCatalogue(t, site.origin);

  reply = (res) => res.writeHead(200, { "content-type": "text/html" }).end("<html>");
  await assert.rejects(checkUpdates(INSTANCE, ITEMS), failure("malformed"));

  reply = (res) => res.writeHead(200).end(Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
  await assert.rejects(checkUpdates(INSTANCE, ITEMS), failure("malformed"));
});

test("no answer, or no whole answer, within 8 seconds is unreachable", async (t) => {
  const site = await catalogue(t, (req, res) => {
    // /stall: the headers and a first chunk, then nothing.
    if (req.url.startsWith("/api/v1/updates?stall")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"items": [');
    }
    // Otherwise, nothing at all.
  });
  useCatalogue(t, site.origin);

  const started = Date.now();
  await Promise.all([
    assert.rejects(checkUpdates(INSTANCE, ITEMS), failure("unreachable")),
    assert.rejects(
      requestJson("/api/v1/updates", { method: "POST", params: new URLSearchParams("stall"), body: {} }),
      failure("unreachable"),
    ),
  ]);
  const took = Date.now() - started;
  assert.ok(took >= 7_500 && took < 15_000, `${took}ms`);
});

test("a catalogue that isn't there is unreachable", async (t) => {
  // A port that was free a moment ago, and is closed again.
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  useCatalogue(t, `http://127.0.0.1:${port}`);
  await assert.rejects(checkUpdates(INSTANCE, ITEMS), failure("unreachable"));
});

// ── redirects ───────────────────────────────────────────────────────────────

test("any 3xx to the POST is a failure, and where it points is never asked", async (t) => {
  let status = 302;
  let location: string | null = null;
  const site = await catalogue(t, (req, res) => {
    if (req.url !== "/api/v1/updates") return json(res, 200, { items: [] });
    res.writeHead(status, location === null ? {} : { location });
    res.end();
  });
  useCatalogue(t, site.origin);

  // To the same origin, which a GET would follow: a 307 or 308 would send the
  // body again, and a 301, 302 or 303 would drop it.
  for (const code of [301, 302, 303, 307, 308]) {
    status = code;
    location = "/api/v1/updates-moved";
    await assert.rejects(checkUpdates(INSTANCE, ITEMS), (err: unknown) => {
      failure("status", code)(err);
      assert.match((err as Error).message, /never redirected/);
      assert.doesNotMatch((err as Error).message, /updates-moved/);
      return true;
    });
  }
  // With no Location, or a status fetch doesn't follow, it is an answer that isn't a success.
  for (const [code, where] of [[302, null], [300, "/x"], [304, null]] as const) {
    status = code;
    location = where;
    await assert.rejects(checkUpdates(INSTANCE, ITEMS), failure("status", code));
  }
  assert.deepEqual(
    site.seen.filter((s) => s.url !== "/api/v1/updates"),
    [],
  );
});

test("a redirect to another host, or from https to http, is refused for the POST too", async (t) => {
  const elsewhere = await catalogue(t, (_req, res) => json(res, 200, { items: [] }));
  let to = "";
  const site = await catalogue(t, (_req, res) => {
    res.writeHead(307, { location: to });
    res.end();
  });

  useCatalogue(t, site.origin);
  to = `${elsewhere.origin}/api/v1/updates`;
  await assert.rejects(checkUpdates(INSTANCE, ITEMS), failure("status", 307));

  const secure = `https://127.0.0.1:${site.port}`;
  terminateTls(t, site.port);
  useCatalogue(t, secure);
  to = `http://127.0.0.1:${site.port}/api/v1/updates`;
  await assert.rejects(checkUpdates(INSTANCE, ITEMS), failure("status", 307));

  assert.deepEqual(elsewhere.seen, []);
  assert.equal(site.seen.length, 2);
});

test("a path that would leave the catalogue is refused before anything is sent", async (t) => {
  const elsewhere = await catalogue(t, (_req, res) => json(res, 200, { items: [] }));
  const site = await catalogue(t, (_req, res) => json(res, 200, { items: [] }));
  useCatalogue(t, site.origin);

  for (const path of [`//127.0.0.1:${elsewhere.port}/api/v1/updates`, `${elsewhere.origin}/api/v1/updates`]) {
    await assert.rejects(requestJson(path, { method: "POST", body: {} }), failure("config"), path);
  }
  assert.deepEqual(elsewhere.seen, []);
  assert.deepEqual(site.seen, []);
});
