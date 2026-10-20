# Connectors (App-Side View)

## Overview

Connectors are reusable integrations with external services like monday.com, Slack, or any third-party API. They live in the `/connectors` directory and are shared across apps. An admin configures connector credentials in the Connector Registry, and apps declare which connectors they need in their `app.json`.

For the authoring side (how to build a connector), see [the connectors guide](../connectors/).

## Using a Connector in Your App

To use a connector, add an entry for it to the `connectors` array in your `app.json`: its name, the version you built against, and `"access": "write"` if the app changes data in it. The platform will automatically load, initialize, and inject the connector into your app context.

```json
// app.json
{
  "name": "My App",
  "connectors": [
    { "name": "monday", "version": "3.0.1", "access": "write" },
    { "name": "slack", "version": "1.4.0" }
  ]
}
```

`version` comes from the connector's `connector.json`. Any later release with
the same major version satisfies it, because within a major version a connector
only adds; the build fails on one that doesn't satisfy it. `"access"` is
`"read"` unless it says `"write"`, which the app needs to call a method the
connector declares `mutates`, and which the connector's admin must also allow
(see [Changing data](../connectors/architecture.md#changing-data)). The app can
call the connector's declared methods and nothing else.

A connector that only part of the app uses goes in `optionalConnectors` instead. It is built into `context.connectors` the same way, but an admin can activate and grant the app before it is configured, so the part that uses it must cope without it.

Access initialized connectors via `context.connectors` in your API routes, and in the jobs, syncs, services and MCP tools that are handed `context`. Pages and widgets get no `context`: they call the app's own routes (see [API Routes](./api-routes.md#calling-from-a-widget-or-client-page)).

```ts
// In an API route handler
const monday = context.connectors.monday;
const contacts = await monday.getContacts({ limit: 10 });

const slack = context.connectors.slack;
const messages = await slack.getMessages({ channel: "C0123456789" });
```

## Creating a Connector

Each connector has a directory under `/connectors` with a manifest, an implementation and an icon:

```
connectors/my-service/
  connector.json    # Metadata, credential fields, setup guide
  index.ts          # Implementation class
  assets/
    icon.svg        # Required: an SVG with a viewBox, or a square PNG/WebP of at least 512x512
```

See [connectors/architecture.md](../connectors/architecture.md) and [connectors/implementation.md](../connectors/implementation.md) for full details.

## Connector Manifest (connector.json)

Declares the connector's metadata, what credentials it needs, and how to get them. These fields appear in the Connector Registry admin UI.

```json
{
  "name": "my-service",
  "displayName": "My Service",
  "version": "1.0.0",
  "icon": "assets/icon.svg",
  "description": "Project tracking for small teams.",
  "setup": {
    "title": "Create an API key",
    "steps": [
      {
        "text": "Open API keys and create a key with read access.",
        "link": { "label": "API keys", "url": "https://myservice.example.com/settings/api-keys" }
      }
    ]
  },
  "credentialFields": [
    { "key": "apiKey", "label": "API Key", "type": "password" },
    { "key": "baseUrl", "label": "Base URL (optional)", "type": "text" }
  ],
  "auth": {
    "strategy": "apiKey",
    "credentialKeys": ["apiKey"],
    "scopesUrl": "https://docs.myservice.example.com/api/scopes"
  },
  "http": { "baseUrl": "https://api.myservice.example.com" },
  "telemetry": [{ "method": "listItems", "operation": "GET /items", "description": "Listed items" }]
}
```

| Field | Required | Description | Example |
| --- | --- | --- | --- |
| `name` | ✅ | Unique identifier for the connector, matching its folder name. Used in app.json and internally. | `"name": "my-service"` |
| `displayName` | ✅ | Human-readable name shown in the Connector Registry. | `"displayName": "My Service"` |
| `version` | ✅ | This release, `X.Y.Z`. Apps name the version they were built against. See [Versions](../connectors/architecture.md#versions). | `"version": "1.0.0"` |
| `icon` | ✅ | The registry tile's icon, a path inside the connector's `assets/` written with that prefix. | `"icon": "assets/icon.svg"` |
| `description` |  | What the service is, in a sentence or two. Max 140 characters. | `"description": "Project tracking for small teams."` |
| `setup.title` | ✅ | Label for the provider-side step of the Configure wizard. | `"title": "Create an API key"` |
| `setup.steps` | ✅ | At least one step: what the admin does in the provider's own console. | `{ "text": "Open API keys and create a key." }` |
| `credentialFields` |  | Array of credential fields the admin must provide. Omit it only for a connector that needs no credentials (`auth.strategy` `none`), which is ready as soon as it is installed. |  |
| `credentialFields[].key` | ✅ | Property name used to access this credential in the connector's initialize method. | `"key": "apiKey"` |
| `credentialFields[].label` | ✅ | Label shown in the admin configuration form. | `"label": "API Key"` |
| `credentialFields[].type` | ✅ | Either `text` for visible input or `password` for masked input. | `"type": "password"` |
| `auth` |  | How the platform authenticates. Absent means `{ "strategy": "none" }`, a public API. Any other strategy needs `auth.scopesUrl`, the provider's page listing its scopes. | `"auth": { "strategy": "apiKey", "credentialKeys": ["apiKey"], "scopesUrl": "https://…" }` |
| `telemetry` | ✅ | One entry per public method of the class, `{ method, operation, description?, mutates? }`, with the provider operation it calls. The build fails on a public method that isn't listed, or two naming the same operation. | `"telemetry": [{ "method": "listItems", "operation": "GET /items" }]` |

The build fails on a connector missing any required field, and checks the icon's shape. The full reference is [connectors/architecture.md](../connectors/architecture.md#field-reference); what the registry needs, and why, is [the registry contract](../connectors/registry-ux.md#the-registry-contract).

## Connector Implementation

The `index.ts` file default-exports a class that extends `HttpConnector`, which applies the manifest's `auth` and `http` policy: authentication, timeouts, retries and typed errors. You write `testConnection()` and the methods apps call. The platform calls `initialize()` with decrypted credentials before the connector is passed to any app.

```ts
// connectors/my-service/index.ts
import { HttpConnector } from "@/lib/connectors/http-connector";
import type { ConnectorTestResult } from "@/lib/connectors/types";

export default class MyServiceConnector extends HttpConnector {
  readonly name = "my-service";

  async testConnection(): Promise<ConnectorTestResult> {
    await this.request("/me");
    return { ok: true };
  }

  async listItems(params?: { limit?: number }) {
    return this.request<{ id: string; name: string }[]>("/items", undefined, {
      query: { limit: params?.limit ?? 20 },
    });
  }
}
```

See [connectors/implementation.md](../connectors/implementation.md) for pagination, errors and writes.

## What a Connector Owes a Long Pull

A connector method that a scheduled job or a multi-page backfill will call has obligations beyond returning data. Get these wrong and the job times out, or keeps burning API quota after the platform has already abandoned it.

**Accept an `AbortSignal` and compose it with your own timeout.** A job and a route both pass `ctx.signal`. Either way the method must stop when the caller gives up, *and* still enforce its own per-request ceiling:

```ts
async getCalendarEvents(opts: { /* … */ signal?: AbortSignal }) {
  // Whichever fires first wins — the caller abandoning us, or our own timeout.
  const signal = AbortSignal.any([
    ...(opts.signal ? [opts.signal] : []),
    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  ]);
  // …pass `signal` to every fetch, and check it between pages.
}
```

**Let the caller choose the fields.** Asking the upstream for only the columns that get used (`$select` on Graph, an explicit field list elsewhere) is the biggest saving after page size, but which columns those are is the app's knowledge, not the connector's. Take the list as an optional parameter that defaults to the whole record, and let the job pass the fields its mapper reads. A projection fixed inside the connector fits the app that wrote it and makes the next one change the connector.

**Size pages for round trips, not bytes.** Round trips dominate a multi-page pull far more than payload size does — raising the Graph calendar page size from 100 to 500 took a 9-month mailbox pull from 101s to 52s on its own.

**Handle `Retry-After`, and make the wait cancellable.** Honor the header when present, fall back to bounded exponential backoff, cap the total wait, and cap the retry count. Crucially, `sleep()` must accept the signal — an uncancellable backoff will happily outlive the job that started it:

```ts
if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
  const retryAfter = Number(res.headers.get("Retry-After"));
  const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
    ? Math.min(retryAfter * 1000, MAX_RETRY_WAIT_MS)
    : Math.min(1000 * 2 ** attempt, MAX_RETRY_WAIT_MS);
  await sleep(waitMs, signal);
  continue;
}
```

Retry and throttling belong **here**, in the connector, not repeated in every app that calls it. See the Gmail connector's [`index.ts`](https://github.com/italianst4/mixos-connector-gmail/blob/main/index.ts) for a worked example, and [Data Freshness](data-freshness.md) for how the calling job budgets around it.

## Credential Lifecycle

Connector credentials are managed entirely through the admin UI:

- An admin configures credentials in **Administration → Connector Registry**
- Credentials are encrypted at rest in the database
- When an app context is built, credentials are decrypted and passed to `initialize()`
- If a connector has no saved credentials, it will still be available in `context.connectors` but `configured` will be `false` — unless it declares no credential fields at all, in which case there is nothing to save and it is ready
- If an admin has disabled a connector, it is still in `context.connectors` with `configured` `false`, and every call fails with a `ConnectorError` saying an administrator disabled it. Let it propagate and the app shows that message. See [Turning a connector off](../connectors/credentials.md#turning-a-connector-off)

## User-Scoped (Per-User) Connectors

Some connectors authenticate each logged-in user against an external IdP (e.g. Slack, Google Calendar) instead of using a single admin-configured credential set. **Apps don't declare scope — the connector itself does.** Apps just list connector names:

```json
{
  "connectors": [
    { "name": "monday", "version": "3.0.1" },
    { "name": "dock", "version": "1.0.0" },
    { "name": "slack", "version": "1.4.0" }
  ]
}
```

A connector declares this itself: **`"userScoped": true` in its `connector.json`**. There is no inference from the class, and no naming convention — the manifest field is the whole answer, and the schema requires `auth.strategy` to be `oauth2_authorization_code` alongside it, since a shared API key cannot represent "each person's own account".

When it is set, each request merges the **logged-in user's** stored access token into the credentials passed to `initialize()`, renewing it first if it has expired; the client id and secret stay tenant-wide, so the *application* is registered once and only the *grant* is personal. When it is absent, the connector is tenant-scoped and the admin-configured shared credentials are passed straight through. The flag is read in [`src/lib/apps/context.ts`](../../src/lib/apps/context.ts) when the context is built, and by the OAuth start and callback routes, in [`src/lib/connectors/oauth-flow.ts`](../../src/lib/connectors/oauth-flow.ts), which use it to decide whether `requireAdmin()` applies and where the resulting grant is stored.

### Required UX pattern

When a user-scoped connector is absent from `context.connectors`, the user has no usable grant: they have not connected their account yet, or the provider will no longer renew the grant they had. Your API route must return a 200 response with `{ connected: false }` rather than a 503 — and the widget must render a Connect prompt linking to `/account/connections`. The 503 "not configured" pattern is reserved for **tenant-scoped** connectors (where the admin hasn't entered credentials).

```ts
// apps/<slug>/api/<thing>/route.ts
import { z } from "zod";
import { defineRoute } from "@/lib/apps/route";
import type SlackConnector from "@connectors/slack";

const Message = z.object({ id: z.string(), text: z.string() });

export const GET = defineRoute({
  output: z.object({ connected: z.boolean(), messages: z.array(Message).optional() }),
  handler: async (context) => {
    const slack = context.connectors.slack as unknown as
      | SlackConnector
      | undefined;
    if (!slack?.configured) return { connected: false };
    const messages = await slack.getMessages({ /* ... */ });
    return { connected: true, messages };
  },
});
```

```tsx
// apps/<slug>/widgets/<thing>.tsx
if (data.connected === false) {
  return (
    <div className="flex h-full flex-col items-center justify-center p-4 text-center">
      <p className="text-sm font-medium">Connect your Slack account</p>
      <Link
        href="/account/connections"
        className="mt-3 rounded-md bg-brand px-3 py-1.5 text-xs font-medium text-brand-foreground"
      >
        Open Connections
      </Link>
    </div>
  );
}
```

### Hard rules

- **Never** read `public.user_connector_oauth` directly from app code. Always go through `context.connectors.<name>` so the platform's session/state checks run first.
- **Never** call the platform OAuth routes (`/api/connectors/<name>/oauth/*`) from app code. The Connect button on `/account/connections` is the only entry point.
- The widget must skeleton-load like any other (per [widgets.md](./widgets.md)). The connect prompt is the *post-load* state when `connected === false`, not the loading state.
- Token refresh is automatic: an expired access token is renewed before your handler runs (`getValidUserTokens` in `src/lib/connectors/user-config.ts`), and one that expires mid-request is renewed against the same person's grant. If it can't be renewed, the connector is absent from `context.connectors`, exactly as for someone who never connected, and `if (!slack?.configured)` falls into the connect prompt path.

### How to make a connector user-scopable

It's a connector-side change, not an app-side one. The connector sets `"userScoped": true` in its `connector.json`, which needs `auth.strategy` `oauth2_authorization_code`, and the platform treats it as user-scoped for every app that lists it. The OAuth connector template at [connectors/_template-oauth/](../../connectors/_template-oauth/) is a three-legged connector without the flag, shared by the whole deployment. See [connectors/architecture.md](../connectors/architecture.md#user-scoped-connectors).
