/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { decrypt, encrypt } from "./encryption";
import { ConnectorError } from "./errors";
import type { ConnectorErrorCategory } from "./errors";
import { TOKEN_KEYS } from "./oauth";
import type { ConnectorAuthPolicy } from "./types";
import { freshUserGrant, refreshUserTokens } from "./user-config";
import { platformKey } from "@/lib/env/keys";

// ── fixtures ────────────────────────────────────────────────────────────────

const NOW = 1_760_000_000_000;
const SKEW = 60_000;
const opts = { skewMs: SKEW, now: NOW };

/** A stored grant whose access token expires `inMs` from NOW. */
const grant = (inMs: number) => ({
  [TOKEN_KEYS.access]: "at-old",
  [TOKEN_KEYS.refresh]: "rt",
  [TOKEN_KEYS.expiresAt]: String(NOW + inMs),
});

const RENEWED = {
  [TOKEN_KEYS.access]: "at-new",
  [TOKEN_KEYS.refresh]: "rt",
  [TOKEN_KEYS.expiresAt]: String(NOW + 3_600_000),
};

/** A refresh that counts its calls, and answers with `outcome`. */
function refresher(outcome: Record<string, string> | Error) {
  const calls = { n: 0 };
  const refresh = async () => {
    calls.n++;
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return { refresh, calls };
}

const failure = (category: ConnectorErrorCategory) =>
  new ConnectorError({ category, connectorName: "mail", subject: "Mail" });

// ── tests ───────────────────────────────────────────────────────────────────

test("a live grant is handed over as it is, without a refresh", async () => {
  const { refresh, calls } = refresher(RENEWED);
  const stored = grant(3_600_000);
  assert.deepEqual(await freshUserGrant(stored, refresh, opts), stored);
  assert.equal(calls.n, 0);
});

test("an expired grant is renewed before it is handed over", async () => {
  // The case that used to reach the connector expired: it then refreshed the
  // tenant row, found no refresh token there, and failed as auth_failed.
  const { refresh, calls } = refresher(RENEWED);
  assert.deepEqual(await freshUserGrant(grant(-1_000), refresh, opts), RENEWED);
  assert.equal(calls.n, 1);
});

test("a token inside the expiry skew already counts as expired", async () => {
  const { refresh, calls } = refresher(RENEWED);
  await freshUserGrant(grant(SKEW - 1), refresh, opts);
  assert.equal(calls.n, 1);
});

test("a grant the provider will not renew is no grant at all", async () => {
  // Revoked, expired, or never given a refresh token: the person connects again.
  const { refresh } = refresher(failure("auth_failed"));
  assert.equal(await freshUserGrant(grant(-1_000), refresh, opts), null);
});

test("a token endpoint having a bad moment does not disconnect anyone", async () => {
  for (const category of ["network_error", "timeout", "rate_limited", "upstream_error"] as const) {
    const { refresh } = refresher(failure(category));
    const stored = grant(-1_000);
    assert.deepEqual(
      await freshUserGrant(stored, refresh, opts),
      stored,
      `${category} must hand over the stored grant, to be renewed again on first use`,
    );
  }
});

test("someone who never connected has no grant, and nothing is refreshed", async () => {
  const { refresh, calls } = refresher(RENEWED);
  assert.equal(await freshUserGrant(null, refresh, opts), null);
  assert.equal(calls.n, 0);
});

test("a failure that is not the provider's is not swallowed", async () => {
  const { refresh } = refresher(new Error("decryption failed"));
  await assert.rejects(freshUserGrant(grant(-1_000), refresh, opts), /decryption failed/);
});

// ── renewing after a 401 ────────────────────────────────────────────────────

process.env.USER_OAUTH_ENCRYPTION_KEY ??= randomBytes(32).toString("hex");
const userKey = () => platformKey("userOauthEncryption");

/** The person's user_connector_oauth row, read and written under its lock. */
let row: Record<string, string> | null = null;

// The pool is a lazy proxy that reads `globalThis.__pg` first
// (src/lib/db/client.ts), so a fake there stands in for Postgres.
(globalThis as { __pg?: unknown }).__pg = {
  async begin(fn: (tx: unknown) => unknown) {
    return fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      if (text.includes("pg_advisory_xact_lock")) return [];
      if (text.includes("select encrypted_credentials")) {
        return row ? [{ encrypted_credentials: encrypt(JSON.stringify(row), userKey()) }] : [];
      }
      if (text.includes("insert into public.user_connector_oauth")) {
        row = JSON.parse(decrypt(values[2] as string, userKey()));
        return [];
      }
      throw new Error(`unexpected query: ${text}`);
    });
  },
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const MAIL: ConnectorAuthPolicy = {
  strategy: "oauth2_authorization_code",
  authorizeUrl: "https://provider.test/authorize",
  tokenUrl: "https://provider.test/token",
};

test("a user token the upstream refused is renewed, though its stored expiry has not passed", async () => {
  let tokenCalls = 0;
  globalThis.fetch = async () => {
    tokenCalls++;
    return Response.json({ access_token: "at-new", expires_in: 3600 });
  };
  row = {
    [TOKEN_KEYS.access]: "at-live",
    [TOKEN_KEYS.refresh]: "rt",
    [TOKEN_KEYS.expiresAt]: String(Date.now() + 3_600_000),
  };
  const out = await refreshUserTokens({
    userId: "user-1",
    connectorName: "mail",
    subject: "Mail",
    policy: MAIL,
    clientId: "cid",
    clientSecret: "secret",
    skewMs: 60_000,
    rejected: "at-live",
  });
  assert.equal(tokenCalls, 1);
  assert.equal(out[TOKEN_KEYS.access], "at-new");
  assert.equal(row?.[TOKEN_KEYS.access], "at-new", "the new token is saved to the person's row");
});
