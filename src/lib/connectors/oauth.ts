/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getAppOrigin } from "@/lib/env/origin";
import { decrypt, encrypt } from "./encryption";
import { ConnectorError } from "./errors";
import {
  classifyStatus,
  extractRequestId,
  isRateLimitExhausted,
  isSuccess,
  parseRetryAfter,
} from "./status-map";
import type { ConnectorAuthPolicy } from "./types";
import { platformKey } from "@/lib/env/keys";

/**
 * Tenant-level three-legged OAuth.
 *
 * One admin consents once on behalf of the whole deployment; the resulting
 * tokens live in that connector's existing `connector_configs` row alongside
 * the client id and secret. This is NOT the per-user model that was removed —
 * there is still exactly one credential set per connector, shared by everyone.
 *
 * The PKCE verifier never leaves this server: it travels in an encrypted,
 * HttpOnly cookie, while the provider only ever sees an opaque random `state`.
 * Putting the verifier in `state` would hand it to the very party PKCE binds
 * the code against.
 */

/** Reserved credential keys holding the OAuth grant. Never admin-entered. */
export const TOKEN_KEYS = {
  access: "oauth_access_token",
  refresh: "oauth_refresh_token",
  expiresAt: "oauth_expires_at",
  scope: "oauth_scope",
} as const;

export const OAUTH_STATE_COOKIE = "mos_connector_oauth";
/** The consent round trip is a few seconds of real time; 10 minutes is slack. */
const FLOW_TTL_MS = 10 * 60 * 1000;

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Epoch millis. */
  expiresAt: number;
  scope?: string;
}

/** Persisted form of a TokenSet, merged into the credentials blob. */
export function tokensToCredentials(t: TokenSet): Record<string, string> {
  const out: Record<string, string> = {
    [TOKEN_KEYS.access]: t.accessToken,
    [TOKEN_KEYS.expiresAt]: String(t.expiresAt),
  };
  if (t.refreshToken) out[TOKEN_KEYS.refresh] = t.refreshToken;
  if (t.scope) out[TOKEN_KEYS.scope] = t.scope;
  return out;
}

// ── The redirect URI ────────────────────────────────────────────────────────

/**
 * Where the provider sends the admin back. Built from the configured origin,
 * never from a request header — a host injection here would let an attacker
 * steer the redirect and capture an authorization code.
 */
export function redirectUriFor(connectorName: string): string {
  return `${getAppOrigin()}/api/connectors/${encodeURIComponent(connectorName)}/oauth/callback`;
}

// ── PKCE + flow state ───────────────────────────────────────────────────────

export interface OAuthFlowState {
  connector: string;
  /**
   * Who started this flow, for a user-scoped connector. Checked against the
   * session at the callback: without it, a session that changes mid-round-trip
   * writes one person's grant onto another person's row, which is the worst
   * failure available in this file. Null for a tenant flow, which has no owner
   * beyond "an admin".
   */
  userId: string | null;
  /** Opaque value echoed by the provider; the CSRF binding. */
  state: string;
  /** S256 verifier. Stays server-side. */
  codeVerifier: string;
  returnTo: string;
  exp: number;
}

export function newFlowState(
  connector: string,
  returnTo: string,
  userId: string | null = null,
): OAuthFlowState {
  return {
    connector,
    userId,
    state: randomBytes(32).toString("base64url"),
    // RFC 7636 allows 43–128 chars; 43 bytes of entropy encodes to 43+.
    codeVerifier: randomBytes(48).toString("base64url"),
    returnTo: safeReturnPath(returnTo),
    exp: Date.now() + FLOW_TTL_MS,
  };
}

export function codeChallengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Encrypted (AES-256-GCM) so the cookie is opaque and tamper-evident. */
export function sealFlowState(flow: OAuthFlowState): string {
  return encrypt(JSON.stringify(flow), platformKey("connectorEncryption"));
}

export function openFlowState(
  sealed: string | undefined,
): OAuthFlowState | null {
  if (!sealed) return null;
  try {
    const flow = JSON.parse(
      decrypt(sealed, platformKey("connectorEncryption")),
    ) as OAuthFlowState;
    if (typeof flow.state !== "string" || typeof flow.codeVerifier !== "string")
      return null;
    if (!Number.isFinite(flow.exp) || flow.exp < Date.now()) return null;
    return flow;
  } catch {
    // A cookie encrypted under a rotated key, or tampered with. Either way the
    // flow cannot continue and the admin simply starts again.
    return null;
  }
}

/** Constant-time compare of the echoed `state` against the sealed one. */
export function stateMatches(
  fromProvider: string,
  fromCookie: string,
): boolean {
  const a = Buffer.from(fromProvider);
  const b = Buffer.from(fromCookie);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Only same-origin relative paths. An open redirect here would be handed to the
 * admin at the end of an OAuth flow, which is exactly when they are least
 * likely to look at the address bar.
 */
export function safeReturnPath(input: string | null | undefined): string {
  const fallback = "/admin/connectors";
  if (!input) return fallback;
  if (!input.startsWith("/")) return fallback;
  if (input.startsWith("//")) return fallback;
  if (input.includes("\\")) return fallback;
  return input;
}

// ── Authorize URL ───────────────────────────────────────────────────────────

/**
 * The scopes actually sent at authorization time.
 *
 * `auth.scopes` carries every scope the provider documents so the registry can
 * show what an API offers; only entries flagged `requested` are ones this
 * connector asks for.
 */
export function requestedScopes(policy: ConnectorAuthPolicy): string[] {
  return (policy.scopes ?? []).filter((s) => s.requested).map((s) => s.scope);
}

export function buildAuthorizeUrl(
  policy: ConnectorAuthPolicy,
  opts: { connector: string; clientId: string; flow: OAuthFlowState },
): string {
  if (!policy.authorizeUrl) {
    throw new Error(
      `connector "${opts.connector}" declares no auth.authorizeUrl.`,
    );
  }
  const url = new URL(policy.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", redirectUriFor(opts.connector));
  url.searchParams.set("state", opts.flow.state);
  url.searchParams.set(
    "code_challenge",
    codeChallengeFor(opts.flow.codeVerifier),
  );
  url.searchParams.set("code_challenge_method", "S256");
  // Only the requested subset. `scopes` is the provider's whole catalogue, so
  // sending it unfiltered would ask consent for every permission the API has.
  const requested = requestedScopes(policy);
  if (requested.length) url.searchParams.set("scope", requested.join(" "));
  return url.toString();
}

// ── Token endpoint ──────────────────────────────────────────────────────────

interface TokenRequest {
  policy: ConnectorAuthPolicy;
  clientId: string;
  clientSecret: string;
  params: Record<string, string>;
  connectorName: string;
  subject: string;
  timeoutMs: number;
}

/**
 * The one path to a token endpoint — shared by client-credentials minting,
 * authorization-code exchange, and refresh.
 *
 * Deliberately does not go through `HttpConnector.request()`: that would
 * recurse straight back into the auth layer it exists to serve.
 */
export async function requestToken(req: TokenRequest): Promise<TokenSet> {
  const { policy, clientId, clientSecret, params, connectorName, subject } =
    req;
  if (!policy.tokenUrl) {
    throw new Error(`connector "${connectorName}" declares no auth.tokenUrl.`);
  }

  const body = new URLSearchParams(params);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };

  if ((policy.tokenAuth ?? "basic") === "basic") {
    const raw = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
    headers.authorization = `Basic ${Buffer.from(raw, "utf-8").toString("base64")}`;
  } else {
    body.set("client_id", clientId);
    if (clientSecret) body.set("client_secret", clientSecret);
  }

  let res: Response;
  try {
    res = await fetch(policy.tokenUrl, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(req.timeoutMs),
    });
  } catch (err) {
    const aborted =
      err instanceof Error &&
      (err.name === "TimeoutError" || err.name === "AbortError");
    throw new ConnectorError({
      category: aborted ? "timeout" : "network_error",
      connectorName,
      subject,
      cause: err,
    });
  }

  const requestId = extractRequestId(res.headers);

  if (!isSuccess(res.status)) {
    const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
    let { category } = classifyStatus(res.status, {
      hasRetryAfter: retryAfterMs != null,
      rateLimitExhausted: isRateLimitExhausted(res.headers),
    });
    // OAuth reports a bad client or a dead refresh token with 400
    // (invalid_client / invalid_grant) at least as often as with 401. Any
    // non-throttle 4xx here means the stored grant is unusable, which is an
    // admin problem — they need to reconnect.
    if (res.status >= 400 && res.status < 500 && category !== "rate_limited") {
      category = "auth_failed";
    }
    throw new ConnectorError({
      category,
      connectorName,
      subject,
      status: res.status,
      retryAfterMs,
      upstreamRequestId: requestId,
    });
  }

  // Parsed by hand so a non-JSON body is a clean `unexpected_response`. The
  // body holds live tokens: never logged, never attached to an error.
  let parsed: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  try {
    parsed = JSON.parse(await res.text()) as typeof parsed;
  } catch (err) {
    throw new ConnectorError({
      category: "unexpected_response",
      connectorName,
      subject,
      status: res.status,
      upstreamRequestId: requestId,
      cause: err,
    });
  }

  if (!parsed.access_token) {
    throw new ConnectorError({
      category: "auth_failed",
      connectorName,
      subject,
      status: res.status,
      upstreamRequestId: requestId,
    });
  }

  // RFC 6749 allows expires_in to be omitted; an hour is the conventional
  // assumption and a wrong guess only costs one extra refresh.
  const ttlMs =
    typeof parsed.expires_in === "number" && parsed.expires_in > 0
      ? parsed.expires_in * 1000
      : 3_600_000;

  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresAt: Date.now() + ttlMs,
    scope: parsed.scope,
  };
}

export async function exchangeAuthorizationCode(opts: {
  policy: ConnectorAuthPolicy;
  connectorName: string;
  subject: string;
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  timeoutMs?: number;
}): Promise<TokenSet> {
  const tokens = await requestToken({
    policy: opts.policy,
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    connectorName: opts.connectorName,
    subject: opts.subject,
    timeoutMs: opts.timeoutMs ?? 10_000,
    params: {
      grant_type: "authorization_code",
      code: opts.code,
      redirect_uri: redirectUriFor(opts.connectorName),
      code_verifier: opts.codeVerifier,
    },
  });
  return { ...tokens, scope: grantedScope(tokens.scope, opts.policy) };
}

/**
 * The scope a code exchange granted, as a space-delimited string.
 *
 * RFC 6749 §5.1 makes `scope` OPTIONAL in a token response "if identical to
 * the scope requested by the client", so a provider that omits it is saying
 * "granted as requested" — not "granted nothing". Read the second way, every
 * requested scope was recorded as Refused on a connector holding all of them.
 *
 * Only the code exchange reads it this way. A refresh that omits `scope` keeps
 * the grant it renewed, and the stored `oauth_scope` is left as it was.
 */
export function grantedScope(
  responseScope: string | null | undefined,
  policy: ConnectorAuthPolicy,
): string | undefined {
  if (responseScope != null) return responseScope;
  const requested = requestedScopes(policy);
  return requested.length > 0 ? requested.join(" ") : undefined;
}

export function refreshWithToken(opts: {
  policy: ConnectorAuthPolicy;
  connectorName: string;
  subject: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  timeoutMs?: number;
}): Promise<TokenSet> {
  return requestToken({
    policy: opts.policy,
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    connectorName: opts.connectorName,
    subject: opts.subject,
    timeoutMs: opts.timeoutMs ?? 10_000,
    params: { grant_type: "refresh_token", refresh_token: opts.refreshToken },
  });
}
