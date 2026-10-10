# Failure handling

A connector that fails silently, or fails with `Error: 500`, is worse than one
that does not exist — the user cannot act, and neither can the admin. This is
how a failure travels from an upstream API to something a person can do
something about.

## The categories

Every failure is normalised to one of these. App code branches on the category,
never on a raw status number.

| Category | Means | Retried |
| --- | --- | --- |
| `unconfigured` | No credentials saved. An admin must act. | no |
| `auth_failed` | The credential was rejected, expired, or revoked. | no¹ |
| `forbidden` | Credential is valid but lacks the scope. | no |
| `rate_limited` | Throttled. `retryAfterMs` is set when the upstream said so. | yes |
| `not_found` | The record is not there — or the base URL is wrong. | no |
| `invalid_request` | We sent something the upstream rejected. A bug, not a config problem. | no |
| `conflict` | State moved underneath us. | no |
| `payload_too_large` | Chunk the request. | no |
| `timeout` | No response in time. | yes |
| `upstream_error` | The provider is unwell. | yes |
| `network_error` | DNS, TLS, or connectivity. | yes |
| `unexpected_response` | A 2xx whose body did not match the declared schema. | no |

¹ A token-based strategy replays a 401 exactly once after refreshing. Beyond
that it is a real credential problem and retrying only burns rate limit.

Rate limiting is classified on the **headers**, not the status code alone: some
APIs throttle with `403` and others with `503`, so `Retry-After` and
rate-limit headers outrank the number.

## In an app route

Let it propagate. A `defineRoute` handler does not catch a `ConnectorError`:

```ts
import { z } from "zod";
import { defineRoute } from "@/lib/apps/route";

export const GET = defineRoute({
  output: z.object({ items: z.array(Item) }),
  handler: async (context) => ({
    items: await context.connectors["my-service"].listItems(),
  }),
});
```

The route pipeline answers with a stable envelope and the right HTTP status:

```jsonc
{ "error": {
    "category": "unconfigured",
    "message": "Billing data is unavailable right now — an administrator needs to finish setting up Acme Billing.",
    "connector": "Acme Billing",
    "retryAfterMs": null,
    // admins only, omitted entirely for everyone else:
    "adminHint": "Open Administration → Connector Registry and enter this connector's credentials.",
    "adminActionUrl": "/admin/connectors?connector=acme-billing"
  },
  // the platform's coarse code, beside the precise category
  "code": "UNAVAILABLE"
}
```

The admin fields are written server-side only when the caller is an admin: the
pipeline reads `context.user.isAdmin`, which is what keeps internal detail away
from ordinary users. A `raw: true` route that builds its own Response returns
`ctx.connectorErrorResponse(err)` for the same envelope:

```ts
export const GET = defineRoute({
  raw: true,
  handler: async (ctx) => {
    try {
      return Response.json(await ctx.connectors.acme.listThings({ signal: ctx.signal }));
    } catch (err) {
      return ctx.connectorErrorResponse(err);
    }
  },
});
```

The route pipeline decides the admin fields from the caller, not the app: a
signed-in admin gets them, and a password, key or public caller never does.

`unconfigured` and `auth_failed` map to **503**, not 500: a missing credential
is a genuinely unavailable dependency. `invalid_request` maps to **502**, not
400: the connector sent it, not the HTTP client.

Anything that is not a `ConnectorError` becomes a bare `internal_error` with
fixed copy — an unexpected throw is exactly the case where we cannot reason
about what the message holds, so none of it is forwarded.

## In a widget

`useAppQuery` with `AsyncView` renders it for you: a failed connector call shows
`ConnectorErrorState` in place of the generic error. Handling a call yourself,
`connectorErrorOf` from `@/lib/apps/sdk` returns the envelope from the error:

```tsx
import ConnectorErrorState from "@/components/ui/connector-error-state";
import { connectorErrorOf } from "@/lib/apps/sdk";

const envelope = connectorErrorOf(err);
if (envelope) return <ConnectorErrorState envelope={envelope} onRetry={refetch} />;
```

The component splits on cause, not severity. `unconfigured`, `auth_failed`, and
`forbidden` render **"Not connected"** with no Retry button — retrying a
connector nobody has finished setting up is futile, and offering the button
tells the user to keep trying something that will never start working. Everything
else renders an error with Retry, and a wait hint when `retryAfterMs` is set.

Admins additionally see the hint and a deep link to the Registry row.
