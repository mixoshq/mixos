/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  TOKEN_KEYS,
  exchangeAuthorizationCode,
  grantedScope,
  oauthReturnUrl,
  safeReturnPath,
  tokensToCredentials,
} from "./oauth";
import { classifyGrant } from "./scope-status";
import type { ConnectorAuthPolicy } from "./types";

// ── fixtures ────────────────────────────────────────────────────────────────

// The code exchange sends this deployment's redirect URI, built from its origin.
process.env.NEXTAUTH_URL ??= "https://mos.test";

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
  const url = oauthReturnUrl("/admin/connectors?connector=gmail", "https://mos.test", "gmail", "connected");
  assert.equal(url.origin, "https://mos.test");
  assert.equal(url.pathname, "/admin/connectors");
  assert.deepEqual(url.searchParams.getAll("connector"), ["gmail"]);
  assert.equal(url.searchParams.get("oauth"), "connected");

  assert.equal(
    oauthReturnUrl("/account/connections", "https://mos.test", "mail", "denied").href,
    "https://mos.test/account/connections?connector=mail&oauth=denied",
  );
});

test("a return path that would resolve to another host is refused", () => {
  // A URL parser drops tabs and newlines, so "/\t/evil.example" is read as
  // "//evil.example": another host, though it starts with a single slash.
  for (const path of ["/\t/evil.example", "/\n/evil.example", "/\r/evil.example"]) {
    assert.equal(safeReturnPath(path), "/admin/connectors", JSON.stringify(path));
    assert.equal(
      oauthReturnUrl(path, "https://mos.test", "gmail", "connected").origin,
      "https://mos.test",
      JSON.stringify(path),
    );
  }
});
