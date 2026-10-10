/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { sql } from "@/lib/db/client";
import { decrypt, encrypt } from "./encryption";
import { ConnectorError, isConnectorError } from "./errors";
import { TOKEN_KEYS, refreshWithToken, tokensToCredentials } from "./oauth";
import type { TokenSet } from "./oauth";
import type { ConnectorAuthPolicy } from "./types";
import { platformKey } from "@/lib/env/keys";

/**
 * Per-user OAuth grants, for connectors declaring `userScoped`.
 *
 * The mirror of `config.ts`, with one difference that runs through everything
 * here: **only the grant is personal.** The client id and secret stay in
 * `connector_configs` where an admin put them, so nothing in this file can
 * read or write a credential an admin typed, and revoking one person's access
 * cannot disturb the application registration.
 *
 * Every write takes the same advisory lock as the tenant path. Two concurrent
 * requests refreshing one person's token would otherwise race, and against a
 * provider that rotates the refresh token on use, the loser's write
 * permanently invalidates the grant.
 */

const USER_LOCK_NAMESPACE = 0x6d69_7832 | 0; // "mix2"

/** Stable int32 from a string, for the second half of the advisory lock key. */
function lockKeyFor(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

export async function getUserTokens(
  userId: string,
  connectorName: string,
): Promise<Record<string, string> | null> {
  const rows = await sql<{ encrypted_credentials: string }[]>`
    select encrypted_credentials
      from public.user_connector_oauth
     where user_id = ${userId} and connector_name = ${connectorName}
  `;
  if (!rows[0]) return null;
  return JSON.parse(
    decrypt(rows[0].encrypted_credentials, platformKey("userOauthEncryption")),
  ) as Record<string, string>;
}

/**
 * Read-modify-write one person's grant under the lock.
 *
 * `mutate` receives the tokens as they exist *inside* the lock and returns the
 * patch to merge, or null to leave the row alone — which is how the refresh
 * path says "someone else already did this".
 */
async function mutateUserTokens(
  userId: string,
  connectorName: string,
  mutate: (
    current: Record<string, string>,
  ) => Promise<Record<string, string> | null> | Record<string, string> | null,
): Promise<Record<string, string>> {
  return sql.begin(async (tx) => {
    await tx`
      select pg_advisory_xact_lock(
        ${USER_LOCK_NAMESPACE},
        ${lockKeyFor(`${userId}:${connectorName}`)}
      )
    `;

    const rows = await tx<{ encrypted_credentials: string }[]>`
      select encrypted_credentials
        from public.user_connector_oauth
       where user_id = ${userId} and connector_name = ${connectorName}
    `;
    const current: Record<string, string> = rows[0]
      ? (JSON.parse(
          decrypt(
            rows[0].encrypted_credentials,
            platformKey("userOauthEncryption"),
          ),
        ) as Record<string, string>)
      : {};

    const patch = await mutate(current);
    if (patch === null) return current;

    const merged = { ...current, ...patch };
    const encrypted = encrypt(
      JSON.stringify(merged),
      platformKey("userOauthEncryption"),
    );

    await tx`
      insert into public.user_connector_oauth
        (user_id, connector_name, encrypted_credentials)
      values (${userId}, ${connectorName}, ${encrypted})
      on conflict (user_id, connector_name) do update
        set encrypted_credentials = excluded.encrypted_credentials,
            updated_at = now()
    `;
    return merged;
  }) as Promise<Record<string, string>>;
}

export async function saveUserTokens(
  userId: string,
  connectorName: string,
  tokens: TokenSet,
): Promise<void> {
  await mutateUserTokens(userId, connectorName, () =>
    tokensToCredentials(tokens),
  );
}

/** Forget one person's grant. The application registration is untouched. */
export async function deleteUserTokens(
  userId: string,
  connectorName: string,
): Promise<void> {
  await sql`
    delete from public.user_connector_oauth
     where user_id = ${userId} and connector_name = ${connectorName}
  `;
}

/**
 * Refresh one person's expired access token and persist it, under the lock.
 *
 * The client id and secret come from the caller — they are tenant credentials
 * this module deliberately cannot read for itself.
 */
export async function refreshUserTokens(opts: {
  userId: string;
  connectorName: string;
  subject: string;
  policy: ConnectorAuthPolicy;
  clientId: string;
  clientSecret: string;
  /** Treat a token expiring within this window as already expired. */
  skewMs: number;
  /**
   * The access token the upstream just refused with a 401, when this refresh
   * follows one. It is renewed even if its stored expiry has not passed.
   */
  rejected?: string;
}): Promise<Record<string, string>> {
  const {
    userId,
    connectorName,
    subject,
    policy,
    clientId,
    clientSecret,
    skewMs,
    rejected,
  } = opts;

  return mutateUserTokens(userId, connectorName, async (current) => {
    const expiresAt = Number(current[TOKEN_KEYS.expiresAt] ?? 0);
    const stored = current[TOKEN_KEYS.access];
    // A live token means another request refreshed while we waited for the
    // lock — unless it is the token the upstream just refused, which has to be
    // renewed rather than handed back.
    if (stored && stored !== rejected && expiresAt - skewMs > Date.now()) {
      return null;
    }

    const refreshToken = current[TOKEN_KEYS.refresh];
    if (!refreshToken) {
      throw new ConnectorError({
        category: "auth_failed",
        connectorName,
        subject,
        adminHint:
          "This user's access token expired and no refresh token is stored. " +
          "They need to reconnect from My Connections.",
      });
    }

    const tokens = await refreshWithToken({
      policy,
      connectorName,
      subject,
      clientId,
      clientSecret,
      refreshToken,
    });
    return tokensToCredentials(tokens);
  });
}

/**
 * A stored grant, made usable: handed back as it is while its access token is
 * live, renewed through `refresh` once it has expired, or null when there is
 * nothing usable — never connected, or a grant the provider will no longer
 * renew.
 *
 * Takes the stored tokens and the refresh as arguments so the rule can be
 * tested without a database; `getValidUserTokens` supplies both.
 */
export async function freshUserGrant(
  stored: Record<string, string> | null,
  refresh: () => Promise<Record<string, string>>,
  opts: { skewMs: number; now?: number },
): Promise<Record<string, string> | null> {
  if (!stored) return null;

  const expiresAt = Number(stored[TOKEN_KEYS.expiresAt] ?? 0);
  if (stored[TOKEN_KEYS.access] && expiresAt - opts.skewMs > (opts.now ?? Date.now())) {
    return stored;
  }

  try {
    return await refresh();
  } catch (err) {
    if (!isConnectorError(err)) throw err;
    // The provider will not renew it — revoked, expired, or a grant that never
    // came with a refresh token. That is "not connected", and the person
    // connects again, exactly as someone who never had.
    if (err.category === "auth_failed") return null;
    // Anything else is the token endpoint having a bad moment, not a dead
    // grant. Hand over what is stored: the connector refreshes again on first
    // use, and if that fails too the caller gets a retryable error rather than
    // a prompt to reconnect an account that is fine.
    return stored;
  }
}

/**
 * This person's grant for one user-scoped connector, refreshed first if its
 * access token has expired, or null when they hold no usable grant. Called
 * before a request runs, so `configured` describes the grant as it is rather
 * than as it was when it was last written.
 */
export async function getValidUserTokens(opts: {
  userId: string;
  connectorName: string;
  /** Renews the grant under its lock — `refreshUserTokens`, bound to the caller. */
  refresh: () => Promise<Record<string, string>>;
  /** Treat a token expiring within this window as already expired. */
  skewMs: number;
}): Promise<Record<string, string> | null> {
  return freshUserGrant(
    await getUserTokens(opts.userId, opts.connectorName),
    opts.refresh,
    { skewMs: opts.skewMs },
  );
}

/** Which user-scoped connectors this person has actually connected. */
export async function listUserConnections(
  userId: string,
): Promise<
  { connectorName: string; connectedAt: number; expiresAt: number | null }[]
> {
  const rows = await sql<
    {
      connector_name: string;
      encrypted_credentials: string;
      updated_at: Date;
    }[]
  >`
    select connector_name, encrypted_credentials, updated_at
      from public.user_connector_oauth
     where user_id = ${userId}
  `;
  return rows.map((r) => {
    // Only an expiry timestamp is derived here; no token ever leaves this file.
    let expiresAt: number | null = null;
    try {
      const creds = JSON.parse(
        decrypt(r.encrypted_credentials, platformKey("userOauthEncryption")),
      ) as Record<string, string>;
      const raw = Number(creds[TOKEN_KEYS.expiresAt] ?? 0);
      expiresAt = Number.isFinite(raw) && raw > 0 ? raw : null;
    } catch {
      expiresAt = null;
    }
    return {
      connectorName: r.connector_name,
      connectedAt: new Date(r.updated_at).getTime(),
      expiresAt,
    };
  });
}
