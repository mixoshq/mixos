/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The catalogue client's requests, against a catalogue on this machine.
 *
 * Every one of them is made by `requestJson`, so these drive it through the
 * three GETs that use it: search, listing and install manifest. Each is shown
 * to read a direct answer as it always has, and to follow a redirect only
 * within the catalogue's own origin. Its one POST, the update check, follows
 * none: see client-updates.test.ts.
 */

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type net from "node:net";
import {
  RepositoryError,
  fetchExtension,
  fetchInstallManifest,
  searchRepository,
} from "./client";

// ── the catalogue ───────────────────────────────────────────────────────────

const commitSha = "3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39";

const summary = { slug: "standup", kind: "app", name: "Standup", author: { handle: "acme" } };

/** What each endpoint answers, by path. */
const ANSWERS: Record<string, unknown> = {
  "/api/v1/search": { items: [summary], page: 1, pageSize: 24, total: 1, totalPages: 1 },
  "/api/v1/apps/standup": {
    ...summary,
    sourceRepo: {
      host: "github",
      owner: "acme",
      name: "standup",
      url: "https://github.com/acme/standup",
    },
    releases: [],
  },
  "/api/v1/apps/standup/install": {
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
  },
};

/** The three GETs `requestJson` serves, and the request each one sends. */
const CALLS = [
  {
    name: "search",
    path: "/api/v1/search?kind=app&q=stand",
    run: async () => (await searchRepository({ kind: "app", q: "stand" })).items[0]?.slug,
  },
  {
    name: "listing",
    path: "/api/v1/apps/standup",
    run: async () => (await fetchExtension("app", "standup")).slug,
  },
  {
    name: "install manifest",
    path: "/api/v1/apps/standup/install?version=1.2.0",
    run: async () => (await fetchInstallManifest("app", "standup", "1.2.0")).slug,
  },
];

interface Catalogue {
  port: number;
  origin: string;
  /** The path and query of every request, in order. */
  seen: string[];
}

/** A server on this machine that records each request and answers with `reply`. */
async function catalogue(
  t: TestContext,
  reply: (url: string, res: http.ServerResponse) => void,
): Promise<Catalogue> {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    seen.push(url);
    reply(url, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address() as net.AddressInfo;
  return { port, origin: `http://127.0.0.1:${port}`, seen };
}

/** Answer as the catalogue does, wherever a redirect moved the `/api/v1/` part to. */
function answer(url: string, res: http.ServerResponse): void {
  const { pathname } = new URL(url.slice(url.indexOf("/api/v1/")), "http://catalogue");
  const body = ANSWERS[pathname];
  res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
  res.end(JSON.stringify(body ?? { error: "not found" }));
}

function redirect(res: http.ServerResponse, location: string, status = 302): void {
  res.writeHead(status, { location });
  res.end();
}

/** Point the client at `origin` until the test ends. */
function useCatalogue(t: TestContext, origin: string): void {
  const previous = process.env.MIXOS_REPOSITORY_URL;
  process.env.MIXOS_REPOSITORY_URL = origin;
  t.after(() => {
    if (previous === undefined) delete process.env.MIXOS_REPOSITORY_URL;
    else process.env.MIXOS_REPOSITORY_URL = previous;
  });
}

/**
 * Make `https://127.0.0.1:<port>` reach the plaintext server on that port until
 * the test ends: a stand-in for TLS termination.
 *
 * A real TLS server needs a certificate this process trusts, and a private key
 * committed to a public repository is noise for every secret scanner that reads
 * it. What is under test sits above the transport: the URL the client believes
 * it asked, and whether it follows a redirect away from it. Only the requests
 * the client makes itself come through here; a redirect that `fetch` follows on
 * its own goes wherever it points.
 */
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

/** A refused redirect: a `status` failure that names the catalogue and repeats none of `unsaid`. */
function refused(catalogueOrigin: string, reason: RegExp, ...unsaid: string[]) {
  return (err: unknown) => {
    assert.ok(err instanceof RepositoryError, `expected a RepositoryError, got: ${String(err)}`);
    assert.equal(err.failure, "status");
    assert.ok(err.message.includes(catalogueOrigin), `"${err.message}" names ${catalogueOrigin}`);
    assert.match(err.message, reason);
    for (const s of unsaid) assert.ok(!err.message.includes(s), `"${err.message}" repeats ${s}`);
    return true;
  };
}

// ── a direct answer ─────────────────────────────────────────────────────────

test("search, listing and install manifest each read a direct answer", async (t) => {
  const site = await catalogue(t, answer);
  useCatalogue(t, site.origin);

  for (const call of CALLS) assert.equal(await call.run(), "standup", call.name);
  assert.deepEqual(
    site.seen,
    CALLS.map((c) => c.path),
  );
});

test("a direct answer that is not a success is reported as it always was", async (t) => {
  let reply: (res: http.ServerResponse) => void = () => {};
  const site = await catalogue(t, (_url, res) => reply(res));
  useCatalogue(t, site.origin);

  const cases: [string, (res: http.ServerResponse) => void, string, number | undefined][] = [
    ["a 404", (res) => res.writeHead(404).end(), "not-found", 404],
    ["a 500", (res) => res.writeHead(500).end(), "status", 500],
    // With nowhere to go, a redirect is an answer, as it is to `fetch`.
    ["a redirect with no Location", (res) => res.writeHead(302).end(), "status", 302],
    ["a body that is not JSON", (res) => res.writeHead(200).end("<html>"), "malformed", undefined],
    [
      "a body over the 4 MB cap",
      (res) => res.writeHead(200).end(Buffer.alloc(4 * 1024 * 1024 + 1, 0x20)),
      "malformed",
      undefined,
    ],
  ];
  for (const [name, answerWith, failure, status] of cases) {
    reply = answerWith;
    await assert.rejects(
      searchRepository({ kind: "app" }),
      (err: unknown) =>
        err instanceof RepositoryError && err.failure === failure && err.status === status,
      name,
    );
  }
});

// ── redirects ───────────────────────────────────────────────────────────────

test("a redirect within the catalogue's origin is followed, by each call", async (t) => {
  const site = await catalogue(t, (url, res) => {
    // Relative, then absolute: both stay on the catalogue's origin.
    if (url.startsWith("/api/v1/")) return redirect(res, `/moved${url}`, 301);
    if (url.startsWith("/moved/")) {
      return redirect(res, `${site.origin}/final${url.slice("/moved".length)}`, 307);
    }
    answer(url, res);
  });
  useCatalogue(t, site.origin);

  for (const call of CALLS) {
    site.seen.length = 0;
    assert.equal(await call.run(), "standup", call.name);
    assert.deepEqual(site.seen, [call.path, `/moved${call.path}`, `/final${call.path}`], call.name);
  }
});

test("a redirect to another host or port is refused, and never requested", async (t) => {
  const elsewhere = await catalogue(t, answer);
  let to = (url: string) => url;
  const site = await catalogue(t, (url, res) => redirect(res, to(url)));
  useCatalogue(t, site.origin);

  const targets: [string, (url: string) => string][] = [
    ["another host", (url) => `http://localhost:${elsewhere.port}${url}`],
    ["another port on the same host", (url) => `${elsewhere.origin}${url}`],
  ];
  for (const [where, target] of targets) {
    to = target;
    for (const call of CALLS) {
      await assert.rejects(
        call.run(),
        refused(site.origin, /redirected .* elsewhere/, target(call.path), "localhost"),
        `${call.name}, to ${where}`,
      );
    }
  }
  assert.deepEqual(elsewhere.seen, []);
});

test("an https catalogue's redirect to http is refused, even on its own host and port", async (t) => {
  const site = await catalogue(t, (url, res) => {
    if (url.startsWith("/plain/")) return answer(url, res);
    redirect(res, `http://127.0.0.1:${site.port}/plain${url}`);
  });
  const secure = `https://127.0.0.1:${site.port}`;
  terminateTls(t, site.port);
  useCatalogue(t, secure);

  for (const call of CALLS) {
    await assert.rejects(
      call.run(),
      refused(secure, /redirected .* elsewhere/, "/plain/"),
      call.name,
    );
  }
  assert.deepEqual(
    site.seen.filter((url) => url.startsWith("/plain/")),
    [],
  );
});

test("a redirect with credentials in it is refused, and they are not repeated", async (t) => {
  const site = await catalogue(t, (url, res) => {
    if (url.startsWith("/again/")) return answer(url, res);
    redirect(res, `http://mixos:hunter2@127.0.0.1:${site.port}/again${url}`);
  });
  useCatalogue(t, site.origin);

  for (const call of CALLS) {
    await assert.rejects(
      call.run(),
      refused(site.origin, /redirected .* elsewhere/, "hunter2"),
      call.name,
    );
  }
  assert.deepEqual(
    site.seen.filter((url) => url.startsWith("/again/")),
    [],
  );
});

test("three redirects are followed, and a fourth is refused, even within the catalogue", async (t) => {
  // `/api/v1/…` → `/hop/1/api/v1/…` → `/hop/2/api/v1/…` → …, until `hops`.
  let hops = 0;
  const site = await catalogue(t, (url, res) => {
    const at = Number(/^\/hop\/(\d+)\//.exec(url)?.[1] ?? 0);
    if (at < hops) return redirect(res, `/hop/${at + 1}${url.replace(/^\/hop\/\d+/, "")}`);
    answer(url, res);
  });
  useCatalogue(t, site.origin);

  hops = 3;
  for (const call of CALLS) {
    site.seen.length = 0;
    assert.equal(await call.run(), "standup", call.name);
    assert.equal(site.seen.length, 4, call.name);
  }

  hops = 4;
  for (const call of CALLS) {
    site.seen.length = 0;
    await assert.rejects(
      call.run(),
      refused(site.origin, /redirected .* more than 3 times/, "/hop/"),
      call.name,
    );
    // The fourth redirect's target is never asked for.
    assert.deepEqual(
      site.seen.map((url) => url.replace(/\?.*/, "")),
      [0, 1, 2, 3].map((n) => (n ? `/hop/${n}` : "") + call.path.replace(/\?.*/, "")),
      call.name,
    );
  }
});
