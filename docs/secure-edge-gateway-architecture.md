# Secure Edge Gateway Architecture

This document describes how MixOS actually routes, authenticates, and executes requests from apps today. It is a reference of the *current* system — not a proposal.

## Goal

All database and connector access from app code (pages, widgets, server handlers) goes through a single authenticated gateway. Credentials never reach the browser. Apps cannot reach across the boundary into other apps' data. Every app inherits the same security and operational posture by construction.

---

## Request Flow

```
┌──────────────────────────────────────────────────────────┐
│  Client (Browser)                                        │
│  ┌────────────┐  ┌────────────┐                          │
│  │  Full Page │  │   Widget   │                          │
│  │  (CSR)     │  │ (Dashboard)│                          │
│  └──────┬─────┘  └──────┬─────┘                          │
│         │  createAppClient(slug).get("/path")            │
│         └───────────┬─────────┘                          │
└─────────────────────┼────────────────────────────────────┘
                      │  fetch("/api/apps/<slug>/<path>")
                      ▼
┌──────────────────────────────────────────────────────────┐
│  /api/apps/[...slug]/route.ts   —   THE GATEWAY          │
│  ┌────────────────────────────────────────────────────┐  │
│  │ 1. Resolve app slug from URL                       │  │
│  │ 2. Lookup manifest in generated appRegistry        │  │
│  │ 3. requireServerSession()      → 401 on failure    │  │
│  │ 4. getUserById + hasAppAccess  → 403 on failure    │  │
│  │ 5. buildAppContext(slug, session, dbUser)          │  │
│  │ 6. Dynamic import apps/<slug>/api/<path>/route.ts  │  │
│  │ 7. Invoke GET/POST/etc. with (request, { context })│  │
│  └────────────────────────────────────────────────────┘  │
└───────────────────────────┬──────────────────────────────┘
                            │
           ┌────────────────┼────────────────┐
           ▼                ▼                ▼
     ┌──────────┐   ┌──────────────┐   ┌────────────┐
     │ Scoped DB│   │  Connector   │   │  Connector │
     │ (Postgres│   │  (HubSpot)   │   │  (Notion)  │
     │  tables) │   └──────────────┘   └────────────┘
     └──────────┘
```

Every request under `/api/apps/...` is handled by **one** catch-all route ([src/app/api/apps/[...slug]/route.ts](../src/app/api/apps/[...slug]/route.ts)). It exports `GET`, `POST`, `PUT`, `PATCH`, and `DELETE`, all of which delegate to a single `handleRequest` helper. The app's own `route.ts` files are never wired directly into the Next.js router; they are imported dynamically by the gateway.

---

## The Gateway

The gateway performs seven steps, in order, on every request:

| # | Step | Fails with |
|---|------|------------|
| 1 | Split the slug path: `["my-app", "items", "42"]` → `appSlug="my-app"`, `apiPath=["items", "42"]` | — |
| 2 | Look up `appSlug` in the generated `appRegistry`. | 404 if unknown |
| 3 | **Rate limit** by client IP (token-bucket: 60 burst, 10/s refill). IP extracted from rightmost `x-forwarded-for` to resist spoofing. | 429 + Retry-After header |
| 4 | `requireServerSession()` — asserts a valid session. | 401 if missing/expired |
| 5 | `getUserById(session.user.id)` + `hasAppAccess(userId, appSlug)` — asserts the user has registered for this app. | 401 if user not found, 403 if no access |
| 6 | `buildAppContext(appSlug, session, dbUser)` — constructs the `AppContext` passed to the handler (see below). Wrapped in try-catch; returns a generic 500 on failure (e.g. corrupted connector credentials). | 500 on internal failure |
| 7 | `await import("@apps/<slug>/api/<path>/route")` and invoke the matching HTTP-method export. Path `[]` resolves to `api/index/route.ts`. | 404 if file missing, 405 if method not exported |

Because every app goes through the same gateway, cross-cutting behavior — auth, access control, context building, audit — lives in exactly one place and applies uniformly.

---

## AppContext

[src/lib/apps/context.ts](../src/lib/apps/context.ts) builds the context object fresh for each request:

```ts
interface AppContext {
  user: {
    id: string;           // Database user ID
    email: string;
    displayName: string;
    isAdmin: boolean;
  };
  connectors: Record<string, BaseConnector>;   // Initialized from app.json
  db: ScopedClient | null;                     // Present if database: true
  manifest: AppManifest;                       // This app's manifest
  hooks: HookRegistrar;                        // Scoped hook registrar
}
```

### User

Pulled from the session + the `users` table row.

### Connectors

For each name in `manifest.connectors` (from `app.json`), the builder:

1. Dynamically imports `@connectors/<name>/index` and instantiates the default export.
2. Loads the admin-configured credentials from `connector_configs` (encrypted at rest with AES-256-GCM; decrypted with `CONNECTOR_ENCRYPTION_KEY`).
3. Calls `instance.initialize(credentials)`.
4. Places the instance on `context.connectors[<name>]`.

If a connector fails to load (e.g., missing directory, throwing constructor) or `initialize()` throws (e.g., invalid credentials), the connector is excluded from the context entirely — it is never added in a half-initialized state. Handlers must check `context.connectors.hubspot?.configured` before making calls.

Credentials are decrypted **only** inside `buildAppContext`, server-side. They are never serialized into the response.

### Scoped DB

If `manifest.database === true`, `context.db` is a `ScopedClient` created by `createScopedClient(appSlug)` ([src/lib/apps/scoped-db.ts](../src/lib/apps/scoped-db.ts)). The client is pinned to the app's namespaced tables — there is no way to reach another app's tables through it.

If the app does not declare a database, `context.db` is `null`.

### Hooks

A per-request `HookRegistrar` scoped to this app. `doAction` / `applyFilters` calls fan out through the platform's hook system; registered callbacks are identified with the app's slug for audit and observability.

---

## App API Routes

App authors add handlers under `apps/<slug>/api/<path>/route.ts`:

```ts
// apps/my-app/api/hello/route.ts
import { NextResponse } from "next/server";
import type { AppContext } from "@/lib/hooks/types";

export async function GET(
  _request: Request,
  { context }: { context: AppContext }
) {
  return NextResponse.json({
    message: `Hello, ${context.user.displayName}!`,
  });
}
```

Rules:

- **Folder path = URL path.** `api/items/[id]/route.ts` is reachable at `/api/apps/<slug>/items/<id>`.
- **One function per method.** Export `GET`, `POST`, `PUT`, `PATCH`, or `DELETE` — missing methods return 405.
- **Signature is `(request, { context })`.** No other arguments; no other shape.
- **Authentication is already done** when the handler runs. `context.user` is always populated.

These handlers run on the server, inside the gateway process. They can reach connectors and the DB freely — that's the whole point of this boundary.

---

## Client Calls (SDK)

Widgets and client-side pages reach their app's routes via [src/lib/apps/sdk.ts](../src/lib/apps/sdk.ts):

```ts
import { createAppClient } from "@/lib/apps/sdk";

const client = createAppClient("my-app");
const { message } = await client.get<{ message: string }>("/hello");
await client.post("/items", { body: { name: "Widget" } });
```

The SDK:

- Prefixes every path with `/api/apps/<slug>/`.
- Sends `Content-Type: application/json`.
- Throws `AppClientError` on non-2xx responses, exposing the status and parsed body.
- Supports `AbortSignal` for cancellation.

Widgets receive `appSlug` via `WidgetProps` — they cannot reach into the platform's session, DB, or connectors any other way.

---

## Full Pages (Server Components)

Server components under `apps/<slug>/pages/` run in the same Node process as the gateway but not *through* the gateway. They may call `buildAppContext()` directly if they need the same context the API handlers get — this is safe because server components never ship to the browser.

Client pages (`"use client"`) must use the SDK, exactly like widgets.

---

## Enforcement

The boundary is enforced in three places:

1. **Runtime (the gateway itself).** Every request to `/api/apps/...` goes through auth + access checks. There is no other public entry point for app code on the server.
2. **TypeScript structure.** Widgets get `WidgetProps` (just `appSlug` + `config` + `size`). There is no `context` prop; there is no way to receive connectors or a DB handle in client code.
3. **ESLint rules.** [eslint.config.mjs](../eslint.config.mjs) applies `no-restricted-imports` to `apps/**/*.{ts,tsx}` (with `apps/**/api/**` excluded). App code cannot import `@/lib/db/*`, `@connectors/*`, or `@/lib/connectors/*` — violations fail the build.

API route handlers (`apps/**/api/**`) are allowlisted for those imports because they run behind the gateway and already have a validated context.

---

## App Visibility

`manifest.hasPages` is computed at registry-generation time: it's `true` when `apps/<slug>/pages/` exists and is non-empty. Apps with no `pages/` directory are still valid — their widgets appear on the dashboard — but they don't show up in the Apps dropdown because there's nowhere to navigate to.

Directories starting with `_` (e.g., `apps/_template/`) are treated as scaffolds and excluded from the registry entirely.

---

## What This Buys You

- **Credentials never hit the browser.** They're decrypted in `buildAppContext` and injected into connector instances; the response only contains whatever the handler chooses to serialize.
- **Auth/authz is done once.** Apps cannot forget to check. The gateway gates every request before any app code runs.
- **Connector reuse across apps.** HubSpot is configured once in the Connector Registry. Any app that declares `"connectors": ["hubspot"]` gets a ready-to-call instance.
- **Per-app DB isolation.** `context.db` is scoped by construction; cross-app reads are impossible without going outside the platform.
- **Self-contained apps.** Pages, widgets, API routes, migrations, and manifest all live in one folder. Adding/removing an app is a folder move.
- **Platform features are free.** Because every handler speaks the same `(request, { context })` shape, platform-level concerns (hooks, logging, audit, rate limiting) apply to every app at once. Rate limiting is already active — a per-IP token-bucket limiter in the gateway returns 429 on abuse.

---

## Reference Files

| File | Responsibility |
|------|----------------|
| [src/app/api/apps/[...slug]/route.ts](../src/app/api/apps/%5B...slug%5D/route.ts) | The gateway — auth, access, context build, dispatch |
| [src/lib/apps/context.ts](../src/lib/apps/context.ts) | `buildAppContext` — user, connectors, scoped DB, hooks |
| [src/lib/apps/scoped-db.ts](../src/lib/apps/scoped-db.ts) | Per-app scoped database client |
| [src/lib/apps/sdk.ts](../src/lib/apps/sdk.ts) | Client-side `createAppClient` SDK |
| [src/lib/connectors/config.ts](../src/lib/connectors/config.ts) | Credential encryption/decryption |
| [src/lib/hooks/types.ts](../src/lib/hooks/types.ts) | `AppContext`, `WidgetProps`, hook types |
| [src/lib/rate-limit.ts](../src/lib/rate-limit.ts) | Per-IP token-bucket rate limiter |
| [src/lib/safe-error.ts](../src/lib/safe-error.ts) | Production-safe error message helper |
| [eslint.config.mjs](../eslint.config.mjs) | Restricted-import rules on `apps/**` |
| [apps/_template/api/hello/route.ts](../apps/_template/api/hello/route.ts) | Canonical example of a handler |
| [apps/_template/widgets/hello-mix.tsx](../apps/_template/widgets/hello-mix.tsx) | Canonical example of a widget calling its own route |
