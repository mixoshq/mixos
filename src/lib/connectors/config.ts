/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createServiceClient } from "@/lib/db/server";
import { sql } from "@/lib/db/client";
import { encrypt, decrypt } from "./encryption";
import { ConnectorError } from "./errors";
import { TOKEN_KEYS, refreshWithToken, tokensToCredentials } from "./oauth";
import type { TokenSet } from "./oauth";
import type { ConnectorAuthPolicy } from "./types";
import { platformKey } from "@/lib/env/keys";

export async function getDecryptedConfig(
  connectorName: string,
): Promise<Record<string, string> | null> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("connector_configs")
    .select("encrypted_credentials")
    .eq("connector_name", connectorName)
    .single();

  if (!data) return null;
  return JSON.parse(
    decrypt(data.encrypted_credentials, platformKey("connectorEncryption")),
  );
}

/**
 * Save the credentials an admin typed into the Connector Registry, MERGED over
 * whatever is already stored.
 *
 * WHY MERGE, AND NOT OVERWRITE. This wrote the blob it was handed, whole. The
 * admin form only submits the fields the admin actually filled in, so the two
 * together silently destroyed data: re-saving a *connected* three-legged
 * connector — to correct a mistyped client secret, say — wrote `{clientId,
 * clientSecret}` over a row that also held `oauth_access_token` and
 * `oauth_refresh_token`, disconnecting it with no warning and no way to tell
 * from the page that it had happened. Leaving a password field blank erased
 * that secret for the same reason.
 *
 * Merging is also what makes the form's "leave blank to keep the current value"
 * hint true rather than aspirational. The tradeoff is deliberate: a credential
 * cannot be *cleared* through this path, only replaced. Nothing in the UI
 * offers clearing, and silently wiping a live grant is the worse failure.
 *
 * Goes through the advisory lock like every other credential write, so it
 * cannot interleave with a concurrent token refresh.
 */
export async function saveConnectorConfig(
  connectorName: string,
  credentials: Record<string, string>,
  userId: string,
): Promise<void> {
  await mutateConnectorCredentials(connectorName, () => credentials, {
    configuredBy: userId,
  });
}

export async function isConnectorConfigured(
  connectorName: string,
): Promise<boolean> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("connector_configs")
    .select("connector_name")
    .eq("connector_name", connectorName)
    .single();

  return !!data;
}

/** What the registry knows about a connector's row, beyond its credentials. */
export interface ConnectorVerification {
  verifiedAt: number | null;
  /** The connector's own short, non-sensitive confirmation line. */
  detail: string | null;
  /**
   * When the credentials were last saved, and who saved them.
   *
   * Deliberately `updated_at` and not `configured_at`: `configured_by` is
   * overwritten on every save, so pairing it with the original setup date
   * would render "Configured 12 Jan by Bob" when Alice set it up in January
   * and Bob only changed a secret in March. Both halves of this pair describe
   * the same event.
   */
  configuredAt: number | null;
  /** Display name of whoever last saved, or null if that user is gone. */
  configuredBy: string | null;
}

/**
 * Read the last successful verification.
 *
 * Kept out of the credential blob deliberately: that blob is handed verbatim to
 * a connector's `initialize()`, and a verification timestamp is not a
 * credential — putting it there would ship a key the connector never declared
 * into every connector instance.
 */
export async function getConnectorVerification(
  connectorName: string,
): Promise<ConnectorVerification> {
  // A LEFT JOIN rather than a PostgREST embed: one round trip, an exact join
  // condition, and a row that still comes back when `configured_by` points at a
  // deleted user instead of vanishing.
  const rows = await sql<
    {
      last_verified_at: Date | null;
      last_verified_detail: string | null;
      updated_at: Date | null;
      display_name: string | null;
    }[]
  >`
    select c.last_verified_at,
           c.last_verified_detail,
           c.updated_at,
           u.display_name
      from public.connector_configs c
      left join public.users u on u.id = c.configured_by
     where c.connector_name = ${connectorName}
  `;

  const row = rows[0];
  const ms = (d: Date | null | undefined) => {
    const t = d ? new Date(d).getTime() : NaN;
    return Number.isFinite(t) ? t : null;
  };

  return {
    verifiedAt: ms(row?.last_verified_at),
    detail: row?.last_verified_detail ?? null,
    configuredAt: ms(row?.updated_at),
    configuredBy: row?.display_name ?? null,
  };
}

/**
 * Record that Test Connection just succeeded.
 *
 * Only ever called on success — a failed test leaves the previous timestamp
 * alone rather than clearing it, because "it worked on Tuesday" is still true
 * and more useful than a blank. The failure itself is shown live in the dialog.
 */
export async function recordConnectorVerified(
  connectorName: string,
  detail: string | null,
): Promise<void> {
  const supabase = createServiceClient();
  await supabase
    .from("connector_configs")
    .update({
      last_verified_at: new Date().toISOString(),
      last_verified_detail: detail,
    })
    .eq("connector_name", connectorName);
}

// ── OAuth token persistence ─────────────────────────────────────────────────

/**
 * Advisory-lock namespace for connector credential mutations. Any int works;
 * it only has to be stable and not collide with another subsystem's locks.
 */
const CONNECTOR_LOCK_NAMESPACE = 0x6d6f_7331 | 0; // "mos1"

/** Stable int32 from a connector name, for the second half of the lock key. */
function lockKeyFor(connectorName: string): number {
  let h = 2166136261;
  for (let i = 0; i < connectorName.length; i++) {
    h ^= connectorName.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

/**
 * Read-modify-write a connector's encrypted credential blob under a Postgres
 * advisory lock, so two concurrent writers cannot clobber each other.
 *
 * `mutate` receives the credentials as they exist *inside* the lock and returns
 * the patch to merge, or null to leave the row untouched. Returning null is how
 * a caller says "someone else already did this" — see the refresh path below.
 *
 * The lock is transaction-scoped, so it is released when the transaction ends,
 * including on error. Note the tradeoff: a network call inside `mutate` holds
 * both the lock and a pool connection for its duration. That is deliberate for
 * token refresh — the alternative is two invocations refreshing at once, and
 * with a provider that rotates refresh tokens on use that permanently
 * invalidates the credential.
 */
export async function mutateConnectorCredentials(
  connectorName: string,
  mutate: (
    current: Record<string, string>,
  ) => Promise<Record<string, string> | null> | Record<string, string> | null,
  /** Records the admin behind an interactive save. Omitted by token writes,
   *  which are the platform acting on its own, not a person. */
  opts?: { configuredBy?: string },
): Promise<Record<string, string>> {
  return sql.begin(async (tx) => {
    await tx`
      select pg_advisory_xact_lock(${CONNECTOR_LOCK_NAMESPACE}, ${lockKeyFor(connectorName)})
    `;

    const rows = await tx<{ encrypted_credentials: string }[]>`
      select encrypted_credentials
        from public.connector_configs
       where connector_name = ${connectorName}
    `;

    const current: Record<string, string> = rows[0]
      ? (JSON.parse(
          decrypt(
            rows[0].encrypted_credentials,
            platformKey("connectorEncryption"),
          ),
        ) as Record<string, string>)
      : {};

    const patch = await mutate(current);
    if (patch === null) return current;

    const merged = { ...current, ...patch };
    const encrypted = encrypt(
      JSON.stringify(merged),
      platformKey("connectorEncryption"),
    );

    const configuredBy = opts?.configuredBy;
    if (rows[0]) {
      if (configuredBy) {
        await tx`
          update public.connector_configs
             set encrypted_credentials = ${encrypted},
                 configured_by = ${configuredBy},
                 updated_at = now()
           where connector_name = ${connectorName}
        `;
      } else {
        await tx`
          update public.connector_configs
             set encrypted_credentials = ${encrypted}, updated_at = now()
           where connector_name = ${connectorName}
        `;
      }
    } else if (configuredBy) {
      await tx`
        insert into public.connector_configs (connector_name, encrypted_credentials, configured_by)
        values (${connectorName}, ${encrypted}, ${configuredBy})
      `;
    } else {
      await tx`
        insert into public.connector_configs (connector_name, encrypted_credentials)
        values (${connectorName}, ${encrypted})
      `;
    }
    return merged;
  }) as Promise<Record<string, string>>;
}

/**
 * Merge freshly granted OAuth tokens into a connector's credentials.
 *
 * Only ever *adds* the reserved `oauth_*` keys — it can never overwrite the
 * client id and secret an admin typed in, which is the one thing a token
 * write-back must not be able to do.
 */
export async function saveConnectorTokens(
  connectorName: string,
  tokens: TokenSet,
): Promise<void> {
  await mutateConnectorCredentials(connectorName, () =>
    tokensToCredentials(tokens),
  );
}

/**
 * Refresh an expired access token and persist the result, under the lock.
 *
 * Re-reads inside the lock and returns early if another invocation already
 * refreshed — that check is what turns a stampede of concurrent requests into
 * exactly one call to the token endpoint. The refresh token used is the one
 * read *inside* the lock, never the caller's stale copy.
 */
export async function refreshConnectorTokens(opts: {
  connectorName: string;
  subject: string;
  policy: ConnectorAuthPolicy;
  /** Treat a token expiring within this window as already expired. */
  skewMs: number;
}): Promise<Record<string, string>> {
  const { connectorName, subject, policy, skewMs } = opts;
  const [idKey, secretKey] = policy.credentialKeys ?? [
    "clientId",
    "clientSecret",
  ];

  return mutateConnectorCredentials(connectorName, async (current) => {
    const expiresAt = Number(current[TOKEN_KEYS.expiresAt] ?? 0);
    if (current[TOKEN_KEYS.access] && expiresAt - skewMs > Date.now()) {
      // Another invocation refreshed while we waited for the lock.
      return null;
    }

    const refreshToken = current[TOKEN_KEYS.refresh];
    if (!refreshToken) {
      throw new ConnectorError({
        category: "auth_failed",
        connectorName,
        subject,
        adminHint:
          "This connector's access token expired and no refresh token is stored. Open the Connector Registry and reconnect it.",
      });
    }

    const tokens = await refreshWithToken({
      policy,
      connectorName,
      subject,
      clientId: current[idKey] ?? "",
      clientSecret: current[secretKey] ?? "",
      refreshToken,
    });
    return tokensToCredentials(tokens);
  });
}
