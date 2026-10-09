# Connectors (App-Side View)

## Overview

Connectors are reusable integrations with external services like monday.com, Slack, or any third-party API. They live in the `/connectors` directory and are shared across apps. An admin configures connector credentials in the Connector Registry, and apps declare which connectors they need in their `app.json`.

For the authoring side (how to build a connector), see [the connectors guide](../connectors/).

## Using a Connector in Your App

To use a connector, add its name to the `connectors` array in your `app.json`. The platform will automatically load, initialize, and inject the connector into your app context.

```json
// app.json
{
  "name": "My App",
  "connectors": ["monday", "slack"]
}
```

Access initialized connectors via `context.connectors` in your pages, widgets, or API routes:

```ts
// In a page or server-side code
const monday = context.connectors.monday;
const contacts = await monday.getContacts({ limit: 10 });

const slack = context.connectors.slack;
const messages = await slack.getMessages({ channel: "C0123456789" });
```

## Creating a Connector

Each connector has a directory under `/connectors` with two files:

```
connectors/my-service/
  connector.json    # Metadata and credential fields
  index.ts          # Implementation class
```

See [connectors/architecture.md](../connectors/architecture.md) and [connectors/implementation.md](../connectors/implementation.md) for full details.

## Connector Manifest (connector.json)

Declares the connector's metadata and what credentials it needs. These fields appear in the Connector Registry admin UI.

```json
{
  "name": "my-service",
  "displayName": "My Service",
  "description": "Connector for the My Service API",
  "credentialFields": [
    { "key": "apiKey", "label": "API Key", "type": "password" },
    { "key": "baseUrl", "label": "Base URL", "type": "text" }
  ]
}
```

| Field | Required | Description | Example |
| --- | --- | --- | --- |
| `name` | ✅ | Unique identifier for the connector. Used in app.json and internally. | `"name": "my-service"` |
| `displayName` | ✅ | Human-readable name shown in the Connector Registry. | `"displayName": "My Service"` |
| `description` |  | Brief description of what this connector integrates with. | `"description": "Connector for the My Service API"` |
| `credentialFields` | ✅ | Array of credential fields the admin must provide. |  |
| `credentialFields[].key` | ✅ | Property name used to access this credential in the connector's initialize method. | `"key": "apiKey"` |
| `credentialFields[].label` | ✅ | Label shown in the admin configuration form. | `"label": "API Key"` |
| `credentialFields[].type` | ✅ | Either `text` for visible input or `password` for masked input. | `"type": "password"` |

## Connector Implementation

The `index.ts` file exports a class that implements the `BaseConnector` interface. The platform calls `initialize()` with decrypted credentials before the connector is passed to any app.

```ts
// connectors/my-service/index.ts
import type { BaseConnector } from "@/lib/connectors/types";

export default class MyServiceConnector implements BaseConnector {
  readonly name = "my-service";
  private apiKey = "";
  private baseUrl = "";

  get configured(): boolean {
    return !!this.apiKey;
  }

  initialize(credentials: Record<string, string>): void {
    this.apiKey = credentials.apiKey ?? "";
    this.baseUrl = credentials.baseUrl ?? "https://api.myservice.com";
  }

  async getItems(params?: { limit?: number }) {
    const res = await fetch(
      `${this.baseUrl}/items?limit=${params?.limit ?? 20}`,
      { headers: { Authorization: `Bearer ${this.apiKey}` } }
    );
    if (!res.ok) throw new Error(`MyService API error: ${res.status}`);
    return res.json();
  }
}
```

## What a Connector Owes a Long Pull

A connector method that a scheduled job or a multi-page backfill will call has obligations beyond returning data. Get these wrong and the job times out, or keeps burning API quota after the platform has already abandoned it.

**Accept an `AbortSignal` and compose it with your own timeout.** A job passes `ctx.signal`; a route passes `request.signal`. Either way the method must stop when the caller gives up, *and* still enforce its own per-request ceiling:

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

**Project the fields you actually map.** Ask the upstream for the columns you return, not whole objects (`$select` on Graph, an explicit field list elsewhere). Leave a comment tying the projection to the mapper so the two can't drift.

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
- If a connector has no saved credentials, it will still be available in `context.connectors` but `configured` will be `false`

## User-Scoped (Per-User) Connectors

Some connectors authenticate each logged-in user against an external IdP (e.g. Slack, Google Calendar) instead of using a single admin-configured credential set. **Apps don't declare scope — the connector itself does**, by virtue of implementing `OAuthCapableConnector` in its `index.ts`. Apps just list connector names:

```json
{
  "connectors": ["monday", "dock", "slack"]
}
```

A connector declares this itself: **`"userScoped": true` in its `connector.json`**. There is no inference from the class, and no naming convention — the manifest field is the whole answer, and the schema requires `auth.strategy` to be `oauth2_authorization_code` alongside it, since a shared API key cannot represent "each person's own account".

When it is set, each request merges the **logged-in user's** stored access token into the credentials passed to `initialize()`, renewing it first if it has expired; the client id and secret stay tenant-wide, so the *application* is registered once and only the *grant* is personal. When it is absent, the connector is tenant-scoped and the admin-configured shared credentials are passed straight through. The flag is read in [`src/lib/apps/context.ts`](../../src/lib/apps/context.ts) when the context is built, and in the OAuth [start](../../src/app/api/connectors/%5Bname%5D/oauth/start/route.ts) and [callback](../../src/app/api/connectors/%5Bname%5D/oauth/callback/route.ts) routes, which use it to decide whether `requireAdmin()` applies and where the resulting grant is stored.

### Required UX pattern

When a user-scoped connector is absent from `context.connectors`, the user has no usable grant: they have not connected their account yet, or the provider will no longer renew the grant they had. Your API route must return a 200 response with `{ connected: false }` rather than a 503 — and the widget must render a Connect prompt linking to `/account/connections`. The 503 "not configured" pattern is reserved for **tenant-scoped** connectors (where the admin hasn't entered credentials).

```ts
// apps/<slug>/api/<thing>/route.ts
import type { AppContext } from "@/lib/hooks/types";
import type SlackConnector from "@/../connectors/slack";

export async function GET(_req: Request, { context }: { context: AppContext }) {
  const slack = context.connectors.slack as unknown as
    | SlackConnector
    | undefined;
  if (!slack?.configured) {
    return NextResponse.json({ connected: false });
  }
  const messages = await slack.getMessages({ /* ... */ });
  return NextResponse.json({ connected: true, messages });
}
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

It's a connector-side change, not an app-side one. The connector's `index.ts` implements `OAuthCapableConnector` (exports an `oauth` object); the platform picks that up at registry-generation time and exposes the connector as user-scoped to every app that lists it. See [connectors/implementation.md](../connectors/implementation.md#oauth-capable-connectors-user-scoped) and the OAuth connector template at [connectors/_template-oauth/](../../connectors/_template-oauth/).
