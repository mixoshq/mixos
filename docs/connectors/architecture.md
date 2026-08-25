# Architecture

## Connector Structure

Each connector lives in its own directory under `/connectors` with two files: a manifest and an implementation class.

```
connectors/my-service/
  connector.json    # Metadata and credential field definitions
  index.ts          # Implementation class
```

**Templates:** any connector directory whose name starts with an underscore (e.g. `connectors/_template/`) is treated as a template and skipped by the registry. Use this for starter scaffolds you want to keep in the repo without exposing to admins.

## Connector Manifest (connector.json)

The manifest declares the connector's metadata and what credentials it needs. These fields appear in the Connector Registry admin UI where an admin can configure them.

```json
{
  "name": "my-service",
  "displayName": "My Service",
  "description": "Connector for the My Service API",
  "authors": [
    { "name": "Jane Doe", "email": "jane@example.com" }
  ],
  "credentialFields": [
    { "key": "apiKey", "label": "API Key", "type": "password" },
    { "key": "baseUrl", "label": "Base URL", "type": "text" }
  ]
}
```

### Field Reference

| Field | Required | Description | Example |
| --- | --- | --- | --- |
| `name` | ✅ | Unique identifier for the connector. Used in app.json and internally. Should be lowercase with hyphens. | `"name": "my-service"` |
| `displayName` | ✅ | Human-readable name shown in the Connector Registry admin page. | `"displayName": "My Service"` |
| `description` |  | Technical description shown to **admins** in the Connector Registry. Setup instructions, scope lists, redirect URIs all belong here. | `"description": "Connector for the My Service API; create an API key at https://example.com/keys"` |
| `authors` |  | Array of `{ name, email }` objects identifying the connector's authors. Shown in the Connector Registry admin page. Optional but recommended so others know who to contact. | `"authors": [{ "name": "Jane Doe", "email": "jane@example.com" }]` |
| `credentialFields` | ✅ | Array of credential fields the admin must provide. Each field appears as an input in the configuration form. |  |
| `credentialFields[].key` | ✅ | Property name used to access this credential in the connector's `initialize()` method. | `"key": "apiKey"` |
| `credentialFields[].label` | ✅ | Label shown in the admin configuration form. | `"label": "API Key"` |
| `credentialFields[].type` | ✅ | Either `text` for visible input or `password` for masked input. Use `password` for API keys, tokens, and secrets. | `"type": "password"` |
| `auth` |  | How the platform authenticates. See below. Absent means `{ "strategy": "none" }`. | |
| `http` |  | Transport policy: base URL, timeouts, retry budget, pagination. Every value has a working default. | |
| `webhook` |  | Inbound webhook verification. See [Webhooks](webhooks.md). | |
| `telemetry` |  | Methods to auto-instrument. See [Telemetry](telemetry.md). | |

### Declarative policy

Authentication and transport behaviour are **declared, not coded**. The manifest
is schema-validated by the registry generator, and it is `strict` — an unknown
key, a wrong type, or a cross-field contradiction aborts the build with a
message pointing at the offending path. A typo in a retry policy fails at build
time rather than degrading silently in production.

```jsonc
"auth": {
  "strategy": "apiKey",        // none | apiKey | basic | oauth2_client_credentials | oauth2_authorization_code
  "in": "header",              // apiKey: header | query | bearer (default bearer)
  "name": "X-Api-Key",         // required when in is header or query
  "prefix": "Token ",          // optional value prefix
  "credentialKeys": ["apiKey"] // must exist in credentialFields; also derives `configured`
},
"http": {
  "baseUrl": "https://api.example.com",  // a `baseUrl` credential overrides this at runtime
  "timeoutMs": 10000,                    // per attempt
  "deadlineMs": 15000,                   // whole call including retries
  "maxAttempts": 3,                      // TOTAL tries, not retries
  "retryOn": ["rate_limited", "upstream_error"],
  "rateLimitOn403": true,                // this API throttles with 403
  "defaultHeaders": { "X-Client": "mixos" },
  "maxResponseBytes": 8388608,
  "pagination": {
    "style": "cursor",                   // cursor | offset | page | link-header
    "itemsPath": "data",
    "cursorPath": "meta.next_cursor",
    "cursorParam": "cursor",
    "limitParam": "limit",
    "pageSize": 100,
    "maxPages": 50
  }
}
```

`maxAttempts` counts total tries deliberately — "maxRetries: 2 means 3 calls" is
exactly the off-by-one nobody should have to reason about.

Cross-field rules the schema enforces: an `apiKey` in a header or query must
name it; `basic` needs exactly two `credentialKeys`; the OAuth strategies need
a `tokenUrl` (and `authorizeUrl` for the three-legged flow); each pagination
style requires its own parameters; and every credential key referenced by `auth`
or `webhook` must exist in `credentialFields`.

> **Tool-written:** `lastUpdated` lives in `connector.json` as an ISO 8601 date-time (e.g. `"2026-08-24T03:21:40.694Z"`) and is stamped automatically: `.githooks/pre-commit` runs [`scripts/stamp-updated.ts`](../../scripts/stamp-updated.ts), which rewrites the date on every connector with a file in the commit and re-stages the manifest. It records when the connector last changed, so a dependency bump or a formatting pass inside it moves the date too. A commit that touches only `lastUpdated` never re-stamps. Don't edit it by hand; an invalid value fails the build. A connector with no date yet shows **"Not yet committed"**.

## How Connectors Work

Connectors follow a simple lifecycle:

1. The connector is **registered** automatically when the platform scans the `/connectors` directory and finds a valid `connector.json`.
2. An admin **configures credentials** in the Connector Registry admin page. Credentials are encrypted at rest using AES-256-GCM.
3. When an app declares a connector dependency in its `app.json`, the platform **initializes** the connector with decrypted credentials and injects it into the app context.
4. App API routes access the connector via `context.connectors.myService` and call its methods.

## Security Model

Connectors run exclusively on the server side behind the secure API gateway. App client code (pages and widgets) cannot import connector modules directly — they must call their app's API routes, which receive initialized connectors via the app context. This ensures credentials are never exposed to the browser.

## One credential set per connector

Every connector is *tenant-scoped*: an admin configures one credential set in
the Connector Registry and every user shares it.

**This includes OAuth.** A connector using the three-legged flow is still one
credential set: an admin presses **Connect** once on behalf of the whole
deployment, and the resulting tokens are stored in that connector's existing
encrypted `connector_configs` row alongside the client id and secret. Every user
of every app shares that single grant.

That is a different thing from the *user-scoped* model the platform once had, in
which each user authorized their own external account. That model is gone and
stays gone, along with the `scope` manifest field, the `OAuthCapableConnector`
interface, the `/account/connections` page, and the `user_connector_oauth`
table. Nothing here acts as an individual user.

The distinction is what makes the model safe to reason about: because there is
exactly one credential set, any response a connector returns is the same
response any user would have received.

