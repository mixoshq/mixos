# Credentials

## How Credentials Work

Connector credentials are managed entirely through the admin UI and are never stored in code or environment variables.

1. An admin navigates to **Administration → Connectors** and enters the required credentials for each connector.
2. Credentials are encrypted using AES-256-GCM and stored in the `connector_configs` database table. The encryption key is the `CONNECTOR_ENCRYPTION_KEY` environment variable.
3. When an app context is built, credentials are decrypted server-side and passed to the connector's `initialize()` method. They never leave the server.

## Checking Configuration Status

A connector may be registered but not yet configured by an admin. Always check `configured` before making API calls to avoid cryptic errors.

```ts
// inside a defineRoute handler
const myService = context.connectors["my-service"] as MyServiceConnector | undefined;

if (!myService?.configured) {
  // Connector exists but admin hasn't entered credentials yet: answers 503
  throw AppError.unavailable("My Service is not configured. Ask an admin to set it up.");
}

// Safe to call methods
const items = await myService.listItems();
```

`AppError` comes from `@/lib/apps/route`, and `MyServiceConnector` is a type
import from `@connectors/my-service`. See [Usage in Apps](usage-in-apps.md) for
the whole route.

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

`configured` only checks that the required fields are non-empty. **Verify
connection** in the Registry runs the connector's `testConnection()` against the
real API, which is how an admin finds out a key was pasted with a trailing space
now rather than through a broken widget next week.

## Turning a connector off

**Disable** on a connector's tile at Admin > Connectors turns it off for the
whole instance, until an admin presses **Enable**. It first names the apps that
use the connector and asks you to confirm.

While a connector is disabled:

- Apps can't call it. `context.connectors.<name>` is still there, with
  `configured` false, and every method fails with a `ConnectorError` whose
  message is `<Name> has been disabled by an administrator.` Its category is
  `unconfigured`, so a route that lets it propagate answers 503, and
  `ConnectorErrorState` shows the message with no Retry. Scheduled jobs, public
  routes, App Services and MCP tools get the same.
- Its webhooks get the 401 a connector with no signing secret gets, and nothing
  is recorded, so a delivery the provider retries after it is enabled is
  processed.
- Connect, the OAuth callback and Verify connection are refused.
- An app that requires it can't be activated, or granted to anyone, until you
  enable it again. An app that was already active keeps running, and its calls
  to the connector fail as above.

Disabling keeps the credentials, and each person's grant for a user-scoped
connector, so enabling needs nothing entered again. It doesn't make a leaked
credential safe: if you suspect a leak, revoke the credential at the provider,
then enter a new one here.

---

## Caching a user-scoped response

A tenant-scoped connector returns the same thing to everyone, so a cache key
naming the app and the query is enough. A **user-scoped** connector does not,
and the same key then serves one person's data to another.

The platform cannot enforce this, and it is worth being precise about why: an
app chooses its own cache keys for whatever it caches or stores, so the
connector layer never sees them. (`createSwrCache` makes you choose: set
`userScoped: true` and every call must pass the user's id, which goes into the
key.) The rule is therefore yours to keep:

```ts
// WRONG for a user-scoped connector — one key, many people
const key = `mail:inbox:${folder}`;

// Right: the grant is per user, so the cached response is too
const key = `mail:inbox:${folder}:user:${context.user.id}`;
```

The same applies to anything else that outlives the request: a row written to an
app table, a value put in a shared store, a payload logged for debugging. If it
came from a user-scoped connector, it belongs to one person.
