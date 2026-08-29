/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { getAppOrigin } from "@/lib/env/origin";
import { platformKey } from "@/lib/env/keys";

/**
 * Crypto and metadata for MixOS-as-OAuth-2.1-authorization-server.
 *
 * This is MixOS acting as an authorization *server*: MCP clients authenticate
 * *to* MixOS. Nothing here reaches out to a third-party identity provider.
 *
 * Security model:
 *  - Clients are PUBLIC — no client_secret is ever issued. PKCE S256 is the
 *    proof of possession, per OAuth 2.1 for native/browser clients.
 *  - Codes and tokens are high-entropy random strings, stored only as HMAC
 *    digests. A DB leak yields nothing replayable without the HMAC key, which
 *    is derived from CONNECTOR_ENCRYPTION_KEY (an env secret, not Postgres).
 *  - HMAC, not bcrypt: these are 256-bit random values, so there is nothing to
 *    brute-force, and lookup has to be by exact digest. (The app *passwords* in
 *    app-password-store.ts use bcrypt because those are low-entropy and
 *    human-chosen — different problem, different tool.)
 *  - Tokens are opaque, not JWTs. Revocation must take effect on the very next
 *    request, and that is worth one indexed lookup per call.
 */

/** Scope string this AS issues. Read-only is the only mode MixOS supports today. */
export const MCP_SCOPE = "mcp:read";

export const ACCESS_TOKEN_TTL_SEC = 60 * 60; // 1 hour
export const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 60 * 60; // 30 days
export const AUTH_CODE_TTL_SEC = 60; // 1 minute — exchanged immediately

/**
 * Key used to digest codes and tokens before storage.
 *
 * Its own environment variable (`MCP_TOKEN_KEY`) rather than a derivative of
 * `CONNECTOR_ENCRYPTION_KEY`. Rotating it invalidates every issued MCP token and
 * code — clients re-authorize — and touches nothing else. See
 * `src/lib/env/keys.ts` for the full inventory and each key's blast radius.
 */
function getTokenKey(): Buffer {
  return platformKey("mcpToken");
}

/** Digest a code or token for storage/lookup. Never store the raw value. */
export function hashSecret(raw: string): string {
  return createHmac("sha256", getTokenKey()).update(raw).digest("base64url");
}

function randomSecret(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export const newAuthorizationCode = () => randomSecret("mix_ac");
export const newAccessToken = () => randomSecret("mix_at");
export const newRefreshToken = () => randomSecret("mix_rt");
export const newClientId = () => randomSecret("mix_client");

/**
 * Verify a PKCE code_verifier against the stored S256 challenge.
 * `plain` is not accepted — OAuth 2.1 requires S256 where the client can do it,
 * and every MCP client can.
 */
export function verifyPkce(
  codeVerifier: string,
  storedChallenge: string,
): boolean {
  // RFC 7636: 43–128 chars from the unreserved set.
  if (codeVerifier.length < 43 || codeVerifier.length > 128) return false;
  const computed = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  const a = Buffer.from(computed);
  const b = Buffer.from(storedChallenge);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The canonical resource identifier for the MixOS MCP server (RFC 8707). Clients
 * send this as `resource` on authorize and token requests; we reject mismatches
 * so a token minted for MixOS cannot be replayed at another resource server.
 *
 * Origin comes from `getAppOrigin()` (NEXTAUTH_URL), never the Host header — a
 * host-injection would otherwise let an attacker steer redirect URIs.
 */
export function mcpResourceUri(): string {
  return `${getAppOrigin()}/api/mcp`;
}

/**
 * `resource` is optional (older clients omit it) but must match when present.
 * A trailing slash is tolerated; nothing else is.
 */
export function isValidResource(resource: string | null | undefined): boolean {
  if (!resource) return true;
  return resource.replace(/\/$/, "") === mcpResourceUri();
}

/** RFC 9728 protected-resource metadata. */
export function protectedResourceMetadata() {
  const origin = getAppOrigin();
  return {
    resource: mcpResourceUri(),
    authorization_servers: [origin],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "MixOS",
    resource_documentation: `${origin}/apps/guide`,
  };
}

/** RFC 8414 authorization-server metadata. */
export function authorizationServerMetadata() {
  const origin = getAppOrigin();
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    revocation_endpoint: `${origin}/api/oauth/revoke`,
    scopes_supported: [MCP_SCOPE],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    // Public clients only — PKCE is the client authentication.
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    revocation_endpoint_auth_methods_supported: ["none"],
    service_documentation: `${origin}/apps/guide`,
  };
}

/**
 * The `WWW-Authenticate` header every 401 from /api/mcp must carry. Without the
 * `resource_metadata` hint a client has no way to discover the authorization
 * server, and the whole flow silently fails to start. This is the single
 * easiest thing to omit and the hardest to debug from the client side.
 */
export function wwwAuthenticateHeader(
  error: "invalid_token" | "invalid_request" = "invalid_token",
): string {
  const metadataUrl = `${getAppOrigin()}/.well-known/oauth-protected-resource`;
  return `Bearer realm="MixOS", error="${error}", resource_metadata="${metadataUrl}"`;
}

/**
 * Validate a client-supplied redirect_uri against the exact set registered for
 * that client. Exact string match only — no prefix matching, no wildcards, no
 * normalization beyond what the client registered. This is the control that
 * stops an attacker from redirecting an authorization code to themselves.
 */
export function isRegisteredRedirectUri(
  candidate: string,
  registered: readonly string[],
): boolean {
  return registered.includes(candidate);
}

/**
 * Redirect URIs we are willing to register. `https` anywhere, plus `http` on
 * loopback only (RFC 8252 — how Claude Desktop and MCP Inspector do local
 * dev). Custom schemes (e.g. `claude://`) are allowed for native clients.
 * Rejects fragments, which OAuth forbids on redirect URIs.
 */
export function isAcceptableRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.hash) return false;
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol === "http:") {
    return (
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "::1" ||
      parsed.hostname === "[::1]"
    );
  }
  // Native app custom scheme, e.g. "claude://oauth/callback".
  return (
    /^[a-z][a-z0-9+.-]*:$/.test(parsed.protocol) &&
    parsed.protocol !== "javascript:"
  );
}
