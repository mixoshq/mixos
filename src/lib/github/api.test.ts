/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The GitHub client: one host, no redirects, a time limit and a size cap, and
 * nothing logged. `fetch` is replaced for each test, so nothing leaves the
 * machine.
 */

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { GITHUB_API_ORIGIN, GitHubError, MAX_RESPONSE_BYTES, assertApiPath, githubRequest } from "./api";

const realFetch = globalThis.fetch;
const TOKEN = "ghs_0123456789abcdef0123456789abcdef01";
const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxIn0.c2lnbmF0dXJl";

interface Sent {
  url: string;
  init: RequestInit;
}
let sent: Sent[] = [];
let logged: string[] = [];
const quiet = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };

function answer(make: (url: string, init: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    sent.push({ url, init: init ?? {} });
    return make(url, init ?? {});
  }) as typeof fetch;
}

beforeEach(() => {
  sent = [];
  logged = [];
  for (const level of ["log", "warn", "error", "info", "debug"] as const) {
    console[level] = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  }
});

afterEach(() => {
  globalThis.fetch = realFetch;
  Object.assign(console, quiet);
  // Nothing in this module ever writes to the console.
  assert.deepEqual(logged, []);
});

describe("paths", () => {
  test("only absolute paths of encoded segments on api.github.com are sent", async () => {
    answer(() => Response.json({}));
    for (const path of [
      "",
      "app",
      "//evil.example/app",
      "https://evil.example/app",
      "/repos/../app",
      "/repos/./app",
      "/repos/acme/%2e%2e/app",
      "/repos/acme/mixos?per_page=100",
      "/repos/acme/mixos#x",
      "/repos/acme/mi xos",
      "/repos//mixos",
      "/repos/acme/mixos/",
      "/repos/acme\\mixos",
      "/@evil.example",
    ]) {
      await assert.rejects(
        githubRequest(path, { auth: { kind: "none" } }),
        (err: unknown) => err instanceof GitHubError && err.failure === "path",
        path,
      );
    }
    assert.equal(sent.length, 0);
    assert.equal(assertApiPath("/repos/acme/mixos/rules/branches/release%2F1").href, `${GITHUB_API_ORIGIN}/repos/acme/mixos/rules/branches/release%2F1`);
  });

  test("a request goes to api.github.com with GitHub's headers, the query from params, never redirect-following", async () => {
    answer(() => Response.json({ ok: true }));
    const out = await githubRequest("/installation/repositories", {
      auth: { kind: "installation", token: TOKEN },
      params: new URLSearchParams({ per_page: "2" }),
    });
    assert.deepEqual(out, { status: 200, data: { ok: true } });
    assert.equal(sent[0].url, `${GITHUB_API_ORIGIN}/installation/repositories?per_page=2`);
    assert.equal(sent[0].init.redirect, "manual");
    const headers = new Headers(sent[0].init.headers);
    assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`);
    assert.equal(headers.get("accept"), "application/vnd.github+json");
    assert.equal(headers.get("x-github-api-version"), "2022-11-28");
    assert.ok(headers.get("user-agent"));
    assert.ok(sent[0].init.signal instanceof AbortSignal);
  });

  test("the App speaks with its JWT, and the manifest conversion with nothing", async () => {
    answer(() => Response.json({}));
    await githubRequest("/app", { auth: { kind: "app", jwt: JWT } });
    await githubRequest("/app-manifests/abc123def/conversions", { method: "POST", auth: { kind: "none" } });
    assert.equal(new Headers(sent[0].init.headers).get("authorization"), `Bearer ${JWT}`);
    assert.equal(new Headers(sent[1].init.headers).get("authorization"), null);
    assert.equal(sent[1].init.method, "POST");
  });
});

describe("answers", () => {
  test("a redirect is refused, not followed, and its Location isn't repeated", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      sent = [];
      answer(() => new Response(null, { status, headers: { location: "https://evil.example/steal" } }));
      await assert.rejects(
        githubRequest("/repos/acme/mixos", { auth: { kind: "installation", token: TOKEN } }),
        (err: unknown) =>
          err instanceof GitHubError && err.failure === "redirect" && err.status === status && !err.message.includes("evil"),
      );
      assert.equal(sent.length, 1, String(status));
    }
  });

  test("a status says what GitHub said, cleaned and capped, and never the credential", async () => {
    const cases: [number, string][] = [
      [401, "unauthorized"],
      [403, "forbidden"],
      [404, "not-found"],
      [422, "status"],
      [500, "status"],
    ];
    for (const [status, failure] of cases) {
      answer(() => Response.json({ message: `Bad\u0000 credentials\u202e ${"x".repeat(400)}` }, { status }));
      await assert.rejects(
        githubRequest("/app", { auth: { kind: "app", jwt: JWT } }),
        (err: unknown) =>
          err instanceof GitHubError &&
          err.failure === failure &&
          err.status === status &&
          err.message.startsWith(`GitHub answered GET /app with ${status}: Bad credentials`) &&
          !/[\u0000\u202e]/.test(err.message) &&
          err.message.length < 300 &&
          !err.message.includes(JWT),
      );
    }
  });

  test("a 204 is a success with no data", async () => {
    answer(() => new Response(null, { status: 204 }));
    assert.deepEqual(await githubRequest("/installation/token", { method: "DELETE", auth: { kind: "installation", token: TOKEN } }), {
      status: 204,
      data: null,
    });
  });

  test("an answer that isn't JSON is malformed, without quoting it", async () => {
    answer(() => new Response(`not json ${TOKEN}`, { status: 200 }));
    await assert.rejects(
      githubRequest("/app", { auth: { kind: "none" } }),
      (err: unknown) => err instanceof GitHubError && err.failure === "malformed" && !err.message.includes(TOKEN),
    );
  });

  test("an answer over the cap is refused as it arrives", async () => {
    let pulled = 0;
    answer(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              pulled++;
              controller.enqueue(new Uint8Array(1024 * 1024));
              if (pulled > 50) controller.close();
            },
          }),
        ),
    );
    await assert.rejects(
      githubRequest("/app", { auth: { kind: "none" } }),
      (err: unknown) => err instanceof GitHubError && err.failure === "malformed" && /larger than/.test(err.message),
    );
    assert.ok(pulled <= Math.ceil(MAX_RESPONSE_BYTES / (1024 * 1024)) + 2, `read ${pulled} MB`);
  });

  test("no answer, or one that stops, is unreachable", async () => {
    answer(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    await assert.rejects(
      githubRequest("/app", { auth: { kind: "none" } }),
      (err: unknown) => err instanceof GitHubError && err.failure === "unreachable" && /10 seconds/.test(err.message),
    );
    answer(() => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    });
    await assert.rejects(
      githubRequest("/app", { auth: { kind: "none" } }),
      (err: unknown) => err instanceof GitHubError && err.failure === "unreachable" && /ECONNREFUSED/.test(err.message),
    );
    answer(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"partial":'));
              controller.error(new DOMException("aborted", "TimeoutError"));
            },
          }),
        ),
    );
    await assert.rejects(
      githubRequest("/app", { auth: { kind: "none" } }),
      (err: unknown) => err instanceof GitHubError && err.failure === "unreachable",
    );
  });
});
