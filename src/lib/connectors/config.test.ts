/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { refreshConnectorTokens } from "./config";
import { decrypt, encrypt } from "./encryption";
import { TOKEN_KEYS } from "./oauth";
import type { ConnectorAuthPolicy } from "./types";
import { platformKey } from "@/lib/env/keys";

// ── fixtures ────────────────────────────────────────────────────────────────

process.env.CONNECTOR_ENCRYPTION_KEY ??= randomBytes(32).toString("hex");
const key = () => platformKey("connectorEncryption");

/** The one connector_configs row the refresh reads and writes, under its lock. */
let stored: Record<string, string> | null = null;

// The pool is a lazy proxy that reads `globalThis.__pg` first
// (src/lib/db/client.ts), so a fake there stands in for Postgres.
(globalThis as { __pg?: unknown }).__pg = {
  async begin(fn: (tx: unknown) => unknown) {
    return fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      if (text.includes("pg_advisory_xact_lock")) return [];
      if (text.includes("select encrypted_credentials")) {
        return stored
          ? [{ encrypted_credentials: encrypt(JSON.stringify(stored), key()) }]
          : [];
      }
      if (text.includes("update public.connector_configs")) {
        stored = JSON.parse(decrypt(values[0] as string, key()));
        return [];
      }
      throw new Error(`unexpected query: ${text}`);
    });
  },
};

const POLICY: ConnectorAuthPolicy = {
  strategy: "oauth2_authorization_code",
  authorizeUrl: "https://provider.test/authorize",
  tokenUrl: "https://provider.test/token",
  credentialKeys: ["clientId", "clientSecret"],
};

const realFetch = globalThis.fetch;
let tokenCalls = 0;
beforeEach(() => {
  tokenCalls = 0;
  globalThis.fetch = async () => {
    tokenCalls++;
    return Response.json({ access_token: "at-new", refresh_token: "rt-2", expires_in: 3600 });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A tenant row holding `access`, which expires `inMs` from now. */
const grant = (access: string, inMs: number) => ({
  clientId: "cid",
  clientSecret: "secret",
  [TOKEN_KEYS.access]: access,
  [TOKEN_KEYS.refresh]: "rt",
  [TOKEN_KEYS.expiresAt]: String(Date.now() + inMs),
});

const refresh = (rejected?: string) =>
  refreshConnectorTokens({
    connectorName: "acme",
    subject: "Acme",
    policy: POLICY,
    skewMs: 60_000,
    rejected,
  });

// ── tests ───────────────────────────────────────────────────────────────────

test("a token the upstream refused is refreshed, though its stored expiry has not passed", async () => {
  // The lock's re-read used to see a live token and hand the refused one
  // straight back, so the replay after a 401 failed the same way.
  stored = grant("at-live", 3_600_000);
  const out = await refresh("at-live");
  assert.equal(tokenCalls, 1);
  assert.equal(out[TOKEN_KEYS.access], "at-new");
  assert.equal(stored?.[TOKEN_KEYS.access], "at-new", "the new token is saved");
  assert.equal(stored?.clientSecret, "secret", "and the client secret is untouched");
});

test("a token another request has already replaced is used, not refreshed again", async () => {
  stored = grant("at-other", 3_600_000);
  const out = await refresh("at-live");
  assert.equal(tokenCalls, 0);
  assert.equal(out[TOKEN_KEYS.access], "at-other");
});

test("an expired token is refreshed, with or without a refusal", async () => {
  stored = grant("at-old", -1_000);
  assert.equal((await refresh())[TOKEN_KEYS.access], "at-new");
  assert.equal(tokenCalls, 1);
});

test("a live token nothing refused is left alone", async () => {
  stored = grant("at-live", 3_600_000);
  assert.equal((await refresh())[TOKEN_KEYS.access], "at-live");
  assert.equal(tokenCalls, 0);
});
