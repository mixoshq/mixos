import { createServiceClient } from "@/lib/db/server";
import { sql } from "@/lib/db/client";
import { encrypt, decrypt } from "./encryption";
import { ConnectorError } from "./errors";
import { TOKEN_KEYS, refreshWithToken, tokensToCredentials } from "./oauth";
import type { TokenSet } from "./oauth";
import type { ConnectorAuthPolicy } from "./types";

export async function getDecryptedConfig(
  connectorName: string
): Promise<Record<string, string> | null> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("connector_configs")
    .select("encrypted_credentials")
    .eq("connector_name", connectorName)
    .single();

  if (!data) return null;
  return JSON.parse(decrypt(data.encrypted_credentials));
}

export async function saveConnectorConfig(
  connectorName: string,
  credentials: Record<string, string>,
  userId: string
): Promise<void> {
  const encrypted = encrypt(JSON.stringify(credentials));
  const supabase = createServiceClient();

  await supabase.from("connector_configs").upsert(
    {
      connector_name: connectorName,
      encrypted_credentials: encrypted,
      configured_by: userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "connector_name" }
  );
}

export async function isConnectorConfigured(
  connectorName: string
): Promise<boolean> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("connector_configs")
    .select("connector_name")
    .eq("connector_name", connectorName)
    .single();

  return !!data;
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
      ? (JSON.parse(decrypt(rows[0].encrypted_credentials)) as Record<string, string>)
      : {};

    const patch = await mutate(current);
    if (patch === null) return current;

    const merged = { ...current, ...patch };
    const encrypted = encrypt(JSON.stringify(merged));

    if (rows[0]) {
      await tx`
        update public.connector_configs
           set encrypted_credentials = ${encrypted}, updated_at = now()
         where connector_name = ${connectorName}
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
  await mutateConnectorCredentials(connectorName, () => tokensToCredentials(tokens));
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
  const [idKey, secretKey] = policy.credentialKeys ?? ["clientId", "clientSecret"];

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
