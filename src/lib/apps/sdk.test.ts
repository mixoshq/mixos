/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { createAppClient, type RouteCall } from "./sdk";
import { defineRoute } from "./route";

// ── fixtures ────────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: RequestInit["body"];
}

// The client caches its CSRF token for the whole module, so the count does too.
let tokens = 0;

/**
 * Record every request the client sends, answering each with `answer`. The
 * CSRF token endpoint answers with a new token each time it is asked.
 */
function recordFetch(answer: (sent: Sent, n: number) => Response = () => Response.json({ ok: true })) {
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/auth/csrf") return Response.json({ csrfToken: `token-${++tokens}` });
    const one: Sent = {
      url,
      method: init?.method ?? "GET",
      headers: { ...(init?.headers as Record<string, string>) },
      body: init?.body,
    };
    sent.push(one);
    return answer(one, sent.length);
  }) as typeof fetch;
  return sent;
}

const client = () => createAppClient("acme-app");

// ── JSON input ──────────────────────────────────────────────────────────────

test("a GET fills the path from the input and sends the rest as the query string", async () => {
  const sent = recordFetch();
  await client().call("GET /items/[id]", { id: "a b", limit: 10, tags: ["x", "y"], skip: undefined });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "/api/apps/acme-app/items/a%20b?limit=10&tags=x&tags=y");
  assert.equal(sent[0].method, "GET");
  assert.equal(sent[0].body, undefined);
  assert.equal("X-CSRF-Token" in sent[0].headers, false);
});

test("a POST sends the rest of the input as JSON, with a CSRF token", async () => {
  const sent = recordFetch();
  await client().call("POST /lists/[list]/items", { list: "l1", name: "Widget" });

  assert.equal(sent[0].url, "/api/apps/acme-app/lists/l1/items");
  assert.equal(sent[0].headers["Content-Type"], "application/json");
  assert.match(sent[0].headers["X-CSRF-Token"], /^token-\d+$/);
  assert.equal(sent[0].body, JSON.stringify({ name: "Widget" }));
});

// ── a form ──────────────────────────────────────────────────────────────────

test("a form is the body: its fields fill the path, and fetch writes the multipart type", async () => {
  const sent = recordFetch(() => Response.json({ id: "f-1" }));
  const form = new FormData();
  form.set("folder", "reports/2026");
  form.set("note", "quarterly");
  form.set("file", new File(["hello"], "q3.csv", { type: "text/csv" }));

  const result = await client().call("POST /folders/[folder]/files", form);

  assert.deepEqual(result, { id: "f-1" });
  assert.equal(sent[0].url, "/api/apps/acme-app/folders/reports%2F2026/files");
  assert.equal(sent[0].method, "POST");
  // No Content-Type of ours: fetch sets multipart/form-data with its boundary.
  assert.equal("Content-Type" in sent[0].headers, false);
  assert.match(sent[0].headers["X-CSRF-Token"], /^token-\d+$/);

  const body = sent[0].body;
  assert.ok(body instanceof FormData);
  assert.deepEqual([...body.keys()], ["note", "file"]);
  assert.equal(body.get("note"), "quarterly");
  const file = body.get("file");
  assert.ok(file instanceof File);
  assert.equal(file.name, "q3.csv");
  assert.equal(await file.text(), "hello");

  // The caller's form is as it was.
  assert.deepEqual([...form.keys()], ["folder", "note", "file"]);
});

test("a form goes with PUT and PATCH too", async () => {
  const sent = recordFetch();
  const form = new FormData();
  form.set("file", new File(["x"], "x.txt"));
  await client().call("PUT /avatar", form);
  await client().call("PATCH /avatar", form);

  assert.deepEqual(sent.map((s) => s.method), ["PUT", "PATCH"]);
  for (const s of sent) assert.ok(s.body instanceof FormData);
});

test("a form with a GET or a DELETE is refused before anything is sent", async () => {
  const sent = recordFetch();
  for (const spec of ["GET /files", "DELETE /files/[id]"]) {
    await assert.rejects(
      () => client().call(spec, new FormData()),
      (err: unknown) =>
        err instanceof TypeError && err.message.includes("only with POST, PUT or PATCH"),
    );
  }
  assert.equal(sent.length, 0);
});

test("the CSRF retry sends the same form again, with the new token", async () => {
  const sent = recordFetch((_, n) =>
    n === 1 ? Response.json({ error: "Invalid CSRF token." }, { status: 403 }) : Response.json({ ok: true }),
  );
  const form = new FormData();
  form.set("file", new File(["x"], "x.txt"));
  await client().call("POST /upload", form);

  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].headers["X-CSRF-Token"], sent[1].headers["X-CSRF-Token"]);
  assert.ok(sent[1].body instanceof FormData);
  assert.equal(sent[1].body, sent[0].body);
});

// ── the types ───────────────────────────────────────────────────────────────

const routes = {
  "GET /items": defineRoute({
    input: z.object({ limit: z.number().optional() }),
    output: z.object({ items: z.array(z.string()) }),
    handler: () => ({ items: [] }),
  }),
  "POST /items": defineRoute({
    input: z.object({ name: z.string() }),
    output: z.object({ id: z.string() }),
    handler: (_ctx, input) => ({ id: input.name }),
  }),
  "POST /folders/[folder]/files": defineRoute({
    raw: true,
    input: z.object({ folder: z.string() }),
    handler: () => Response.json({ id: "f-1" }),
  }),
  "GET /export": defineRoute({
    raw: true,
    handler: () => new Response("a,b\n"),
  }),
};

test("the typed call takes a form only where a raw route reads a body", () => {
  // The claims below hold for these routes: two JSON routes, then two raw ones.
  assert.deepEqual(
    Object.values(routes).map((r) => r.raw),
    [false, false, true, true],
  );

  // Checked by the type checker, never run: each line is a compile-time claim.
  const claims = (call: RouteCall<typeof routes>) => {
    const items: Promise<{ items: string[] }> = call("GET /items", { limit: 5 });
    const created: Promise<{ id: string }> = call("POST /items", { name: "Widget" });
    // A raw route's body method takes a form, or its input as before.
    const uploaded: Promise<unknown> = call("POST /folders/[folder]/files", new FormData());
    const viaInput: Promise<unknown> = call("POST /folders/[folder]/files", { folder: "f" });
    // @ts-expect-error -- a JSON route parses its body as JSON, so it takes no form
    const jsonForm = call("POST /items", new FormData());
    // @ts-expect-error -- a GET has no body to carry a form
    const getForm = call("GET /export", new FormData());
    // @ts-expect-error -- a raw route's result is what the client read as JSON, not a Response
    const notResponse: Promise<Response> = call("POST /folders/[folder]/files", new FormData());
    return [items, created, uploaded, viaInput, jsonForm, getForm, notResponse];
  };
  assert.equal(typeof claims, "function");
});
