/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { appRegistry } from "@/generated/app-registry";
import { connectorRegistry } from "@/generated/connector-registry";
import { sql } from "@/lib/db/client";
import { platformKey } from "@/lib/env/keys";
import { decrypt, encrypt } from "./encryption";
import { ConnectorError } from "./errors";
import { TOKEN_KEYS, refreshWithToken, tokensToCredentials, type TokenSet } from "./oauth";
import type { ConnectorAuthPolicy, ConnectorManifest } from "./types";

/**
 * An app's own credentials for a tenant connector, in
 * `connector_app_configs` (supabase/migrations/0005_connector_app_configs.sql).
 *
 * A tenant connector has one credential set, shared by every app that
 * declares it (./config.ts). An admin can give one app its own instead, so
 * that app reaches the provider only with what that credential allows: a
 * narrower API key, or an OAuth grant of its own whose consent asked for the
 * write scopes only if the app may change data.
 *
 * Where it wins: everywhere the app's code reaches the connector
 * (`loadTenantConnectors`, src/lib/apps/context.ts), its activation gate
 * (src/lib/apps/connector-gates.ts) and Verify connection for it. It never
 * falls back to the shared row. One that exists and can't be read leaves the
 * app with the connector unconfigured: a narrower credential an admin chose
 * must not quietly become the broader one.
 *
 * What stays per connector: webhooks, the admin switch, and Allow changes.
 * User-scoped connectors have none: each person's grant is already their own.
 *
 * A row is a whole credential set, the client id and secret of an OAuth
 * connector included, so it is complete without the shared row. Every write
 * goes through one advisory lock per (connector, app), as the shared row's
 * do, so a token refresh can't interleave with another or with a save.
 */

/** Why an app can't hold its own credentials for a connector. */
export class AppCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppCredentialsError";
  }
}

/**
 * The connector and the app, checked: a tenant connector this build carries,
 * and an app this build carries that declares it, required or optional.
 * Every write and every admin action goes through here first.
 */
export function appCredentialTarget(
  connectorName: string,
  appSlug: string,
): { connector: ConnectorManifest; app: (typeof appRegistry)[number] } {
  const connector = connectorRegistry.find((c) => c.name === connectorName);
  if (!connector) throw new AppCredentialsError(`No connector named "${connectorName}" is in this build.`);
  if (connector.userScoped) {
    throw new AppCredentialsError(
      `${connector.displayName} is connected by each person with their own account, so an app has no credentials of its own for it.`,
    );
  }
  if ((connector.auth?.strategy ?? "none") === "none") {
    throw new AppCredentialsError(`${connector.displayName} authenticates with nothing, so there is nothing to give an app.`);
  }
  const app = appRegistry.find((a) => a.slug === appSlug);
  if (!app) throw new AppCredentialsError(`No app "${appSlug}" is in this build.`);
  if (!app.connectorRequirements.some((r) => r.name === connectorName)) {
    throw new AppCredentialsError(`${app.name} doesn't declare ${connector.displayName}.`);
  }
  return { connector, app };
}

const decryptBlob = (encrypted: string) =>
  JSON.parse(decrypt(encrypted, platformKey("connectorEncryption"))) as Record<string, string>;

/**
 * Each of one app's own credential rows, by connector name, still encrypted.
 * One query for a whole context. Throws when the table can't be read: the
 * caller can't tell then whether an app has its own, so it must not use the
 * shared row on the guess that it hasn't.
 */
export async function getAppCredentialRows(appSlug: string): Promise<Map<string, string>> {
  const rows = await sql<{ connector_name: string; encrypted_credentials: string }[]>`
    select connector_name, encrypted_credentials
      from public.connector_app_configs
     where app_slug = ${appSlug}
  `;
  return new Map(rows.map((r) => [r.connector_name, r.encrypted_credentials]));
}

/** Decrypt one row from `getAppCredentialRows`. Throws when it can't be (the key changed, say). */
export function openAppCredentials(encrypted: string): Record<string, string> {
  return decryptBlob(encrypted);
}

/** One app's own credentials for one connector, or null when it has none. Throws when unreadable. */
export async function getDecryptedAppConfig(
  connectorName: string,
  appSlug: string,
): Promise<Record<string, string> | null> {
  const rows = await sql<{ encrypted_credentials: string }[]>`
    select encrypted_credentials
      from public.connector_app_configs
     where connector_name = ${connectorName} and app_slug = ${appSlug}
  `;
  return rows[0] ? decryptBlob(rows[0].encrypted_credentials) : null;
}

/** What the admin page shows about one app's own credentials. */
export interface AppCredentialRecord {
  appSlug: string;
  /** Decrypted, for the page to derive its state from; null when the row can't be decrypted. */
  credentials: Record<string, string> | null;
  configuredAt: number | null;
  configuredBy: string | null;
  verifiedAt: number | null;
  verifiedDetail: string | null;
}

/** Every app's own credentials for one connector, for the admin page. */
export async function listAppCredentials(connectorName: string): Promise<AppCredentialRecord[]> {
  const rows = await sql<
    {
      app_slug: string;
      encrypted_credentials: string;
      updated_at: Date | null;
      display_name: string | null;
      last_verified_at: Date | null;
      last_verified_detail: string | null;
    }[]
  >`
    select c.app_slug, c.encrypted_credentials, c.updated_at, u.display_name,
           c.last_verified_at, c.last_verified_detail
      from public.connector_app_configs c
      left join public.users u on u.id = c.configured_by
     where c.connector_name = ${connectorName}
     order by c.app_slug
  `;
  const ms = (d: Date | null) => (d ? new Date(d).getTime() : null);
  return rows.map((r) => {
    let credentials: Record<string, string> | null = null;
    try {
      credentials = decryptBlob(r.encrypted_credentials);
    } catch (err) {
      console.error(`[connectors] ${connectorName}: ${r.app_slug}'s own credentials can't be decrypted:`, err);
    }
    return {
      appSlug: r.app_slug,
      credentials,
      configuredAt: ms(r.updated_at),
      configuredBy: r.display_name,
      verifiedAt: ms(r.last_verified_at),
      verifiedDetail: r.last_verified_detail,
    };
  });
}

/** Advisory-lock namespace for an app's own credentials: not the shared row's, nor a person's. */
const APP_LOCK_NAMESPACE = 0x6d69_7833 | 0; // "mix3"

/** Stable int32 from a string, for the second half of the lock key. */
function lockKeyFor(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

/**
 * Read-modify-write one app's own credentials under its lock, as
 * `mutateConnectorCredentials` does the shared row. `mutate` gets the
 * credentials as they are inside the lock and returns the patch to merge, or
 * null to leave the row alone.
 */
export async function mutateAppConnectorCredentials(
  connectorName: string,
  appSlug: string,
  mutate: (
    current: Record<string, string>,
  ) => Promise<Record<string, string> | null> | Record<string, string> | null,
  opts?: { configuredBy?: string },
): Promise<Record<string, string>> {
  return sql.begin(async (tx) => {
    await tx`
      select pg_advisory_xact_lock(${APP_LOCK_NAMESPACE}, ${lockKeyFor(`${connectorName}\0${appSlug}`)})
    `;
    const rows = await tx<{ encrypted_credentials: string }[]>`
      select encrypted_credentials
        from public.connector_app_configs
       where connector_name = ${connectorName} and app_slug = ${appSlug}
    `;
    let current: Record<string, string> = {};
    if (rows[0]) {
      try {
        current = decryptBlob(rows[0].encrypted_credentials);
      } catch (err) {
        // A row that can't be decrypted (the key changed, say) leaves the app
        // with the connector unconfigured. An admin entering its credentials
        // again starts it over, since what it held can't be read anyway. A
        // token write has nothing to start over from, and fails.
        if (!opts?.configuredBy) throw err;
        current = {};
      }
    }

    const patch = await mutate(current);
    if (patch === null) return current;

    const merged = { ...current, ...patch };
    const encrypted = encrypt(JSON.stringify(merged), platformKey("connectorEncryption"));
    const by = opts?.configuredBy ?? null;
    await tx`
      insert into public.connector_app_configs (connector_name, app_slug, encrypted_credentials, configured_by)
      values (${connectorName}, ${appSlug}, ${encrypted}, ${by})
      on conflict (connector_name, app_slug) do update
        set encrypted_credentials = excluded.encrypted_credentials,
            configured_by = coalesce(excluded.configured_by, public.connector_app_configs.configured_by),
            updated_at = now()
    `;
    return merged;
  }) as Promise<Record<string, string>>;
}

/**
 * Save what an admin typed for one app, merged over what is stored, as the
 * shared row's save is: a blank field keeps its value, and a connected grant
 * survives correcting a secret.
 */
export async function saveAppConnectorConfig(
  connectorName: string,
  appSlug: string,
  credentials: Record<string, string>,
  /** The admin saving them; null for one with no user row (a release-step actor). */
  userId: string | null,
): Promise<void> {
  appCredentialTarget(connectorName, appSlug);
  await mutateAppConnectorCredentials(connectorName, appSlug, () => credentials, {
    configuredBy: userId ?? undefined,
  });
}

/** Merge a fresh OAuth grant into one app's own credentials: only the `oauth_*` keys. */
export async function saveAppConnectorTokens(
  connectorName: string,
  appSlug: string,
  tokens: TokenSet,
): Promise<void> {
  await mutateAppConnectorCredentials(connectorName, appSlug, () => tokensToCredentials(tokens));
}

/**
 * Renew one app's own access token and persist it, under its lock: the shared
 * row's `refreshConnectorTokens`, for the app's row. Re-reads inside the lock
 * and returns early if another invocation already renewed it, so concurrent
 * requests make one call to the token endpoint. Never reads the shared row.
 */
export async function refreshAppConnectorTokens(opts: {
  connectorName: string;
  appSlug: string;
  subject: string;
  policy: ConnectorAuthPolicy;
  skewMs: number;
  rejected?: string;
}): Promise<Record<string, string>> {
  const { connectorName, appSlug, subject, policy, skewMs, rejected } = opts;
  const [idKey, secretKey] = policy.credentialKeys ?? ["clientId", "clientSecret"];
  return mutateAppConnectorCredentials(connectorName, appSlug, async (current) => {
    const expiresAt = Number(current[TOKEN_KEYS.expiresAt] ?? 0);
    const stored = current[TOKEN_KEYS.access];
    if (stored && stored !== rejected && expiresAt - skewMs > Date.now()) return null;

    const refreshToken = current[TOKEN_KEYS.refresh];
    if (!refreshToken) {
      throw new ConnectorError({
        category: "auth_failed",
        connectorName,
        subject,
        adminHint:
          "This app's own access token expired and no refresh token is stored. Open Administration → Connectors and connect the app's own credentials again.",
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

/** Record that Verify connection just succeeded with one app's own credentials. */
export async function recordAppConnectorVerified(
  connectorName: string,
  appSlug: string,
  detail: string | null,
): Promise<void> {
  await sql`
    update public.connector_app_configs
       set last_verified_at = now(), last_verified_detail = ${detail}
     where connector_name = ${connectorName} and app_slug = ${appSlug}
  `;
}

/**
 * Take one app's own credentials away, and its grant's scope record, so it
 * uses the shared credentials again. Whether a row went.
 */
export async function deleteAppConnectorConfig(connectorName: string, appSlug: string): Promise<boolean> {
  return sql.begin(async (tx) => {
    await tx`
      select pg_advisory_xact_lock(${APP_LOCK_NAMESPACE}, ${lockKeyFor(`${connectorName}\0${appSlug}`)})
    `;
    await tx`
      delete from public.connector_scope_status
       where connector_name = ${connectorName} and app_slug = ${appSlug}
    `;
    const gone = await tx`
      delete from public.connector_app_configs
       where connector_name = ${connectorName} and app_slug = ${appSlug}
    `;
    return gone.count > 0;
  }) as Promise<boolean>;
}
