/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The walk over an app's pages and routes that the Access tab, the password
 * action and the API-key action all read: pages from `pageVisibility`, routes
 * from their contracts, per method, and key scopes in exactly the form the
 * gateway matches.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appSurfaces,
  appUsesPassword,
  keyScopes,
  surfacesFor,
} from "./access-surfaces";
import { keyAllows } from "./api-keys";
import type { AppManifest, RouteAuth, RouteMethodContract } from "./types";

function method(m: RouteMethodContract["method"], auth: RouteAuth[]): RouteMethodContract {
  return {
    method: m,
    auth,
    roles: [],
    budget: { connectorCalls: 0, ms: 5000 },
    raw: false,
    hasInput: false,
    hasOutput: false,
  };
}

/** Only what the walk reads; the rest of a manifest is beside the point here. */
function app(extra: Partial<AppManifest>): AppManifest {
  return { slug: "notes", routes: [], ...extra } as AppManifest;
}

const labels = (manifest: AppManifest, auth: RouteAuth) => surfacesFor(manifest, auth).map((s) => s.label);

test("pages come from pageVisibility, routes from the contracts, one surface per method", () => {
  const notes = app({
    pageVisibility: { "": ["public"], "report/[id]": ["password", "session"] },
    routes: [
      { path: "", params: [], methods: [method("GET", ["public"])] },
      { path: "items", params: [], methods: [method("GET", ["key", "session"]), method("POST", ["session"])] },
    ],
  });
  assert.deepEqual(
    appSurfaces(notes).map((s) => [s.kind, s.key, s.label, s.auths]),
    [
      ["page", "page:", "/p/notes", ["public"]],
      ["page", "page:report/[id]", "/p/notes/report/[id]", ["password", "session"]],
      ["api", "api:GET ", "GET /api/p/notes", ["public"]],
      ["api", "api:GET items", "GET /api/p/notes/items", ["key", "session"]],
      ["api", "api:POST items", "POST /api/p/notes/items", ["session"]],
    ],
  );
});

test("a route declared password in defineRoute asks for the password", () => {
  const notes = app({
    pageVisibility: {},
    routes: [{ path: "export", params: [], methods: [method("GET", ["password"])] }],
  });
  assert.equal(appUsesPassword(notes), true);
  assert.deepEqual(labels(notes, "password"), ["GET /api/p/notes/export"]);
  assert.equal(appUsesPassword(app({ routes: [{ path: "", params: [], methods: [method("GET", ["session"])] }] })), false);
});

test("a surface accepting several tiers is listed under each", () => {
  const notes = app({
    pageVisibility: { "": ["public", "password"] },
    routes: [{ path: "feed", params: [], methods: [method("GET", ["public", "password", "key"])] }],
  });
  assert.deepEqual(labels(notes, "public"), ["/p/notes", "GET /api/p/notes/feed"]);
  assert.deepEqual(labels(notes, "password"), ["/p/notes", "GET /api/p/notes/feed"]);
  assert.deepEqual(labels(notes, "key"), ["GET /api/p/notes/feed"]);
});

test("key scopes are one per method that accepts a key, in the form the gateway matches", () => {
  const notes = app({
    routes: [
      { path: "", params: [], methods: [method("GET", ["key"])] },
      { path: "items", params: [], methods: [method("GET", ["key", "session"]), method("POST", ["session"])] },
      { path: "items/[id]", params: ["id"], methods: [method("DELETE", ["key"])] },
    ],
  });
  const scopes = keyScopes(notes);
  assert.deepEqual(scopes, ["GET /", "GET /items", "DELETE /items/[id]"]);
  // Each scope is what keyAllows() checks for its own method and path, and no other.
  assert.equal(keyAllows(scopes, "GET", ""), true);
  assert.equal(keyAllows(scopes, "GET", "items"), true);
  assert.equal(keyAllows(scopes, "DELETE", "items/[id]"), true);
  assert.equal(keyAllows(scopes, "POST", "items"), false);
  assert.equal(keyAllows(["GET /items"], "GET", "items/[id]"), false);
  assert.deepEqual(keyScopes(app({ routes: [{ path: "x", params: [], methods: [method("GET", ["session"])] }] })), []);
});
