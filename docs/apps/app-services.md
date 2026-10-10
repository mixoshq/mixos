# App Services (cross-app data requests)

Apps are siloed by default: each has its own scoped database, and one app can
**never** read another app's tables or call another app's routes. **App
Services** is the one sanctioned way for app A to request data from app B — a
governed, request/response channel brokered by the platform.

Use it when a consumer needs *live data owned by another app* (e.g. an office
dashboard showing files owned by a document app). It is **not** for events —
for fire-and-forget notifications or value transforms, use [Hooks](hooks.md).

## The model

Two-sided consent, default deny:

- The **provider** declares each service it exposes in `app.json` under
  `provides`, and lists which consumer apps may call it.
- The **consumer** declares the dependency under `consumes`.

The registry generator enforces both sides at build time — a one-sided or
mistyped wiring fails the build. At runtime the platform re-checks everything
again before invoking the provider.

### Provider: declare `provides`

```jsonc
// apps/file-library/app.json
"provides": [
  {
    "name": "list-resources",       // → handler at services/list-resources.ts
    "description": "Resource metadata the requesting user can see.",
    "audience": "user",             // default; see below
    "consumers": ["team-dashboard"]  // allowlist, or "*" for any consumer
  }
]
```

Then write the handler at `apps/<slug>/services/<name>.ts`:

```ts
import type { ServiceContext } from "@/lib/hooks/types";

export default async function listResources(
  ctx: ServiceContext,
  params: { tagId?: string; limit?: number },
) {
  // ctx is PROVIDER-scoped: ctx.db / ctx.connectors are the provider's.
  // ctx.user is the acting user (audience "user") or null (audience "app").
  // ctx.caller.appSlug names the requesting app.
  if (!ctx.db) return { resources: [] };
  // ... authorize in YOUR OWN terms, read YOUR data, return a plain object.
}
```

Ship a **type-only** `services/types.ts` with the param/result shapes so
consumers get compile-time safety without importing runtime code.

### Consumer: declare `consumes` and call the broker

```jsonc
// apps/team-dashboard/app.json
"consumes": [
  { "app": "file-library", "service": "list-resources" }
]
```

```ts
// in one of YOUR app's API routes or jobs (server-side only)
import type { ListResourcesResult } from "@apps/file-library/services/types";

const data = await context.services!.request<ListResourcesResult>(
  "file-library",
  "list-resources",
  { limit: 8 },
);
```

`context.services` is non-null only when the app declares `consumes`. Widgets and
pages must **not** call the broker directly — expose your own API route that
does, and call that route with `createAppClient()` (the same rule as connectors).

## Audience: who the request runs as

- **`"user"` (default)** — runs on behalf of the current user. Before invoking,
  the platform verifies the user can access the **provider** app, so a consumer
  can never surface data the user couldn't already reach there. The provider
  handler re-resolves any role policy in its own terms (`ctx.user.hasRole([...])`);
  remember roles are app-local — a provider must never trust the caller's checks.
- **`"app"`** — service-account. Callable regardless of the user's access to the
  provider, and reachable from user-less **job** contexts **and a consumer's
  public routes** (`ctx.user` is `null`). Opt in per service, and only for data
  safe to share app-wide — because a consumer's *unauthenticated* public route can
  call it, the provider must not assume any viewer authorization. The consumer's
  public route is responsible for authorizing its own viewer (e.g. a passcode
  session) before calling.

### Streaming (binary) services
A service handler may return a `Response` (e.g. a file/blob stream) instead of a
plain object; the broker passes it through untouched (no JSON serialization or
payload cap). A consumer's route can `return context.services.request<Response>(…)`
directly. Handy for a public download/preview proxy that streams a provider's
bytes to an unauthenticated viewer the consumer has already authorized.

## Security guarantees (enforced by the broker)

- **Default deny** — undeclared consumer, unlisted consumer, or unknown service
  is rejected. Enforced at build *and* runtime.
- **Provider re-authorizes the user** in its own terms — never trusts the caller.
- **Provider-scoped execution** — the handler runs with the provider's db /
  connectors; the consumer never receives a handle to the provider's data layer.
- **No privilege escalation** by default (`audience: "user"`).
- **Isolation** — apps may not import the raw DB client (`@/lib/db`), the
  broker itself, or another app's code at runtime; the build refuses all three
  (see [What an app can import](./architecture.md#what-an-app-can-import)).
  `context.services` is the only path. A type from another app's
  `services/types.ts` is fine.
- **Error isolation, timeout, and a payload cap** — a failing or slow provider
  yields a `ServiceRequestError` to the consumer, never a crash. Provider
  handlers are leaves: a `ServiceContext` has no `services` client, so they can't
  chain to other providers (no cycles). (A `Response` return streams through and
  is exempt from the JSON payload cap.)
- **Public surface: `audience: "app"` only** — a public/password route gets a
  services client that can call **only `audience: "app"`** services (there's no
  user, so `audience: "user"` requests are denied with `NO_USER`). The public
  route must authorize its own viewer before calling.

## Errors

`request()` rejects with a `ServiceRequestError` carrying a `code`:
`NOT_FOUND`, `NOT_EXPOSED`, `NOT_DECLARED`, `FORBIDDEN`, `NO_USER`,
`FORBIDDEN_USER`, `NO_HANDLER`, `TIMEOUT`, `PAYLOAD_TOO_LARGE`, `PROVIDER_ERROR`.
Handle it in your route and degrade gracefully (e.g. render an empty state).

## Verify

1. `npx tsx scripts/generate-project-registry.ts` — two-sided consent and
   `services/<name>.ts` existence are validated; a mismatch aborts the build.
2. Provider/consumer relationships appear in **Administration → Apps** and in the
   App Services guide tab.
