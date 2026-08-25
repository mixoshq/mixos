# Credentials

## How Credentials Work

Connector credentials are managed entirely through the admin UI and are never stored in code or environment variables.

1. An admin navigates to **Administration → Connector Registry** and enters the required credentials for each connector.
2. Credentials are encrypted using AES-256-GCM and stored in the `connector_configs` database table. The encryption key is the `CONNECTOR_ENCRYPTION_KEY` environment variable.
3. When an app context is built, credentials are decrypted server-side and passed to the connector's `initialize()` method. They never leave the server.

## Checking Configuration Status

A connector may be registered but not yet configured by an admin. Always check `configured` before making API calls to avoid cryptic errors.

```ts
const myService = context.connectors["my-service"];

if (!myService?.configured) {
  // Connector exists but admin hasn't entered credentials yet
  return NextResponse.json(
    { error: "Connector not configured. Ask an admin to set it up." },
    { status: 503 }
  );
}

// Safe to call methods
const data = await myService.getItems();
```

## Updating Credentials

Credentials can be updated at any time through the Connector Registry admin page. The new credentials take effect on the next request — no restart required. The platform decrypts credentials fresh each time an app context is built.

## Security Controls

- **Admin-only access.** The `configureConnector` server action calls `requireAdmin()` to verify the caller is a database-level admin before saving credentials. This check is independent of the edge middleware role check.
- **Server-only reads.** `connector_configs` is read exclusively by trusted server code (`getDecryptedConfig` in `src/lib/connectors/config.ts`). The browser bundle never imports or queries it; the only way an app reaches credentials is via the platform's `buildAppContext` flow, which decrypts and injects them into the connector instance per request.
- **Encryption at rest.** Credentials are encrypted with AES-256-GCM before storage. See the [Security Architecture](../security-architecture.md) doc for the full encryption scheme.


## Tenant OAuth

A connector declaring `auth.strategy: "oauth2_authorization_code"` needs one
extra step after the client id and secret are saved: an admin presses
**Connect** in the Connector Registry.

1. The Registry shows the redirect URI for this deployment. Register it with the
   provider first — the flow cannot complete without it.
2. **Connect** starts the consent round trip with PKCE. The verifier travels in
   an encrypted, HttpOnly cookie, never in `state`: the provider sees `state`,
   and handing it the verifier would defeat the binding PKCE exists to create.
3. The callback exchanges the code and merges `oauth_access_token`,
   `oauth_refresh_token`, and `oauth_expires_at` into the same encrypted row.
   Token write-back can only *add* those reserved keys — it can never overwrite
   the client id and secret an admin typed.
4. Before any call whose token has expired, the platform refreshes it under a
   Postgres advisory lock, re-reading inside the lock so concurrent invocations
   produce one refresh rather than several. This matters: providers commonly
   rotate the refresh token on use, and losing that race invalidates the grant
   permanently.

`configured` returns **false** for a three-legged connector that has a client id
and secret but no grant — an admin who filled the form and never pressed Connect
has a connector where no call can succeed, and saying otherwise would be a lie.

Reserved credential keys (`oauth_access_token`, `oauth_refresh_token`,
`oauth_expires_at`, `oauth_scope`) are written by the platform. Never declare
them in `credentialFields`, and never read them from a connector method.

## Proving credentials work

`configured` only checks that the required fields are non-empty. **Test
Connection** in the Registry runs the connector's `testConnection()` against the
real API, which is how an admin finds out a key was pasted with a trailing space
now rather than through a broken widget next week.
