/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The app smoke test (scripts/app-smoke.ts), against a stand-in server.
 *
 * The first test is the one the old smoke test failed. It read route source
 * with a regex for `export function GET`, which no route can be written as any
 * more, found no method, and passed having sent nothing. Here a route declared
 * the way the build requires, `export const GET = defineRoute(...)`, is read by
 * the generator's own code (scripts/route-contracts.ts) and must be called.
 */

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { RouteContract, RouteMethodContract } from "../src/lib/apps/types";
import { paramsForPath, routeContract } from "./route-contracts";
import {
  FAKE_PARAM,
  SmokeSetupError,
  buildVerdict,
  classify,
  cookieHeaderFrom,
  exitCodeFor,
  formatApp,
  formatSummary,
  isEmptyBody,
  normalizeBaseUrl,
  routeUrl,
  runSmoke,
  sessionUser,
  setupFailure,
  signIn,
  signInFromEnv,
  type AppResult,
  type Observation,
  type SmokeApp,
} from "./app-smoke";

// ── fixtures ────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, "..");
const BASE = "http://mixos.test";
const SESSION = "session-cookie-value-0123456789";
const COOKIE = `authjs.session-token=${SESSION}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-smoke-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let modules = 0;

/** Write a route module and import it, as the generator does. */
async function importRoute(body: string): Promise<Record<string, unknown>> {
  const file = path.join(tmp, `route-${modules++}.ts`);
  fs.writeFileSync(
    file,
    [
      `import { z } from ${JSON.stringify(require.resolve("zod"))};`,
      `import { defineRoute } from ${JSON.stringify(path.join(ROOT, "src/lib/apps/route.ts"))};`,
      body,
    ].join("\n"),
  );
  return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
}

type Reply = () => Response;

const json =
  (status: number, body: unknown, headers: Record<string, string> = {}): Reply =>
  () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

const bare =
  (status: number, headers: Record<string, string> = {}): Reply =>
  () =>
    new Response(null, { status, headers });

/** The gateway's answer to an app that is off, or a route that isn't there. */
const GATEWAY_404 = json(404, { error: "Not found", code: "NOT_FOUND" });

interface Call {
  method: string;
  path: string;
  headers: Headers;
  body: string;
}

/**
 * A stand-in for MixOS. `routes` maps `"METHOD /path"` to a reply, or to a
 * list of replies served in turn. Like Next, it answers HEAD by running GET
 * and dropping the body. Anything else gets the gateway's 404.
 */
function server(routes: Record<string, Reply | Reply[]>) {
  const calls: Call[] = [];
  const served = new Map<string, number>();
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({
      method,
      path: url.pathname,
      headers: new Headers(init?.headers),
      body: init?.body ? String(init.body) : "",
    });
    const key = `${method} ${url.pathname}`;
    const entry = routes[key] ?? (method === "HEAD" ? routes[`GET ${url.pathname}`] : undefined);
    let reply = GATEWAY_404;
    if (Array.isArray(entry)) {
      const n = served.get(key) ?? 0;
      served.set(key, n + 1);
      reply = entry[Math.min(n, entry.length - 1)];
    } else if (entry) {
      reply = entry;
    }
    const res = reply();
    return method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
  }) as typeof globalThis.fetch;
  return { fetch: fakeFetch, calls };
}

function method(
  m: RouteMethodContract["method"],
  over: Partial<RouteMethodContract> = {},
): RouteMethodContract {
  return {
    method: m,
    auth: ["session"],
    roles: [],
    budget: { connectorCalls: 100, ms: 30_000 },
    raw: false,
    hasInput: false,
    hasOutput: true,
    ...over,
  };
}

function route(routePath: string, ...methods: RouteMethodContract[]): RouteContract {
  return { path: routePath, params: paramsForPath(routePath), methods };
}

/** Run the smoke test against `fake`, logging each wait to `sleeps` instead of waiting. */
function smoke(apps: SmokeApp[], fake: ReturnType<typeof server>, sleeps: number[] = [], skipUnavailable = false) {
  return runSmoke({
    baseUrl: BASE,
    cookie: COOKIE,
    apps,
    fetch: fake.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    skipUnavailable,
  });
}

/** Each row as `result METHOD /path status`. */
const rows = (app: AppResult) =>
  app.routes.map((r) => `${r.result} ${r.method} ${r.path}${r.status ? ` ${r.status}` : ""}`);

const sent = (fake: ReturnType<typeof server>) => fake.calls.map((c) => `${c.method} ${c.path}`);

// ── routes come from defineRoute ────────────────────────────────────────────

describe("routes come from the contracts the build reads off defineRoute", () => {
  test("a GET declared as `export const GET = defineRoute(...)` is called, and its POST is not", async () => {
    const mod = await importRoute(
      [
        "export const GET = defineRoute({",
        "  output: z.object({ notes: z.array(z.string()) }),",
        "  handler: async () => ({ notes: [] }),",
        "});",
        "export const POST = defineRoute({",
        "  input: z.object({ text: z.string() }),",
        "  output: z.object({ id: z.string() }),",
        "  handler: async () => ({ id: '1' }),",
        "});",
      ].join("\n"),
    );
    const contract = routeContract("notes-app", "notes", mod);
    const fake = server({ "GET /api/apps/notes-app/notes": json(200, { notes: ["a"] }) });

    const [app] = await smoke([{ slug: "notes-app", routes: [contract] }], fake);

    assert.deepEqual(sent(fake), ["GET /api/apps/notes-app/notes", "HEAD /api/apps/notes-app/notes"]);
    assert.deepEqual(rows(app), [
      "pass GET /notes 200",
      "pass HEAD /notes 200",
      "skipped POST /notes",
    ]);
    assert.equal(app.status, "tested");
    assert.equal(app.ok, true);
  });

  test("path params get a fake value, and should answer 4xx", async () => {
    const mod = await importRoute(
      [
        "export const GET = defineRoute({",
        "  input: z.object({ id: z.string() }),",
        "  output: z.object({ id: z.string() }),",
        "  handler: async (_ctx, input) => ({ id: input.id }),",
        "});",
      ].join("\n"),
    );
    const contract = routeContract("notes-app", "notes/[id]", mod);
    assert.deepEqual(contract.params, ["id"]);

    const fake = server({
      "GET /api/apps/notes-app": json(200, { ok: true }),
      [`GET /api/apps/notes-app/notes/${FAKE_PARAM}`]: json(404, { error: "No such note", code: "NOT_FOUND" }),
    });
    const [app] = await smoke(
      [{ slug: "notes-app", routes: [route("", method("GET")), contract] }],
      fake,
    );

    assert.deepEqual(rows(app), [
      "pass GET / 200",
      "pass HEAD / 200",
      "pass GET /notes/[id] 404",
      "pass HEAD /notes/[id] 404",
    ]);
    assert.equal(app.status, "tested");
  });

  test("the URL: the index route is the app's root, and a catch-all gets one fake segment", () => {
    assert.equal(routeUrl("notes-app", ""), "/api/apps/notes-app");
    assert.equal(routeUrl("notes-app", "notes/[id]/tags"), `/api/apps/notes-app/notes/${FAKE_PARAM}/tags`);
    assert.equal(routeUrl("notes-app", "files/[...path]"), `/api/apps/notes-app/files/${FAKE_PARAM}`);
  });
});

// ── what is sent ────────────────────────────────────────────────────────────

describe("what is sent", () => {
  test("only GET and HEAD; POST, PUT, PATCH and DELETE are listed, not sent", async () => {
    const fake = server({ "GET /api/apps/a/items": json(200, { items: [1] }) });
    const [app] = await smoke(
      [
        {
          slug: "a",
          routes: [
            route("items", method("GET"), method("POST"), method("PUT"), method("PATCH"), method("DELETE")),
          ],
        },
      ],
      fake,
    );
    assert.deepEqual(sent(fake), ["GET /api/apps/a/items", "HEAD /api/apps/a/items"]);
    assert.deepEqual(
      app.routes.filter((r) => r.result === "skipped").map((r) => `${r.method} ${r.note}`),
      [
        "POST could change data; not sent",
        "PUT could change data; not sent",
        "PATCH could change data; not sent",
        "DELETE could change data; not sent",
      ],
    );
  });

  test("a GET only a password or an API key can reach is listed, not sent", async () => {
    const fake = server({});
    const [app] = await smoke(
      [
        {
          slug: "a",
          routes: [
            route("feed", method("GET", { auth: ["password"] })),
            route("export", method("GET", { auth: ["key"] })),
          ],
        },
      ],
      fake,
    );
    assert.deepEqual(fake.calls, []);
    assert.deepEqual(rows(app), ["skipped GET /feed", "skipped GET /export"]);
    assert.equal(app.status, "nothing-to-test");
    assert.equal(app.ok, true);
  });

  test("an app with no routes has nothing to test, and passes", async () => {
    const [app] = await smoke([{ slug: "widgets-only", routes: [] }], server({}));
    assert.equal(app.status, "nothing-to-test");
    assert.equal(app.note, "no API routes");
    assert.equal(app.ok, true);
  });

  test("every request carries the session and nothing else that signs in", async () => {
    const fake = server({ "GET /api/apps/a/x": json(200, { x: 1 }) });
    await smoke([{ slug: "a", routes: [route("x", method("GET"))] }], fake);
    for (const call of fake.calls) {
      assert.equal(call.headers.get("cookie"), COOKIE);
      assert.equal(call.headers.get("x-csrf-token"), null);
    }
  });
});

// ── each answer ─────────────────────────────────────────────────────────────

describe("each answer, on its own", () => {
  const get = { method: "GET" as const, route: route("items", method("GET")), contract: method("GET") };
  const head = { ...get, method: "HEAD" as const };
  const withParam = { ...get, route: route("items/[id]", method("GET")) };
  const roleGated = { ...get, contract: method("GET", { roles: ["editor"] }) };
  const at = (status: number, body = "", location: string | null = null): Observation => ({
    status,
    body,
    location,
    ms: 5,
    tries: 1,
  });

  const cases: [string, ReturnType<typeof classify>, ReturnType<typeof classify>][] = [
    ["200 with data", classify(get, at(200, '{"items":[1]}')), { result: "pass" }],
    ["200 with `{}`", classify(get, at(200, "{}")), { result: "pass", note: "empty body" }],
    ["204", classify(get, at(204)), { result: "pass", note: "empty body" }],
    ["HEAD, which never has a body", classify(head, at(200)), { result: "pass" }],
    ["`connected: false`", classify(get, at(200, '{"connected":false}')), { result: "pass", note: "connected: false" }],
    ["200 to a fake param", classify(withParam, at(200, '{"id":"x"}')), { result: "pass", note: "200 for a fake id" }],
    ["404 to a fake param", classify(withParam, at(404)), { result: "pass" }],
    ["400 to a fake param", classify(withParam, at(400)), { result: "pass" }],
    [
      "400 with no params",
      classify(get, at(400, '{"error":"Invalid request","code":"INVALID_INPUT"}')),
      { result: "pass", note: "400 with no params (INVALID_INPUT: Invalid request)" },
    ],
    ["403 from a role gate", classify(roleGated, at(403)), { result: "pass", note: "403: needs role editor" }],
    [
      "500",
      classify(get, at(500, '{"error":"a GET /items failed.","code":"HANDLER_ERROR"}')),
      { result: "fail", note: "500 HANDLER_ERROR: a GET /items failed." },
    ],
    [
      "503 from a connector nobody set up",
      classify(
        get,
        at(503, '{"error":{"category":"unconfigured","message":"Acme isn\'t set up yet.","connector":"Acme","retryAfterMs":null},"code":"UNAVAILABLE"}'),
      ),
      { result: "fail", note: "503 Acme unconfigured: Acme isn't set up yet." },
    ],
    ["504", classify(get, at(504)), { result: "fail", note: "504" }],
    ["a network error", classify(get, { error: "network", message: "ECONNREFUSED", ms: 1, tries: 1 }), { result: "fail", note: "network error: ECONNREFUSED" }],
    ["no answer in time", classify(get, { error: "timeout", ms: 35_000, tries: 1 }), { result: "fail", note: "no answer in 35.0s" }],
    ["401", classify(get, at(401)), { result: "blocked", note: "401: the session was refused" }],
    ["a redirect to /login", classify(get, at(307, "", "http://mixos.test/login")), { result: "blocked", note: "signed out: redirected to /login" }],
    ["another redirect", classify(get, at(302, "", "/files/1.pdf")), { result: "pass", note: "redirects to /files/1.pdf" }],
    ["429 after every try", classify(get, { ...at(429), tries: 3 }), { result: "blocked", note: "429: rate limited, 3 tries" }],
  ];
  for (const [name, actual, expected] of cases) {
    test(name, () => assert.deepEqual(actual, expected));
  }

  test("405: the server's build has no such method", () => {
    const { result, note } = classify(get, at(405));
    assert.equal(result, "blocked");
    assert.match(note ?? "", /^405: the server has no GET here/);
  });

  test("with skipUnavailable, a 503 UNAVAILABLE is skipped: the route needs what this server hasn't configured", () => {
    const skip = { skipUnavailable: true };
    const connector =
      '{"error":{"category":"unconfigured","message":"Acme isn\'t set up yet.","connector":"Acme","retryAfterMs":null},"code":"UNAVAILABLE"}';
    assert.deepEqual(classify(get, at(503, connector), skip), {
      result: "skipped",
      note: "not tested: 503 Acme unconfigured: Acme isn't set up yet.",
    });
    assert.deepEqual(classify(get, at(503, '{"error":"That is temporarily unavailable","code":"UNAVAILABLE"}'), skip), {
      result: "skipped",
      note: "not tested: 503 UNAVAILABLE: That is temporarily unavailable",
    });
    // Anything else that is a server error still fails.
    for (const [status, body] of [
      [503, ""],
      [503, '{"error":"down","code":"HANDLER_ERROR"}'],
      [502, '{"error":{"category":"upstream_error","message":"Acme failed.","connector":"Acme","retryAfterMs":null},"code":"UNAVAILABLE"}'],
      [500, '{"error":"a GET /items failed.","code":"HANDLER_ERROR"}'],
    ] as const) {
      assert.equal(classify(get, at(status, body), skip).result, "fail", `${status} ${body}`);
    }
    // And without it, as in a checkout, a 503 fails like any 5xx.
    assert.equal(classify(get, at(503, connector)).result, "fail");
  });

  test("what counts as an empty body", () => {
    for (const body of ["", "  ", "null", '""', "{}", "[]"]) assert.equal(isEmptyBody(body), true, body);
    for (const body of ["0", "false", '{"a":null}', "[0]", "<html></html>"]) assert.equal(isEmptyBody(body), false, body);
  });
});

// ── the app as a whole ──────────────────────────────────────────────────────

describe("the app as a whole", () => {
  test("404 on every route, including one with no params: inactive, and every row is blocked", async () => {
    const [app] = await smoke(
      [{ slug: "off", routes: [route("items", method("GET"), method("POST")), route("items/[id]", method("GET"))] }],
      server({}),
    );
    assert.equal(app.status, "inactive");
    assert.equal(app.ok, false);
    assert.match(app.note ?? "", /inactive, or not in this server's build/);
    assert.deepEqual(rows(app), [
      "blocked GET /items 404",
      "blocked HEAD /items 404",
      "skipped POST /items",
      "blocked GET /items/[id] 404",
      "blocked HEAD /items/[id] 404",
    ]);
  });

  test("404 on every route when every route takes params: unconfirmed, not blocked", async () => {
    const [app] = await smoke([{ slug: "lookup", routes: [route("items/[id]", method("GET"))] }], server({}));
    assert.equal(app.status, "unconfirmed");
    assert.equal(app.ok, true);
    assert.deepEqual(rows(app), ["pass GET /items/[id] 404", "pass HEAD /items/[id] 404"]);
  });

  test("403 on every route that needs a grant: not granted; a signed-in route still runs", async () => {
    const forbidden = json(403, { error: "You do not have access to this app", code: "FORBIDDEN" });
    const [app] = await smoke(
      [
        {
          slug: "team",
          routes: [
            route("board", method("GET")),
            route("me", method("GET", { auth: ["signed-in"] })),
            route("reports", method("GET", { roles: ["manager"] })),
          ],
        },
      ],
      server({
        "GET /api/apps/team/board": forbidden,
        "GET /api/apps/team/reports": forbidden,
        "GET /api/apps/team/me": json(200, { name: "A" }),
      }),
    );
    assert.equal(app.status, "not-granted");
    assert.equal(app.ok, false);
    assert.deepEqual(rows(app), [
      "blocked GET /board 403",
      "blocked HEAD /board 403",
      "pass GET /me 200",
      "pass HEAD /me 200",
      "blocked GET /reports 403",
      "blocked HEAD /reports 403",
    ]);
  });

  test("granted, but without a route's role: that 403 passes, with a note", async () => {
    const [app] = await smoke(
      [{ slug: "team", routes: [route("board", method("GET")), route("reports", method("GET", { roles: ["manager"] }))] }],
      server({
        "GET /api/apps/team/board": json(200, { cards: [1] }),
        "GET /api/apps/team/reports": json(403, { error: "You do not have access to this", code: "FORBIDDEN" }),
      }),
    );
    assert.equal(app.status, "tested");
    assert.equal(app.ok, true);
    assert.equal(app.routes[2].note, "403: needs role manager");
  });

  test("401 everywhere: signed out", async () => {
    const [app] = await smoke(
      [{ slug: "a", routes: [route("x", method("GET"))] }],
      server({ "GET /api/apps/a/x": json(401, { error: "Sign in to continue", code: "UNAUTHENTICATED" }) }),
    );
    assert.equal(app.status, "signed-out");
    assert.equal(app.ok, false);
    assert.deepEqual(rows(app), ["blocked GET /x 401", "blocked HEAD /x 401"]);
  });

  test("a route that fails fails its app, and the rest still run", async () => {
    const [app] = await smoke(
      [{ slug: "a", routes: [route("boom", method("GET")), route("fine", method("GET"))] }],
      server({
        "GET /api/apps/a/boom": json(500, { error: "a GET /boom failed.", code: "HANDLER_ERROR" }),
        "GET /api/apps/a/fine": json(200, { ok: true }),
      }),
    );
    assert.equal(app.status, "tested");
    assert.equal(app.ok, false);
    assert.deepEqual(rows(app), ["fail GET /boom 500", "fail HEAD /boom 500", "pass GET /fine 200", "pass HEAD /fine 200"]);
  });

  test("with skipUnavailable, a route that answers 503 UNAVAILABLE is skipped, HEAD with its GET, and the app passes", async () => {
    const unavailable = json(503, { error: "Acme isn't configured", code: "UNAVAILABLE" });
    const routes = [route("live", method("GET")), route("fine", method("GET"))];
    const fake = () => server({ "GET /api/apps/a/live": unavailable, "GET /api/apps/a/fine": json(200, { ok: true }) });

    const [skipped] = await smoke([{ slug: "a", routes }], fake(), [], true);
    assert.equal(skipped.status, "tested");
    assert.equal(skipped.ok, true);
    assert.deepEqual(rows(skipped), ["skipped GET /live 503", "skipped HEAD /live 503", "pass GET /fine 200", "pass HEAD /fine 200"]);
    assert.equal(skipped.routes[1].note, "not tested: 503, as GET");

    const [failed] = await smoke([{ slug: "a", routes }], fake());
    assert.equal(failed.ok, false);
    assert.deepEqual(rows(failed).slice(0, 2), ["fail GET /live 503", "fail HEAD /live 503"]);
  });

  test("with skipUnavailable, a HEAD that fails after its GET passed still fails", async () => {
    let n = 0;
    const [app] = await smoke(
      [{ slug: "a", routes: [route("x", method("GET"))] }],
      server({ "GET /api/apps/a/x": () => (n++ === 0 ? json(200, { x: 1 })() : bare(503)()) }),
      [],
      true,
    );
    assert.deepEqual(rows(app), ["pass GET /x 200", "fail HEAD /x 503"]);
  });

  test("HEAD answering differently from GET is noted", async () => {
    let n = 0;
    const [app] = await smoke(
      [{ slug: "a", routes: [route("x", method("GET"))] }],
      server({ "GET /api/apps/a/x": () => (n++ === 0 ? json(200, { x: 1 })() : bare(503)()) }),
    );
    assert.equal(app.routes[1].note, "503; GET answered 200");
  });
});

// ── waiting ─────────────────────────────────────────────────────────────────

describe("waiting", () => {
  test("a 429 is retried after its Retry-After", async () => {
    const sleeps: number[] = [];
    const fake = server({
      "GET /api/apps/a/x": [json(429, { code: "RATE_LIMITED" }, { "retry-after": "2" }), json(200, { x: 1 })],
    });
    const [app] = await smoke([{ slug: "a", routes: [route("x", method("GET"))] }], fake, sleeps);
    // Once for GET, once for HEAD: each met its own 429 first.
    assert.deepEqual(sleeps, [2000, 2000]);
    assert.deepEqual(rows(app), ["pass GET /x 200", "pass HEAD /x 200"]);
  });

  test("three 429s in a row: blocked", async () => {
    const fake = server({ "GET /api/apps/a/x": json(429, { code: "RATE_LIMITED" }, { "retry-after": "1" }) });
    const [app] = await smoke([{ slug: "a", routes: [route("x", method("GET"))] }], fake);
    assert.equal(fake.calls.length, 6);
    assert.equal(app.routes[0].result, "blocked");
    assert.equal(app.ok, false);
  });

  test("no answer within the route's budget plus the grace: a failure", async () => {
    const hang = (async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as typeof fetch;
    const [app] = await runSmoke({
      baseUrl: BASE,
      cookie: COOKIE,
      apps: [{ slug: "a", routes: [route("slow", method("GET", { budget: { connectorCalls: 0, ms: 10 } }))] }],
      fetch: hang,
      graceMs: 10,
    });
    assert.equal(app.routes[0].result, "fail");
    assert.match(app.routes[0].note ?? "", /^no answer in \d+\.\ds$/);
  });

  test("an error that quotes the cookie never reaches a note", async () => {
    const leaky = (async () => {
      throw new TypeError("fetch failed", { cause: new Error(`invalid header value: ${SESSION}`) });
    }) as typeof fetch;
    const [app] = await runSmoke({
      baseUrl: BASE,
      cookie: COOKIE,
      apps: [{ slug: "a", routes: [route("x", method("GET"))] }],
      fetch: leaky,
    });
    assert.equal(app.routes[0].note, "network error: invalid header value: [redacted]");
  });
});

// ── the verdict ─────────────────────────────────────────────────────────────

describe("the verdict", () => {
  test("one JSON line with every app and route; ok only when nothing failed or was blocked", async () => {
    const apps = await smoke(
      [
        { slug: "good", routes: [route("x", method("GET"), method("DELETE"))] },
        { slug: "off", routes: [route("y", method("GET"))] },
      ],
      server({ "GET /api/apps/good/x": json(200, { x: 1 }) }),
    );
    const verdict = buildVerdict(BASE, "admin@example.com", apps);
    const line = JSON.stringify(verdict);

    assert.equal(line.includes("\n"), false);
    const back = JSON.parse(line);
    assert.equal(back.ok, false);
    assert.equal(back.baseUrl, BASE);
    assert.equal(back.user, "admin@example.com");
    assert.deepEqual(back.counts, { pass: 2, fail: 0, blocked: 2, skipped: 1 });
    assert.deepEqual(
      back.apps.map((a: AppResult) => [a.slug, a.status, a.ok]),
      [
        ["good", "tested", true],
        ["off", "inactive", false],
      ],
    );
    assert.deepEqual(back.apps[0].routes[0], {
      method: "GET",
      path: "/x",
      url: "/api/apps/good/x",
      status: 200,
      result: "pass",
      ms: back.apps[0].routes[0].ms,
    });
    assert.equal(exitCodeFor(verdict), 1);
    assert.equal(exitCodeFor(buildVerdict(BASE, "a@b.c", [apps[0]])), 0);
  });

  test("a run that couldn't start exits 2, with the reason", () => {
    const verdict = setupFailure(BASE, "sign-in failed: wrong email or password");
    assert.equal(exitCodeFor(verdict), 2);
    assert.equal(verdict.ok, false);
    assert.deepEqual(verdict.apps, []);
    assert.equal(formatSummary(verdict), "[smoke] Could not run: sign-in failed: wrong email or password");
  });

  test("the report and the verdict never hold the session cookie", async () => {
    const apps = await smoke(
      [{ slug: "a", routes: [route("x", method("GET")), route("y", method("GET"))] }],
      server({ "GET /api/apps/a/x": json(500, { error: "boom", code: "HANDLER_ERROR" }) }),
    );
    const verdict = buildVerdict(BASE, "a@b.c", apps);
    const printed = [...apps.flatMap(formatApp), formatSummary(verdict), JSON.stringify(verdict)].join("\n");
    assert.equal(printed.includes(SESSION), false);
  });
});

// ── signing in ──────────────────────────────────────────────────────────────

describe("signing in", () => {
  const PASSWORD = "correct-horse-battery-staple";

  /** Auth.js's credentials flow: a CSRF token and its cookie, then the callback. */
  function authServer(callback: (call: Call) => Response) {
    const calls: Call[] = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const call = {
        method: init?.method ?? "GET",
        path: url.pathname,
        headers: new Headers(init?.headers),
        body: init?.body ? String(init.body) : "",
      };
      calls.push(call);
      if (url.pathname === "/api/auth/csrf") {
        return new Response(JSON.stringify({ csrfToken: "csrf-token" }), {
          status: 200,
          headers: [
            ["content-type", "application/json"],
            ["set-cookie", "authjs.csrf-token=csrf-token%7Chash; Path=/; HttpOnly; SameSite=Lax"],
            ["set-cookie", "authjs.callback-url=http%3A%2F%2Fmixos.test; Path=/; HttpOnly; SameSite=Lax"],
          ],
        });
      }
      if (url.pathname === "/api/auth/callback/credentials") return callback(call);
      return new Response(null, { status: 404 });
    }) as typeof globalThis.fetch;
    return { fetch: fakeFetch, calls };
  }

  test("posts the CSRF token with its cookie and the credentials, and keeps only the session", async () => {
    const auth = authServer(
      () =>
        new Response(null, {
          status: 302,
          headers: [
            ["location", "http://mixos.test/"],
            ["set-cookie", "authjs.callback-url=; Path=/; Max-Age=0"],
            ["set-cookie", `authjs.session-token=${SESSION}; Path=/; HttpOnly; SameSite=Lax`],
          ],
        }),
    );
    const cookie = await signIn({ baseUrl: BASE, email: "admin@example.com", password: PASSWORD, fetch: auth.fetch });

    assert.equal(cookie, COOKIE);
    const post = auth.calls[1];
    assert.equal(post.method, "POST");
    assert.equal(post.path, "/api/auth/callback/credentials");
    assert.equal(post.headers.get("content-type"), "application/x-www-form-urlencoded");
    assert.match(post.headers.get("cookie") ?? "", /(^|; )authjs\.csrf-token=csrf-token%7Chash(;|$)/);
    const form = new URLSearchParams(post.body);
    assert.equal(form.get("csrfToken"), "csrf-token");
    assert.equal(form.get("email"), "admin@example.com");
    assert.equal(form.get("password"), PASSWORD);
  });

  test("a long session arrives in numbered chunks, and all of them are kept", async () => {
    const auth = authServer(
      () =>
        new Response(null, {
          status: 302,
          headers: [
            ["location", "/"],
            ["set-cookie", "__Secure-authjs.session-token.0=first-half; Path=/; Secure"],
            ["set-cookie", "__Secure-authjs.session-token.1=second-half; Path=/; Secure"],
          ],
        }),
    );
    const cookie = await signIn({ baseUrl: "https://mixos.test", email: "a@b.c", password: PASSWORD, fetch: auth.fetch });
    assert.equal(cookie, "__Secure-authjs.session-token.0=first-half; __Secure-authjs.session-token.1=second-half");
  });

  test("a wrong password says so, and never says the password", async () => {
    const auth = authServer(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://mixos.test/login?error=CredentialsSignin&code=credentials" },
        }),
    );
    await assert.rejects(
      signIn({ baseUrl: BASE, email: "a@b.c", password: PASSWORD, fetch: auth.fetch }),
      (err: unknown) => {
        assert.ok(err instanceof SmokeSetupError);
        assert.equal(err.message, "sign-in failed: wrong email or password");
        return true;
      },
    );
  });

  test("a server that isn't there is named, without the password", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error(PASSWORD), { code: undefined }) });
    }) as typeof fetch;
    await assert.rejects(
      signIn({ baseUrl: BASE, email: "a@b.c", password: PASSWORD, fetch: down }),
      (err: unknown) => {
        assert.ok(err instanceof SmokeSetupError);
        assert.equal(err.message, "can't reach http://mixos.test: [redacted]");
        return true;
      },
    );
  });

  test("from the environment: SMOKE_COOKIE wins, the password is the other way, and neither is a refusal", async () => {
    const seen: string[] = [];
    const session = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(`${new URL(String(input)).pathname} ${new Headers(init?.headers).get("cookie") ?? ""}`);
      return new Response(JSON.stringify({ user: { email: "a@b.c" } }), { status: 200 });
    }) as typeof fetch;
    const hidden: string[] = [];
    const fromCookie = await signInFromEnv({
      baseUrl: BASE,
      env: { SMOKE_COOKIE: "abc.def.ghi", SMOKE_EMAIL: "x@y.z", SMOKE_PASSWORD: PASSWORD },
      fetch: session,
      onCookie: (cookie) => hidden.push(cookie),
    });
    assert.deepEqual(fromCookie, { cookie: "authjs.session-token=abc.def.ghi", user: "a@b.c" });
    assert.deepEqual(hidden, ["authjs.session-token=abc.def.ghi"], "told before the session was asked about");
    assert.deepEqual(seen, ["/api/auth/session authjs.session-token=abc.def.ghi"]);

    await assert.rejects(signInFromEnv({ baseUrl: BASE, env: {}, fetch: session }), /no sign-in\. Set SMOKE_EMAIL/);
    await assert.rejects(
      signInFromEnv({ baseUrl: BASE, env: { SMOKE_COOKIE: "a\nb" }, fetch: session }),
      /SMOKE_COOKIE holds a line break/,
    );
    const nobody = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    await assert.rejects(
      signInFromEnv({ baseUrl: BASE, env: { SMOKE_COOKIE: "expired" }, fetch: nobody }),
      /SMOKE_COOKIE wasn't accepted/,
    );
  });

  test("a base URL is an http or https origin and path, without a trailing slash", () => {
    assert.equal(normalizeBaseUrl("http://localhost:3118/"), "http://localhost:3118");
    assert.equal(normalizeBaseUrl("https://mixos.example.com/os//"), "https://mixos.example.com/os");
    assert.throws(() => normalizeBaseUrl("localhost:3000"), /is not a URL|must be http or https/);
    assert.throws(() => normalizeBaseUrl("ftp://example.com"), /must be http or https, not ftp:/);
  });

  test("SMOKE_COOKIE: a bare token gets the session cookie's name, `__Secure-` over HTTPS", () => {
    assert.equal(cookieHeaderFrom("abc.def.ghi", "http://localhost:3000"), "authjs.session-token=abc.def.ghi");
    assert.equal(cookieHeaderFrom(" abc.def.ghi\n", "https://mixos.example.com"), "__Secure-authjs.session-token=abc.def.ghi");
    assert.equal(cookieHeaderFrom("a=1; b=2", "https://mixos.example.com"), "a=1; b=2");
  });

  test("the session is checked with Auth.js: whose it is, or null when it isn't accepted", async () => {
    const answer = (body: unknown) =>
      (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
    assert.equal(
      await sessionUser({ baseUrl: BASE, cookie: COOKIE, fetch: answer({ user: { email: "a@b.c" }, expires: "x" }) }),
      "a@b.c",
    );
    assert.equal(await sessionUser({ baseUrl: BASE, cookie: COOKIE, fetch: answer(null) }), null);
  });
});

// ── the command ─────────────────────────────────────────────────────────────

describe("the command", () => {
  test("with no way to sign in it exits 2, and stdout is the verdict alone", () => {
    const run = spawnSync(
      process.execPath,
      ["--import", "tsx", path.join(ROOT, "scripts", "smoke-test-app.ts"), "--base-url", "http://127.0.0.1:9"],
      {
        cwd: ROOT,
        encoding: "utf8",
        // ProcessEnv's type requires a NODE_ENV, which nothing here reads.
        env: { PATH: process.env.PATH ?? "" } as unknown as NodeJS.ProcessEnv,
      },
    );
    assert.equal(run.status, 2, run.stderr);
    const lines = run.stdout.trim().split("\n");
    assert.equal(lines.length, 1);
    const verdict = JSON.parse(lines[0]);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.baseUrl, "http://127.0.0.1:9");
    assert.equal(typeof verdict.error, "string");
  });
});
