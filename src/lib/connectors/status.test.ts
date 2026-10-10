/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { connectorConfigState, registryConfigState } from "./status";
import type { ConnectorAuthPolicy } from "./types";

// ── fixtures ────────────────────────────────────────────────────────────────

const CLIENT = { clientId: "cid", clientSecret: "secret" };
const GRANT = { oauth_access_token: "at", oauth_refresh_token: "rt" };

const threeLegged: ConnectorAuthPolicy = {
  strategy: "oauth2_authorization_code",
  credentialKeys: ["clientId", "clientSecret"],
};
const clientFields = [{ key: "clientId" }, { key: "clientSecret" }];

// ── a connector that asks for nothing ───────────────────────────────────────

test("a connector that declares no credential fields is ready with nothing saved", () => {
  // A public API. There is nothing an admin could enter, so "unconfigured"
  // would be permanent.
  assert.equal(connectorConfigState({ strategy: "none" }, null, []), "ready");
  assert.equal(connectorConfigState(undefined, {}, []), "ready");
});

test("a connector with fields still waits for them to be filled in", () => {
  const fields = [{ key: "baseUrl" }];
  assert.equal(connectorConfigState({ strategy: "none" }, {}, fields), "unconfigured");
  assert.equal(
    connectorConfigState({ strategy: "none" }, { baseUrl: "https://x.test" }, fields),
    "ready",
  );
});

test("a strategy that authenticates is never ready on an empty declaration", () => {
  // The build rejects this manifest; the rule must not paper over it either.
  assert.equal(connectorConfigState({ strategy: "apiKey" }, {}, []), "unconfigured");
});

test("without the manifest's fields the rule is unchanged", () => {
  assert.equal(connectorConfigState({ strategy: "none" }, {}), "unconfigured");
  assert.equal(connectorConfigState({ strategy: "none" }, { token: "t" }), "ready");
});

// ── the registry's question ─────────────────────────────────────────────────

test("a user-scoped connector is configured once its application is saved", () => {
  const manifest = { auth: threeLegged, credentialFields: clientFields, userScoped: true };
  // The tenant row never holds a grant for a user-scoped connector, so asking
  // it for one said "needs authorization" however complete the setup was.
  assert.equal(registryConfigState(manifest, CLIENT), "ready");
  assert.equal(registryConfigState(manifest, { clientId: "cid" }), "unconfigured");
  assert.equal(registryConfigState(manifest, null), "unconfigured");
});

test("a tenant three-legged connector still needs its grant", () => {
  const manifest = { auth: threeLegged, credentialFields: clientFields };
  assert.equal(registryConfigState(manifest, CLIENT), "needs-authorization");
  assert.equal(registryConfigState(manifest, { ...CLIENT, ...GRANT }), "ready");
});

test("the registry and the runtime agree about a connector that asks for nothing", () => {
  const manifest = { auth: { strategy: "none" as const }, credentialFields: [] };
  assert.equal(registryConfigState(manifest, null), "ready");
  assert.equal(
    registryConfigState(manifest, null),
    connectorConfigState(manifest.auth, null, manifest.credentialFields),
  );
});
