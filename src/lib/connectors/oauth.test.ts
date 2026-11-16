/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  TOKEN_KEYS,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  grantedScope,
  newFlowState,
  oauthReturnUrl,
  openFlowState,
  requestedScopes,
  safeReturnPath,
  sealFlowState,
  tokensToCredentials,
} from "./oauth";
import { classifyGrant } from "./scope-status";
import type { ConnectorAuthPolicy } from "./types";

// ── fixtures ────────────────────────────────────────────────────────────────

// The code exchange sends this deployment's redirect URI, built from its origin.
process.env.NEXTAUTH_URL ??= "https://mixos.test";

const POLICY: ConnectorAuthPolicy = {
  strategy: "oauth2_authorization_code",
  authorizeUrl: "https://provider.test/authorize",
  tokenUrl: "https://provider.test/token",
  scopes: [
    { scope: "things:read", requested: true },
    { scope: "people:read", requested: true },
    { scope: "things:write", requested: false },
  ],
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** The provider answers the code exchange with `body`. */
function tokenEndpoint(body: Record<string, unknown>) {
  globalThis.fetch = async () => Response.json(body);
}

const exchange = () =>
  exchangeAuthorizationCode({
    policy: POLICY,
    connectorName: "things",
    subject: "Things",
    clientId: "cid",
    clientSecret: "secret",
    code: "the-code",
    codeVerifier: "v".repeat(43),
    writes: false,
  });

const verdicts = (scope: string | undefined) =>
  classifyGrant(POLICY.scopes!, (scope ?? "").split(/\s+/).filter(Boolean)).map(
    (r) => `${r.scope}=${r.status}`,
  );

// ── tests ───────────────────────────────────────────────────────────────────

test("a token response with no scope granted what was requested", async () => {
  tokenEndpoint({ access_token: "at", refresh_token: "rt", expires_in: 3600 });
  const tokens = await exchange();

  assert.equal(tokens.scope, "things:read people:read");
  // What the callback records. It used to be "refused" for every requested scope.
  assert.deepEqual(verdicts(tokens.scope), [
    "things:read=granted",
    "people:read=granted",
    "things:write=unknown",
  ]);
  // And what is stored, so the registry knows the grant rather than reading it as unknown.
  assert.equal(tokensToCredentials(tokens)[TOKEN_KEYS.scope], "things:read people:read");
});

test("a scope the provider does return is taken at its word", async () => {
  tokenEndpoint({ access_token: "at", expires_in: 3600, scope: "things:read" });
  const tokens = await exchange();
  assert.deepEqual(verdicts(tokens.scope), [
    "things:read=granted",
    "people:read=refused",
    "things:write=unknown",
  ]);
});

test("an empty scope is a grant of nothing, not an omission", () => {
  assert.equal(grantedScope("", POLICY), "");
});

test("a null scope is read as omitted", () => {
  assert.equal(grantedScope(null, POLICY), "things:read people:read");
});

test("nothing requested and nothing returned leaves the scope unset", () => {
  assert.equal(grantedScope(undefined, { ...POLICY, scopes: [] }), undefined);
});

// ── the trip back ───────────────────────────────────────────────────────────

test("the trip back names the connector once, so the registry dialog reopens", () => {
  // The registry's Connect link returns to a path that already names the
  // connector. Appending a second "?…" made `connector` read
  // "gmail?connector=gmail", which matched no connector.
  const url = oauthReturnUrl("/admin/connectors?connector=gmail", "https://mixos.test", "gmail", "connected");
  assert.equal(url.origin, "https://mixos.test");
  assert.equal(url.pathname, "/admin/connectors");
  assert.deepEqual(url.searchParams.getAll("connector"), ["gmail"]);
  assert.equal(url.searchParams.get("oauth"), "connected");

  assert.equal(
    oauthReturnUrl("/account/connections", "https://mixos.test", "mail", "denied").href,
    "https://mixos.test/account/connections?connector=mail&oauth=denied",
  );
});

test("a return path that would resolve to another host is refused", () => {
  // A URL parser drops tabs and newlines, so "/\t/evil.example" is read as
  // "//evil.example": another host, though it starts with a single slash.
  for (const path of ["/\t/evil.example", "/\n/evil.example", "/\r/evil.example"]) {
    assert.equal(safeReturnPath(path), "/admin/connectors", JSON.stringify(path));
    assert.equal(
      oauthReturnUrl(path, "https://mixos.test", "gmail", "connected").origin,
      "https://mixos.test",
      JSON.stringify(path),
    );
  }
});

// ── writes ──────────────────────────────────────────────────────────────────

const WRITES: ConnectorAuthPolicy = {
  ...POLICY,
  scopes: [
    { scope: "things:read", requested: true },
    { scope: "things:write", requested: "write" },
    { scope: "admin", requested: false },
  ],
};

test("a scope requested with \"write\" is asked for only once changes are allowed", () => {
  assert.deepEqual(requestedScopes(WRITES), ["things:read"]);
  assert.deepEqual(requestedScopes(WRITES, { writes: true }), ["things:read", "things:write"]);

  const scopeOf = (writes: boolean) =>
    new URL(
      buildAuthorizeUrl(WRITES, { connector: "things", clientId: "cid", flow: newFlowState("things", "/admin/connectors", null, writes) }),
    ).searchParams.get("scope");
  assert.equal(scopeOf(false), "things:read");
  assert.equal(scopeOf(true), "things:read things:write");
});

test("the flow carries what it asked for, and the callback reads the grant against that", () => {
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "a".repeat(64);
  const sealed = sealFlowState(newFlowState("things", "/admin/connectors", null, true));
  assert.equal(openFlowState(sealed)?.writes, true);

  // A token response with no scope granted what was asked: with writes, both.
  assert.equal(grantedScope(undefined, WRITES, { writes: true }), "things:read things:write");
  assert.equal(grantedScope(undefined, WRITES), "things:read");

  const verdicts = (granted: string[], writes: boolean) =>
    classifyGrant(WRITES.scopes!, granted, { writes }).map((r) => `${r.scope}=${r.status}`);
  assert.deepEqual(verdicts(["things:read"], false), ["things:read=granted", "things:write=unknown", "admin=unknown"]);
  assert.deepEqual(verdicts(["things:read"], true), ["things:read=granted", "things:write=refused", "admin=unknown"]);
  assert.deepEqual(verdicts(["things:read", "things:write"], true), ["things:read=granted", "things:write=granted", "admin=unknown"]);
});

// ── includes ────────────────────────────────────────────────────────────────

/**
 * Todoist's catalogue: `data:read_write` "includes task:add and data:read".
 * Asked for data:read and the write scopes, it grants data:read_write,
 * data:delete and project:delete, and doesn't name data:read.
 */
const TODOIST = (includes: boolean): ConnectorAuthPolicy => ({
  ...POLICY,
  scopes: [
    { scope: "task:add", requested: false },
    { scope: "data:read", requested: true },
    {
      scope: "data:read_write",
      requested: "write",
      ...(includes ? { includes: ["task:add", "data:read"] } : {}),
    },
    { scope: "data:delete", requested: "write" },
    { scope: "project:delete", requested: "write" },
    { scope: "backups:read", requested: false },
  ],
});
const TODOIST_GRANT = ["data:read_write", "data:delete", "project:delete"];

test("a scope included by one in the grant is granted, though the grant doesn't name it", () => {
  const verdicts = (policy: ConnectorAuthPolicy) =>
    classifyGrant(policy.scopes!, TODOIST_GRANT, { writes: true }).map((r) => `${r.scope}=${r.status}`);

  assert.deepEqual(verdicts(TODOIST(true)), [
    "task:add=unknown",
    "data:read=granted",
    "data:read_write=granted",
    "data:delete=granted",
    "project:delete=granted",
    "backups:read=unknown",
  ]);
  // Without includes, as before: held, and reported refused.
  assert.equal(verdicts(TODOIST(false))[1], "data:read=refused");

  // What Connect asks for doesn't change: data:read is still requested,
  // which a read-only install needs.
  assert.deepEqual(requestedScopes(TODOIST(true)), ["data:read"]);
  assert.deepEqual(requestedScopes(TODOIST(true), { writes: true }), [
    "data:read",
    "data:read_write",
    "data:delete",
    "project:delete",
  ]);
});
