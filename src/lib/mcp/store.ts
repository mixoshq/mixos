/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { sql } from "@/lib/db/client";
import {
  ACCESS_TOKEN_TTL_SEC,
  AUTH_CODE_TTL_SEC,
  REFRESH_TOKEN_TTL_SEC,
  hashSecret,
  newAccessToken,
  newAuthorizationCode,
  newClientId,
  newRefreshToken,
} from "./oauth";

/**
 * Persistence for the MCP OAuth authorization server.
 *
 * Uses the raw `sql` tag rather than the Supabase client on purpose: every
 * query here turns on an expiry comparison combined with a conditional update
 * (claim-and-consume), which PostgREST cannot express in one round trip.
 * Platform code may reach the raw client; app code may not (enforced by
 * eslint.config.mjs). Same precedent as src/lib/analytics/queries.ts.
 *
 * Nothing in this module ever returns a raw code or token read back from the
 * database — they are not stored in a recoverable form. Raw values exist only
 * in the return value of the `create*` functions, which hand them straight to
 * the client and forget them.
 */

export interface OAuthClientRow {
  clientId: string;
  clientName: string;
  redirectUris: string[];
}

export interface TokenPrincipal {
  userId: string;
  clientId: string;
  clientName: string;
  /** App slugs the user consented to for this client. A ceiling, not a grant. */
  grantedApps: string[];
}

// ── Clients ─────────────────────────────────────────────────────────────────

export async function registerClient(args: {
  clientName: string;
  redirectUris: string[];
}): Promise<OAuthClientRow> {
  const clientId = newClientId();
  await sql`
    insert into public.oauth_clients (client_id, client_name, redirect_uris)
    values (${clientId}, ${args.clientName}, ${args.redirectUris})
  `;
  return { clientId, clientName: args.clientName, redirectUris: args.redirectUris };
}

export async function getClient(clientId: string): Promise<OAuthClientRow | null> {
  const rows = await sql<
    { client_id: string; client_name: string; redirect_uris: string[] }[]
  >`
    select client_id, client_name, redirect_uris
    from public.oauth_clients
    where client_id = ${clientId}
    limit 1
  `;
  if (rows.length === 0) return null;
  return {
    clientId: rows[0].client_id,
    clientName: rows[0].client_name,
    redirectUris: rows[0].redirect_uris,
  };
}

async function touchClient(clientId: string): Promise<void> {
  await sql`
    update public.oauth_clients set last_used_at = now() where client_id = ${clientId}
  `;
}

// ── Authorization codes ─────────────────────────────────────────────────────

/** Mint a single-use authorization code. Returns the RAW code — store nothing. */
export async function createAuthorizationCode(args: {
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  grantedApps: string[];
}): Promise<string> {
  const code = newAuthorizationCode();
  await sql`
    insert into public.oauth_authorization_codes
      (code_hash, client_id, user_id, redirect_uri, code_challenge, granted_apps, expires_at)
    values (
      ${hashSecret(code)}, ${args.clientId}, ${args.userId}, ${args.redirectUri},
      ${args.codeChallenge}, ${args.grantedApps},
      now() + make_interval(secs => ${AUTH_CODE_TTL_SEC})
    )
  `;
  return code;
}

export interface ConsumedCode {
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  grantedApps: string[];
}

/**
 * Atomically consume an authorization code. Returns null if the code is
 * unknown, expired, or already consumed — the caller maps all three to
 * `invalid_grant` so a probe cannot distinguish them.
 *
 * The `consumed_at is null` predicate lives in the UPDATE's WHERE clause, so
 * two concurrent exchanges of the same code cannot both succeed: exactly one
 * update matches a row. Rows are marked rather than deleted so a replay is
 * visible in the table rather than looking like an unknown code.
 */
export async function consumeAuthorizationCode(
  rawCode: string,
): Promise<ConsumedCode | null> {
  const rows = await sql<
    {
      client_id: string;
      user_id: string;
      redirect_uri: string;
      code_challenge: string;
      granted_apps: string[];
    }[]
  >`
    update public.oauth_authorization_codes
    set consumed_at = now()
    where code_hash = ${hashSecret(rawCode)}
      and consumed_at is null
      and expires_at > now()
    returning client_id, user_id, redirect_uri, code_challenge, granted_apps
  `;
  if (rows.length === 0) return null;
  return {
    clientId: rows[0].client_id,
    userId: rows[0].user_id,
    redirectUri: rows[0].redirect_uri,
    codeChallenge: rows[0].code_challenge,
    grantedApps: rows[0].granted_apps,
  };
}

// ── Tokens ──────────────────────────────────────────────────────────────────

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
}

/**
 * Issue an access/refresh pair. Returns RAW tokens; only digests are persisted.
 * `grantedApps` is carried forward verbatim from the code (or from the refresh
 * token being rotated), so a refresh can never widen consent.
 */
export async function issueTokens(args: {
  clientId: string;
  userId: string;
  grantedApps: string[];
}): Promise<IssuedTokens> {
  const accessToken = newAccessToken();
  const refreshToken = newRefreshToken();

  // One multi-row INSERT rather than `sql.begin` — a single statement is
  // already atomic, and it sidesteps the `this`-binding question that the lazy
  // Proxy around `sql` (src/lib/db/client.ts) raises for transaction helpers.
  await sql`
    insert into public.oauth_tokens
      (token_hash, token_type, client_id, user_id, granted_apps, expires_at)
    values
      (
        ${hashSecret(accessToken)}, 'access', ${args.clientId}, ${args.userId},
        ${args.grantedApps}, now() + make_interval(secs => ${ACCESS_TOKEN_TTL_SEC})
      ),
      (
        ${hashSecret(refreshToken)}, 'refresh', ${args.clientId}, ${args.userId},
        ${args.grantedApps}, now() + make_interval(secs => ${REFRESH_TOKEN_TTL_SEC})
      )
  `;

  void touchClient(args.clientId);
  return { accessToken, refreshToken, expiresInSec: ACCESS_TOKEN_TTL_SEC };
}

/**
 * Resolve a bearer access token to its principal, or null when it is unknown,
 * expired, or revoked. Also bumps `last_used_at` so `/account/mcp` can show
 * the user which clients are actually active.
 */
export async function resolveAccessToken(
  rawToken: string,
): Promise<TokenPrincipal | null> {
  const rows = await sql<
    {
      user_id: string;
      client_id: string;
      client_name: string;
      granted_apps: string[];
    }[]
  >`
    update public.oauth_tokens t
    set last_used_at = now()
    from public.oauth_clients c
    where t.token_hash = ${hashSecret(rawToken)}
      and t.token_type = 'access'
      and t.revoked_at is null
      and t.expires_at > now()
      and c.client_id = t.client_id
    returning t.user_id, t.client_id, c.client_name, t.granted_apps
  `;
  if (rows.length === 0) return null;
  return {
    userId: rows[0].user_id,
    clientId: rows[0].client_id,
    clientName: rows[0].client_name,
    grantedApps: rows[0].granted_apps,
  };
}

/**
 * Consume a refresh token, revoking it in the same statement (rotation). Returns
 * null when unknown/expired/already-used, which the token endpoint maps to
 * `invalid_grant`.
 */
export async function rotateRefreshToken(
  rawToken: string,
): Promise<TokenPrincipal | null> {
  const rows = await sql<
    {
      user_id: string;
      client_id: string;
      client_name: string;
      granted_apps: string[];
    }[]
  >`
    update public.oauth_tokens t
    set revoked_at = now()
    from public.oauth_clients c
    where t.token_hash = ${hashSecret(rawToken)}
      and t.token_type = 'refresh'
      and t.revoked_at is null
      and t.expires_at > now()
      and c.client_id = t.client_id
    returning t.user_id, t.client_id, c.client_name, t.granted_apps
  `;
  if (rows.length === 0) return null;
  return {
    userId: rows[0].user_id,
    clientId: rows[0].client_id,
    clientName: rows[0].client_name,
    grantedApps: rows[0].granted_apps,
  };
}

/**
 * RFC 7009 revocation. Revokes the presented token and — because a client that
 * asks to revoke means "end this session" — every other live token this client
 * holds for the same user. Idempotent and silent by design: the spec requires
 * 200 even for an unknown token, so a caller cannot probe validity here.
 */
export async function revokeToken(rawToken: string): Promise<void> {
  await sql`
    update public.oauth_tokens
    set revoked_at = now()
    where revoked_at is null
      and (user_id, client_id) in (
        select user_id, client_id from public.oauth_tokens
        where token_hash = ${hashSecret(rawToken)}
      )
  `;
}

/** Revoke everything a client holds for one user. Used by /account/mcp. */
export async function revokeClientForUser(
  userId: string,
  clientId: string,
): Promise<void> {
  await sql`
    update public.oauth_tokens
    set revoked_at = now()
    where user_id = ${userId} and client_id = ${clientId} and revoked_at is null
  `;
  await sql`
    delete from public.oauth_authorization_codes
    where user_id = ${userId} and client_id = ${clientId} and consumed_at is null
  `;
}

export interface AuthorizedClientSummary {
  clientId: string;
  clientName: string;
  grantedApps: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
}

/**
 * Live authorizations for one user, newest first. "Live" means at least one
 * unrevoked, unexpired refresh token — an access token alone expires in an hour
 * and its absence doesn't mean the user revoked anything.
 */
export async function listAuthorizedClients(
  userId: string,
): Promise<AuthorizedClientSummary[]> {
  const rows = await sql<
    {
      client_id: string;
      client_name: string;
      granted_apps: string[];
      created_at: Date;
      last_used_at: Date | null;
    }[]
  >`
    select * from (
      -- DISTINCT ON keeps the newest live refresh token per client, so
      -- granted_apps reflects the most recent consent. (An aggregate won't do:
      -- array_agg over a text[] yields a 2-D array, and subscripting that with
      -- a single index returns NULL rather than the first element.)
      select distinct on (t.client_id)
        t.client_id, c.client_name, t.granted_apps, t.created_at, t.last_used_at
      from public.oauth_tokens t
      join public.oauth_clients c on c.client_id = t.client_id
      where t.user_id = ${userId}
        and t.token_type = 'refresh'
        and t.revoked_at is null
        and t.expires_at > now()
      order by t.client_id, t.created_at desc
    ) s
    order by s.last_used_at desc nulls last, s.created_at desc
  `;
  return rows.map((r) => ({
    clientId: r.client_id,
    clientName: r.client_name,
    grantedApps: r.granted_apps ?? [],
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  }));
}

/**
 * Best-effort cleanup of expired codes and long-dead tokens. Called
 * opportunistically from the token endpoint rather than on a schedule — these
 * tables are small and the sweep is cheap, and it keeps the MCP feature from
 * needing a scheduled job of its own.
 */
export async function sweepExpired(): Promise<void> {
  try {
    await sql`delete from public.oauth_authorization_codes where expires_at < now() - interval '1 day'`;
    await sql`delete from public.oauth_tokens where expires_at < now() - interval '7 days'`;
  } catch (err) {
    console.error("[mcp] sweepExpired failed:", err);
  }
}
