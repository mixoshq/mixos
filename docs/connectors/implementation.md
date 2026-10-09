# Implementation

## Extend `HttpConnector`

Every connector extends `HttpConnector`. You write the methods your apps call;
the base class handles authentication, timeouts, retries with backoff,
`Retry-After`, status classification, and the plain-English message a user
eventually reads.

```ts
interface BaseConnector {
  readonly name: string;        // Must match connector.json name and the folder
  readonly configured: boolean; // Derived from auth.credentialKeys — rarely written by hand
  initialize(credentials: Record<string, string>): void | Promise<void>;
}
```

You must implement one extra member:

```ts
abstract testConnection(): Promise<ConnectorTestResult>;
```

## A complete connector

```ts
// connectors/my-service/index.ts
import { z } from "zod";
import { HttpConnector } from "@/lib/connectors/http-connector";
import type { ConnectorTestResult } from "@/lib/connectors/types";

const Item = z.object({ id: z.string(), name: z.string() });
type Item = z.infer<typeof Item>;

export default class MyServiceConnector extends HttpConnector {
  readonly name = "my-service";

  async testConnection(): Promise<ConnectorTestResult> {
    const me = await this.request<{ name?: string }>("/me");
    return { ok: true, detail: me?.name ? `Authenticated as ${me.name}` : undefined };
  }

  async getItem(id: string): Promise<Item | null> {
    return this.request(`/items/${encodeURIComponent(id)}`, undefined, { schema: Item });
  }

  async listItems(): Promise<Item[]> {
    const out: Item[] = [];
    for await (const item of this.paginate<Item>("/items", { itemSchema: Item })) out.push(item);
    return out;
  }

  async createItem(data: Record<string, unknown>): Promise<Item | null> {
    return this.request("/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }, { schema: Item });
  }
}
```

Note what is absent: no `fetch`, no `if (!res.ok) throw`, no `Authorization`
header, no retry loop. Adding any of them by hand means opting out of the
behaviour below.

## `this.request()`

```ts
protected request<T>(path, init?: RequestInit, opts?: RequestOptions<T>): Promise<T | null>
```

| Option | Default | What it does |
| --- | --- | --- |
| `schema` | — | Validates the parsed body. Drift throws `unexpected_response`. |
| `responseType` | `"json"` | `"text"` returns a string; `"raw"` returns the `Response`. |
| `idempotent` | by HTTP verb | **Opt a write into retries.** See below. |
| `query` | — | Query parameters; `undefined` and `null` entries are dropped. |
| `timeoutMs` / `deadlineMs` / `maxAttempts` | manifest, then defaults | Per-call overrides. |

Returns `null` for `204`, `205`, `304`, and for an empty body — those carry no
content, and calling `.json()` on them is the most common defect in hand-written
API clients.

## Retries, and why your writes are not retried

Retried automatically: `rate_limited`, `timeout`, `network_error`,
`upstream_error`. Backoff is exponential with full jitter, and a `Retry-After`
is always honoured. A `Retry-After` longer than the remaining deadline **fails
fast** carrying `retryAfterMs` rather than sleeping — a serverless function must
not burn its wall clock waiting.

`GET`, `HEAD`, `OPTIONS`, `PUT`, and `DELETE` are retried. `POST` and `PATCH`
are **not**, because a silently duplicated write is worse than a visible
failure. If an operation is genuinely safe to repeat — it takes an idempotency
key, or repeating it is a no-op — opt in explicitly:

```ts
await this.request("/charges", { method: "POST", body }, { idempotent: true });
```

## Errors

Every failure below `request()` arrives as a `ConnectorError` carrying a
category. Do not catch it to add detail — it already has the right message for
both a user and an admin. Let it propagate: the app route's pipeline turns it
into the envelope a widget renders. See [Failure handling](failure-handling.md).

**Never** catch an error and re-throw with the upstream's response body. Those
bodies routinely carry account and tenant detail, which is why `request()`
deliberately never reads them.

## `testConnection()` is required

`configured` is a cheap synchronous check that the credential fields are
non-empty. It cannot tell you a key was pasted with a trailing space or points
at the wrong environment. `testConnection()` makes one real call and proves it,
and is what the Registry's **Test Connection** button runs.

Pick the cheapest authenticated endpoint the API has — `/me`, `/account`, a
one-item list. Let failures throw.

## Pagination

Declare the style in `connector.json`, then iterate:

```ts
for await (const item of this.paginate<Item>("/items", { itemSchema: Item })) { … }
```

Bounded by `maxPages` (default 50) so a cursor that never terminates cannot
spin forever.

## Best practices

- Keep `name` identical to the folder name and the manifest `name`.
- One method per API operation. Let the app layer compose them.
- Declare a `schema` on anything an app renders directly — it converts "the
  upstream quietly changed" into a clear error naming the field that moved.
- Never read `process.env`, never hardcode a secret, never cache between
  requests. The platform builds a fresh instance per request.
