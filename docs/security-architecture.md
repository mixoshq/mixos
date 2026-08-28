# Security Architecture: Apps & Connectors

This document describes the security model, data flow, and isolation boundaries
of the MixOS platform. It is intended for security reviewers and auditors.

**Key source files referenced throughout:**

| Component            | Path                                          |
|----------------------|-----------------------------------------------|
| Proxy (optimistic)   | `src/proxy.ts`                                |
| Auth configuration   | `src/lib/auth/config.ts`                      |
| Session helpers      | `src/lib/auth/session.ts`                     |
| API gateway          | `src/app/api/apps/[...slug]/route.ts`         |
| Access control       | `src/lib/apps/access.ts`                      |
| Context builder      | `src/lib/apps/context.ts`                     |
| Scoped DB client     | `src/lib/apps/scoped-db.ts`                   |
| Notifications client | `src/lib/apps/notifications.ts`               |
| Web Push sender      | `src/lib/push/server.ts`                      |
| Push subscribe API   | `src/app/api/push/*/route.ts`                 |
| Client SDK           | `src/lib/apps/sdk.ts`                         |
| Credential config    | `src/lib/connectors/config.ts`                |
| Encryption module    | `src/lib/connectors/encryption.ts`            |
| Rate limiter         | `src/lib/rate-limit.ts`                       |
| Safe error helper    | `src/lib/safe-error.ts`                       |
| Security headers     | `next.config.ts`                              |
| ESLint restrictions  | `eslint.config.mjs`                           |
| MCP endpoint         | `src/app/api/mcp/route.ts`                    |
| MCP tool broker      | `src/lib/mcp/broker.ts`                       |
| MCP tool discovery   | `src/lib/mcp/tools.ts`                        |
| OAuth AS crypto      | `src/lib/mcp/oauth.ts`                        |
| OAuth token store    | `src/lib/mcp/store.ts`                        |
| OAuth endpoints      | `src/app/api/oauth/{register,token,revoke}/route.ts` |
| MCP consent screen   | `src/app/(main)/oauth/authorize/`             |

---

## 1. Request Lifecycle

Every request from client code to an app's API traverses the same secured path.
No alternative entry points exist for app logic.

```
  Browser (Widget / Page)
  ========================
  | createAppClient(slug)
  | fetch("/api/apps/<slug>/<path>")
  | Cookie: session token
  |
  v
+---------------------------------------------------------------+
| PROXY  (src/proxy.ts)  -- OPTIMISTIC ONLY, NOT AUTHORIZATION  |
|                                                               |
|  - Runs on all routes except a small public allowlist         |
|  - Checks only that a session COOKIE IS PRESENT               |
|    (it does not decode, verify, or validate the JWT)          |
|  - Redirects to /login when the cookie is absent              |
|  - Does NOT check admin, app access, or CSRF                  |
+---------------------------------------------------------------+
  |
  | Session valid
  v
+---------------------------------------------------------------+
| API GATEWAY  (src/app/api/apps/[...slug]/route.ts)            |
|                                                               |
|  1. Parse URL: extract appSlug + apiPath segments             |
|  2. Verify app exists in registry                  --> 404    |
|  3. Rate limit by IP (token bucket, 60 burst/10s)  --> 429    |
|  4. requireServerSession()                         --> 401    |
|  5. getUserById(session.user.id)                   --> 401    |
|  6. hasAppAccess(dbUser.id, appSlug)               --> 403    |
|  7. buildAppContext(appSlug, session, dbUser)       --> 500    |
|  8. Resolve route file on disk (literal > dynamic segments)   |
|  9. Dynamic import: apps/<slug>/api/<path>/route.ts           |
| 10. Dispatch to HTTP method handler (GET/POST/PUT/DELETE...)   |
+---------------------------------------------------------------+
  |
  | AppContext injected
  v
+---------------------------------------------------------------+
| APP HANDLER  (apps/<slug>/api/<path>/route.ts)                |
|                                                               |
|  Receives: (request: Request, { context }: { context })      |
|                                                               |
|  context.user          - Authenticated user (id, email, role) |
|  context.connectors    - Initialized connector instances      |
|  context.db            - Scoped DB client (or null)           |
|  context.notifications - Web Push sender (or null)            |
|  context.manifest      - App metadata                         |
|  context.hooks         - App-scoped hook registrar            |
+---------------------------------------------------------------+
  |                           |
  | context.db.table(...)     | context.connectors.<name>.search(...)
  v                           v
+-----------------------+   +---------------------------+
| POSTGRES              |   | EXTERNAL API              |
| (prefixed tables,     |   | (whatever the connector   |
|  Supabase + pool)     |   |  wraps)                   |
+-----------------------+   +---------------------------+
```

### Security checkpoints in order

Both HTTP mounts — `/api/apps/<slug>/…` and `/api/p/<slug>/…` — are the same
pipeline (`src/lib/apps/dispatch.ts`) with a different `mount` argument. They
were parallel implementations until this was unified, which is how the public one
acquired a gate the authenticated one never had, and the authenticated one ended
up checking the wrong table.

| Step | Check                          | Failure | Where enforced                       |
|------|--------------------------------|---------|--------------------------------------|
| 0    | Session cookie present         | 302     | Proxy (`src/proxy.ts`) — presence only, never validation |
| 1    | Body under size cap            | 413     | Dispatcher (`content-length`, before any body read) |
| 2    | App slug exists                | 404     | Dispatcher (registry lookup)         |
| 3    | Rate limit (IP), pre-auth      | 429     | Dispatcher (`src/lib/rate-limit.ts`) |
| 4    | URL resolves to a route pattern| 404     | Dispatcher (`resolveRoutePath`)      |
| 5    | This mount serves the route    | 404     | Dispatcher, from the **hoisted contract** — so no app module is imported for a caller the route would refuse |
| 6    | Route module loads; method exported | 404 / 405 / 500 | Dispatcher (import and dispatch are separated, so a module that throws is not reported as missing) |
| 7    | Live declaration matches the registry | 404 | Dispatcher — a gate decided from one source and enforced from another is not a gate |
| 8    | Auth tier the caller earned    | 401 / 403 / 404 | `src/lib/apps/auth-tier.ts` |
| 9    | Rate limit (user+app, route)   | 429     | Dispatcher, now that the caller is known |
| 10   | Context build succeeds         | 500     | Dispatcher (try-catch, generic message) |
| 11   | Required roles                 | 403     | `runRoute` — one place every caller passes through |
| 12   | Input matches the declared schema | 400  | `runRoute`                           |
| 13   | Connector-call and wall-clock budget | 429 / 504 | `runRoute`                    |
| 14   | Output matches the declared schema | 500  | `runRoute`                           |

**Authorization is `hasAppGrant`, not `hasAppAccess`.** The former reads
`user_app_grants` and short-circuits true for a `global` app; the latter reads
`user_apps`, which records that a user *installed* the app on their dashboard — a
layout preference. The gateway used the second until this was corrected, which
403'd every user of every global app.

**Tier resolution is strongest-first**: `session` > `signed-in` > `password` >
`key` > `public`, intersected with what the mount can serve. A route declaring
`["session", "public"]` therefore serves a granted user their own data and a
stranger the public view, from one handler, with `context.user` typed nullable so
the compiler forces both branches to exist.

**The `key` tier has no implementation.** A route declaring only `key` is
unreachable on every mount rather than open — the fail-closed direction, and the
one that cannot become a hole by being forgotten.

---

## 2. Credential Security

Connector credentials (API keys, tokens, secrets) are encrypted at rest
and only decrypted server-side, per-request. They never reach the browser.

### 2.1 Encryption scheme

```
Algorithm:  AES-256-GCM (authenticated encryption)
Key:        CONNECTOR_ENCRYPTION_KEY env var (32 bytes, hex-encoded)
IV:         12 random bytes, generated per encrypt() call
Output:     base64(IV) : base64(AuthTag) : base64(Ciphertext)
```

### 2.2 Credential lifecycle

```
  Admin UI (browser)
  ==================
  | Submits plaintext credentials for a connector
  | POST /api/connectors/<name>/config
  |
  v
+--------------------------------------------------+
| saveConnectorConfig()                            |
| (src/lib/connectors/config.ts)                   |
|                                                  |
|  1. JSON.stringify(credentials)                  |
|  2. encrypt(plaintext)                           |
|     - Generate random 12-byte IV                 |
|     - AES-256-GCM encrypt with CONNECTOR_        |
|       ENCRYPTION_KEY                             |
|     - Produce: IV:AuthTag:Ciphertext (base64)    |
|  3. Upsert into connector_configs table          |
|     - PK: connector_name (one row per connector) |
|     - Stores: encrypted_credentials,             |
|       configured_by (userId), updated_at         |
+--------------------------------------------------+
  |
  | Encrypted blob stored in Postgres
  v
+--------------------------------------------------+
| connector_configs table                          |
|                                                  |
|  connector_name  | encrypted_credentials | ...   |
|  "crm"           | "abc123:def456:..."   | ...   |
|  "billing"       | "xyz789:uvw012:..."   | ...   |
|                                                  |
|  Scope: org-wide (NOT per-user or per-app)       |
|  Access: trusted server code only                |
+--------------------------------------------------+
  |
  | On each app API request:
  v
+--------------------------------------------------+
| buildAppContext() --> getDecryptedConfig()        |
| (src/lib/apps/context.ts)                        |
|                                                  |
|  For each connector declared in app.json:        |
|   1. Query connector_configs for encrypted blob  |
|   2. decrypt(blob)                               |
|      - Split IV:AuthTag:Ciphertext               |
|      - AES-256-GCM decrypt with env key          |
|      - Verify authentication tag (tamper check)  |
|   3. JSON.parse --> credential object             |
|   4. new ConnectorClass()                        |
|   5. instance.initialize(credentials)            |
|      - Credentials stored as private fields      |
|   6. Inject into context.connectors              |
|                                                  |
|  Instance is STATELESS and REQUEST-SCOPED:       |
|   - Created fresh per request                    |
|   - Never cached or shared across requests       |
|   - Garbage collected after response              |
+--------------------------------------------------+
```

### 2.3 What prevents credential exposure

| Threat                         | Mitigation                                             |
|--------------------------------|--------------------------------------------------------|
| Credentials in browser JS      | ESLint bans connector imports in client code           |
| Credentials in API responses   | Connectors are server-only; SDK returns app data only  |
| Credentials leaked via caching | Connector instances are stateless, never cached        |
| Credentials at rest in DB      | AES-256-GCM with per-record random IV                  |
| Tampered ciphertext            | GCM authentication tag verified on every decrypt       |
| Key in source code             | Key loaded from env var at runtime, not committed      |

---

## 3. Tenant and App Isolation

### 3.1 User-to-app access control

```
+------------------+         +------------------+
|     users        |         |      apps        |
|------------------|         |------------------|
| id (uuid, PK)   |         | slug (PK)        |
| email (unique)   |         | name             |
| display_name     |         | ...              |
| is_admin         |         |                  |
+------------------+         +------------------+
        |                            |
        |     +------------------+   |
        +---->|   user_apps      |<--+
              |------------------|
              | user_id (FK)     |
              | app_slug (FK)    |
              | PK: (user_id,    |
              |      app_slug)   |
              +------------------+

  hasAppAccess(userId, appSlug):
    SELECT app_slug FROM user_apps
    WHERE user_id = $1 AND app_slug = $2

  Result: boolean --> 403 if false
```

Users can only reach app API routes for apps they have been granted access to.
This is checked on **every request** in the gateway, before any app code runs.

### 3.2 Database table isolation

Apps that declare `"database": true` in their manifest receive a scoped
database client. All table names are automatically prefixed.

```
  App code:                    Actual table in Postgres:
  ========================     ===========================

  context.db                   createScopedClient("my-app")
    .table("goals")     -->    db.from("_app_my_app_goals")
    .select("*")

  context.db                   createScopedClient("reports")
    .table("renewals")  -->    db.from("_app_reports_renewals")
    .select("*")
```

**Isolation guarantees:**

```
+-------------------------------+
| Postgres (shared database)    |
|                               |
|  Public tables:               |
|    users                      |
|    apps                       |
|    user_apps                  |
|    user_app_grants            |
|    connector_configs          |
|    push_subscriptions         |
|    _migrations                |
|                               |
|  App-scoped tables:           |
|    _app_my_app_goals          |
|    _app_my_app_quotes         |
|    _app_reports_renewals      |
|    _app_reports_history       |
|    ...                        |
|                               |
|  Each app can ONLY access     |
|  tables with its own prefix   |
|  via createScopedClient()     |
+-------------------------------+
```

- The `ScopedClient` only exposes a `.table(name)` method that prepends the prefix
- App code never sees or constructs raw table names
- Hyphens in slugs are converted to underscores in prefixes
- Apps without `"database": true` receive `context.db = null`

### 3.3 Client-server boundary enforcement

Three layers prevent client-side code from bypassing the gateway:

```
+------------------------------------------------------------------+
| LAYER 1: SDK Design (src/lib/apps/sdk.ts)                        |
|                                                                  |
|  createAppClient(slug) routes ALL requests through               |
|  /api/apps/<slug>/<path> -- no direct DB or connector access     |
|  possible from client code                                       |
+------------------------------------------------------------------+

+------------------------------------------------------------------+
| LAYER 2: ESLint Rules (eslint.config.mjs)                        |
|                                                                  |
|  Client code (widgets, pages) CANNOT import:                     |
|    - @/lib/db/*                                                  |
|    - @connectors/*                                               |
|    - @/lib/connectors/*                                          |
|                                                                  |
|  Only api/ route files are allowlisted for these imports.        |
|  Build fails on violation.                                       |
+------------------------------------------------------------------+

+------------------------------------------------------------------+
| LAYER 3: Runtime Context (src/lib/apps/context.ts)               |
|                                                                  |
|  AppContext (with connectors, db, user) is only constructed      |
|  inside the gateway and passed to server-side route handlers.    |
|  Widget/page components receive only: { appSlug, config, size }  |
+------------------------------------------------------------------+
```

### 3.4 Connector credential scope

```
  Connector credentials are ORG-WIDE, not per-user or per-app:

  +-------------------+
  | connector_configs  |
  |                    |
  | "crm" ----------> | One set of CRM credentials
  | "billing" ------> | One set of billing credentials
  | "analytics" ----> | One set of analytics credentials
  +-------------------+
         |
         | Shared by ALL apps that declare the connector
         | in their app.json manifest
         v
  +------------------+     +------------------+
  | sales app        |     | account-mgmt app |
  | connectors:      |     | connectors:      |
  |   ["crm"]        |     |   ["crm",        |
  |                  |     |    "billing"]    |
  +------------------+     +------------------+

  Access control is at the EXTERNAL SERVICE level:
  - the CRM's own token scopes
  - the billing API key's permissions
  - etc.
```

### 3.5 Notification (Web Push) scope

Apps that declare `"notifications": true` receive a `context.notifications`
client (gated exactly like `context.db`; `null` otherwise). It exposes a single
method — `send({ userIds, title, body, url, tag, icon })` — and is the only way
app code can dispatch a push.

```
  App handler                         Platform
  ===========                         ========
  context.notifications.send({        createNotificationsClient("<slug>")
    userIds: [...],          -->        1. dedupe userIds
    title, body, url         -->        2. filter to recipients who actually
  })                                       have THIS app (hasAppGrant: global
                                           apps -> everyone; else an explicit
                                           user_app_grants row)
                                        3. load each recipient's subscriptions
                                        4. web-push.sendNotification (VAPID-signed)
                                        5. prune dead endpoints (404/410)
```

**Isolation guarantees:**

- **Recipient gating.** `send()` drops any `userId` that lacks access to the
  calling app, so one app cannot push to users of another even if it guesses
  their ids. Enforced in `src/lib/apps/notifications.ts` via `hasAppGrant`.
- **Server-only dispatch.** `context.notifications` is built in the gateway and
  injected into route handlers only. The public surface sets it to `null`
  (`PublicAppContext.notifications: null`), so unauthenticated routes cannot send.
- **Subscriptions are platform-owned.** `push_subscriptions` is a `public.*`
  table written only by the session-gated subscribe/unsubscribe routes
  (`src/app/api/push/*`), each pinning `user_id` from `requireReadOnlySession()`.
  App code never reads or writes it, and the `ScopedClient` cannot reach it
  (no `_app_<slug>_` prefix).
- **No client-side push API.** Widgets/pages opt in only through the SDK helper
  `enablePushNotifications()` (`src/lib/apps/sdk.ts`), which posts the browser
  subscription to the platform route. The VAPID **private** key never leaves the
  server; only the public key is handed to the client to subscribe.
- **Payload exposure.** A push payload reaches a recipient's device, so apps
  must treat `title`/`body` as user-visible and must not include another user's
  private data beyond what the recipient is entitled to see.

---

## 4. Security Boundaries Summary

| Layer               | What it protects              | Mechanism                                    | Enforced at                  |
|---------------------|-------------------------------|----------------------------------------------|------------------------------|
| Proxy (optimistic)   | Unauthenticated browsing      | Cookie-PRESENCE check, redirect to /login    | `src/proxy.ts`               |
| Authoritative auth   | Forged / stale session        | JWT verified per request in route handlers   | `requireReadOnlySession()`   |
| CSRF protection      | Cross-site request forgery    | Token validation on POST/PUT/PATCH/DELETE    | `src/proxy.ts`               |
| Role-based routing   | Admin-only routes             | Role check in edge middleware                | `src/proxy.ts`               |
| Server-side admin    | Admin action bypass           | `requireAdmin()` in pages + server actions   | `access.ts`, admin pages     |
| Rate limiting        | Abuse / DoS                   | Postgres token-bucket, memory pre-filter     | `rate-limit.ts`, gateway     |
| Gateway auth         | Per-request session validity  | `requireServerSession()`                     | Gateway route handler        |
| App access control   | Unauthorized app access       | `hasAppAccess()` checks `user_apps` table    | Gateway route handler        |
| Email domain gate    | Unauthorized user provisioning| `ALLOWED_EMAIL_DOMAINS` env var check        | `access.ts` (`ensureUser`)   |
| Encryption at rest   | Credential exposure in DB     | AES-256-GCM with random IV per record        | `encryption.ts`              |
| Per-request decrypt  | Credential caching/leakage   | Stateless connectors, fresh per request      | `context.ts`                 |
| DB table prefixing   | Cross-app data access         | `_app_<slug>_` prefix via `ScopedClient`     | `scoped-db.ts`               |
| Notification scope   | Cross-app push spam           | `send()` filters recipients to users with the app | `notifications.ts` (`hasAppGrant`) |
| ESLint import rules  | Client importing server code  | Build-time import restrictions               | `eslint.config.mjs`          |
| SDK routing          | Direct DB/connector access    | All client calls go through `/api/apps/...`  | `sdk.ts`                     |
| Safe error responses | Internal detail leakage       | `safeErrorMessage()` strips details in prod  | `safe-error.ts`, all routes  |
| Request body limit   | Memory-exhaustion DoS         | 27 MB cap, `content-length` checked first    | Gateway (`MAX_BODY_BYTES`)   |
| Timing-safe queries  | User/app enumeration          | `.maybeSingle()` on all access checks        | `access.ts`                  |
| Security headers     | Clickjacking, MIME sniffing   | CSP `frame-ancestors 'self'`, `nosniff`, etc | `next.config.ts`             |
| Session cookies      | Session hijacking / forgery   | Auth.js JWT, httpOnly, secure, sameSite=lax  | `next-auth` (Auth.js v5)     |

---

## 5. Environment Secrets

| Variable                    | Purpose                              | Exposure risk if leaked                          |
|-----------------------------|--------------------------------------|--------------------------------------------------|
| `AUTH_SECRET`               | Signs/encrypts Auth.js session JWTs  | Attacker can forge a session for any user        |
| `SUPABASE_SERVICE_ROLE_KEY` | Full database access; bypasses RLS   | Full read/write to every table                   |
| `DATABASE_URL`              | Postgres connection (full DB access) | Full read/write to every table                   |
| `CONNECTOR_ENCRYPTION_KEY`  | Decrypts all connector credentials, AND derives the MCP token HMAC key and the app-unlock cookie key | Exposes every third-party API key; lets an attacker mint MCP tokens and unlock cookies |
| `APP_UNLOCK_SECRET`         | Signs app password-unlock cookies    | Bypass of every app password. Note that app **API keys** deliberately do NOT derive from this — they derive from `CONNECTOR_ENCRYPTION_KEY` under their own label, so rotating this secret does not silently invalidate every integration. |
| `CRON_SECRET`               | Authenticates Vercel Cron -> /api/cron | Attacker can trigger every app background job  |
| `VAPID_PRIVATE_KEY`         | Signs Web Push messages              | Attacker could send push to existing subscribers; no data read access |
| `VAPID_PUBLIC_KEY` / `VAPID_SUBJECT` | Client subscribe key / contact URL | Not secret; public key is handed to the browser to subscribe |
| `ALLOWED_EMAIL_DOMAINS`     | Restricts user provisioning          | Not secret, but removing it lets any email domain sign in |

Everything above except `ALLOWED_EMAIL_DOMAINS` and the VAPID public/subject
values must be kept out of client bundles, source control, and logs. Note that
none of them carry a `NEXT_PUBLIC_` prefix, which is what stops Next.js inlining
them into browser bundles — do not add one.

In production these are Vercel project environment variables.

---

## 6. Rate Limiting

The API gateway applies a per-IP token-bucket rate limiter before
authentication checks. This protects against brute-force and DoS attacks.

```
Algorithm:  Token bucket
Authority:  public.rate_buckets (Postgres), one atomic upsert per charge
Pre-filter: a per-instance in-memory bucket (see below)
Key:        <limiter name>::<identity>, scoped to one of
            ip | user_app | route | api_key
Burst:      60 requests      (the app gateway; other limiters differ)
Refill:     10 tokens/second
Response:   429 Too Many Requests + Retry-After header
```

### Why it is not in-memory

It used to be, with a comment saying that was "suitable for single-process
deployments". The deployment is serverless: every function instance held its own
Map, so the documented burst was **per instance** and, across a fleet that scales
with the very traffic being limited, close to no limit at all. A control that
reads as enforced and is not is worse than an absent one.

The authority is now a Postgres table. The refill arithmetic lives inside the
`ON CONFLICT DO UPDATE SET` expression, which Postgres evaluates against the
locked current row — a CTE or an `UPDATE ... FROM (SELECT ...)` reads the
statement snapshot instead and is silently racy under concurrency.

### The two tiers

The in-memory bucket survives as a pre-filter, and the asymmetry is what makes
that sound. A per-instance bucket sees only a fraction of the traffic, so it
drains more slowly than the global one and is therefore strictly **more
permissive**:

- memory says DENY → the global bucket is at least as empty. Short-circuit.
- memory says ALLOW → proves nothing. Consult Postgres.

A cold instance starts full, so it can only ever be too generous. It can never
lock anyone out on its own.

### Failing open, deliberately

If Postgres is unreachable the limiter logs a warning and falls back to the
in-memory result. This is a security control failing open, which is worth stating
plainly. The alternative is a database blip taking the product down, and the
fallback degrades to exactly the behaviour this module had before — a rarer
exposure, not a new one.

### Garbage collection

The cron tick deletes buckets untouched for an hour. The invariant: that TTL must
exceed `maxTokens / refillRatePerSecond` for **every** configured limiter, or GC
forgives an abuser mid-penalty. The slowest limiter today is OAuth dynamic
registration at 10 tokens / 0.05 per second = 200 seconds, leaving ~18x headroom.
A slower limiter than that needs a longer TTL or per-row budget columns.

### IP extraction hardening

The gateway extracts the client IP from the **rightmost** entry in the
`x-forwarded-for` header (the one appended by the trusted reverse proxy),
falling back to `x-real-ip`. This resists client-side header spoofing where
an attacker prepends fake IPs to bypass rate limiting.

```
x-forwarded-for: <attacker-spoofed>, <real-client-ip>
                                      ^^^^^^^^^^^^^^^^ used
```

The pre-filter's in-memory store (`src/lib/rate-limit.ts`) evicts stale entries
automatically; the Postgres authority is pruned from the cron tick.

---

## 7. CSRF Protection

CSRF is handled in two distinct places, and neither is the proxy — `src/proxy.ts`
performs no CSRF validation at all.

**Auth.js routes.** `next-auth` protects its own sign-in/sign-out endpoints with
the standard double-submit cookie: a CSRF token is stored in the
`authjs.csrf-token` cookie and must be echoed in the request body.

**Everything else.** App API routes and server actions rely on the session
cookie being `SameSite=Lax`, which stops a cross-site form or `fetch` from
attaching it to a state-changing request. Next.js server actions additionally
verify the `Origin` header against the `Host` on every invocation.

The practical consequence for app authors: do not lower `sameSite` on the
session cookie, and do not accept state-changing requests on `GET` — `Lax`
permits cross-site `GET` navigation, so a mutating `GET` handler is reachable
cross-site.

---

## 8. Database Access Model

The platform reaches Postgres two ways, both server-side only:

| Client | Module | Used for |
|--------|--------|----------|
| Supabase JS (`createServiceClient()`) | [`src/lib/db/supabase.ts`](../src/lib/db/supabase.ts) | Essentially everything, including the app-facing `context.db` |
| Raw `postgres.js` pool (`sql`) | [`src/lib/db/client.ts`](../src/lib/db/client.ts), options in [`src/lib/db/pg-options.ts`](../src/lib/db/pg-options.ts) | The few queries PostgREST cannot express: analytics aggregates, telemetry rollups, and the scheduler's atomic job claim |

**Both connect with the Supabase service role, which bypasses Row-Level
Security.** That is the single most important fact in this section, and
everything below follows from it.

### What RLS does and does not do here

RLS is **enabled on every table, with zero policies** (see the header of
[`supabase/migrations/0001_initial.sql`](../supabase/migrations/0001_initial.sql)).
That combination is deny-all for the `anon` and `authenticated` roles while the
service role passes straight through.

This is load-bearing on Supabase and would not have been on a plain Postgres
instance. Supabase publishes the `public` schema through PostgREST, reachable
with the project's publishable (anon) key. A table with RLS switched off is
therefore readable by anyone who has that key — which is not a secret. Enabling
RLS with no policies is what closes that door.

What it is **not**:

- It is **not** an isolation boundary between users. The application connects as
  one role for every request; the database cannot tell one signed-in user from
  another.
- It is **not** an isolation boundary between apps. See below.
- It is **not** defence-in-depth behind the application's own checks. A bug that
  makes the platform query the wrong row will be served, because the service role
  is permitted to read every row.

**Any table added in a future migration must also get
`enable row level security`.** Adding a policy is what would open it up, and
forgetting the statement entirely is what would expose it.

### Where authorization actually happens

Entirely at the application layer:

- Sensitive tables (`connector_configs`, `dashboard_widgets`,
  `dashboard_layouts`, `user_apps`, `user_app_grants`, `push_subscriptions`,
  `app_passwords`, `oauth_tokens`, …) are read and written only by trusted
  server code, never from a browser bundle.
- Helpers in [`src/lib/connectors/config.ts`](../src/lib/connectors/config.ts),
  [`src/lib/apps/access.ts`](../src/lib/apps/access.ts), and the dashboard
  `actions.ts` files require a `userId` derived from `requireServerSession()`
  (or `requireAdmin()` on admin paths) before issuing a query. The session pins
  the userId, so a caller cannot read or write another user's row.
- App-scoped tables carry an `_app_<slug>_` prefix applied by `ScopedClient`
  ([`src/lib/apps/scoped-db.ts`](../src/lib/apps/scoped-db.ts)). **This prefix is
  the entire app-to-app isolation boundary** — an app cannot name another app's
  table, and cannot name a platform table. It is enforced in application code,
  not by the database.
- The ESLint rules in [`eslint.config.mjs`](../eslint.config.mjs) stop app code
  importing the raw client at all, so an app cannot hand-write SQL that would
  sidestep the prefix.

### Reachability of the service-role key

`SUPABASE_SERVICE_ROLE_KEY` and `DATABASE_URL` carry no `NEXT_PUBLIC_` prefix,
which is what prevents Next.js inlining them into a client bundle. Both clients
are constructed lazily and only inside server modules. Adding a `NEXT_PUBLIC_`
prefix to either, or importing `@/lib/db/*` from a `"use client"` component,
would be a full database compromise.

---

## 9. Admin Authorization

Admin pages and server actions enforce authorization at two layers:

```
  THERE IS NO PROXY-LEVEL ADMIN GATE.
  src/proxy.ts only checks that a session cookie exists. It does not
  know whether the user is an admin, and /admin/* is not special to it.

  THE ONLY CHECK: src/lib/apps/access.ts
  - requireAdmin(session) re-reads the user from the database and
    verifies the `is_admin` column
  - Applied in every admin page component and every admin server action
  - Throws "Admin access required" if the user is not an admin
```

This is a single layer by design, not by omission: an admin flag carried in the
session JWT could go stale after a demotion, so `requireAdmin()` reads
`is_admin` from the database on every call rather than trusting the token.

Because server actions are directly invocable POST endpoints, each admin action
(`configureConnector`, `toggleUserGrant`, `toggleAppRegistration`,
`getAppSchema`, …) calls `requireAdmin()` itself. Nothing upstream does it for
them, so an action that forgets the call is fully exposed to any signed-in user.
Treat that as the review checklist item for any new admin action.

---

## 10. User Provisioning Controls

The `ensureUser()` function (`src/lib/apps/access.ts`) creates a database record
the first time a user signs in. An optional email domain allowlist prevents
unauthorized users from being provisioned:

```
Env var:       ALLOWED_EMAIL_DOMAINS
Format:        Comma-separated (e.g. "mix.mysite.com,example.com")
Behaviour:
  - When set:   Only users whose email domain matches may sign in
  - When unset: Any email domain is accepted
  - Enforced in: src/lib/auth/config.ts (emailAllowed), applied in the
                 credentials provider — the only sign-in path
```

The allowlist is a provisioning control, not an authentication control. It
decides who may become a user; it says nothing about what an existing user may
then access — that is the grant model in section 3.

---

## 11. Error Response Sanitization

App API route handlers use `safeErrorMessage()` (`src/lib/safe-error.ts`)
to prevent internal details from leaking to clients:

```
Development:  Returns the original error message for debugging
Production:   Returns only a generic fallback (e.g. "Failed to fetch deals")
```

This prevents database error messages (which may contain table names, column
names, or constraint details) and connector errors (which may contain API
URLs or credential hints) from reaching the browser.

---

## 12. Session Cookie Security

Session cookies are left at Auth.js v5 defaults. The platform previously
overrode them to `SameSite=None` + `Partitioned` (CHIPS) so the app could be
iframed by a browser-extension new-tab page; that extension is gone and the
override was removed, restoring the stricter defaults below.

| Flag          | Value                       | Purpose                            |
|---------------|-----------------------------|------------------------------------|
| `httpOnly`    | `true`                      | Prevents JavaScript access (XSS)   |
| `secure`      | `true` over HTTPS           | HTTPS-only transmission            |
| `sameSite`    | `lax`                       | Blocks cross-site POST requests     |
| `__Secure-`   | prefix over HTTPS           | Cookie may only be set over TLS    |
| Contents      | Signed/encrypted JWT (JWE)  | `session: { strategy: "jwt" }` — no server-side session table |

Because the strategy is `jwt`, there is no session record to revoke. Signing a
user out clears their cookie but does not invalidate an already-issued token
before its expiry; rotating `AUTH_SECRET` is what invalidates every outstanding
session at once.

---

## 13. Server-Side Request Forgery (SSRF)

**There is currently no platform-level SSRF defence, because there is currently
no platform code that fetches a user-supplied URL.** The hostname blocklist and
DNS-rebinding check that used to live here belonged to a link-scraper in an app
that has since been removed.

This is a gap to close *before* the next feature that fetches a URL on the
server, not after. Any such feature — a link preview, a webhook target, an
avatar importer, an app that proxies a user-provided endpoint — hands an
authenticated user the ability to make requests from inside the deployment's
network. On a managed platform the most valuable target is the instance
metadata endpoint.

A correct implementation needs both halves:

```
1. Validate the hostname string against a blocklist
   - localhost, 127.*, ::1, 0.0.0.0
   - 10.*, 172.16-31.*, 192.168.*        (RFC 1918 private)
   - 169.254.*, fd00::/8, fe80::*        (link-local / metadata / ULA)
   - Reject any scheme other than http: and https:

2. Resolve the hostname and re-check the ANSWER before fetching
   - Validating the string alone is defeated by DNS rebinding: an attacker
     registers a domain that resolves public at validation time and private
     at fetch time.
   - Resolve once, verify every returned address is public, then connect to
     that address.
```

Until such a feature exists, the relevant control is the ESLint boundary in
section 3 plus code review: app code cannot reach the network on the server
except through a connector, and connectors target fixed, admin-configured
upstream hosts rather than user-supplied ones.

---

## 14. Security Response Headers

All responses include security headers configured in `next.config.ts`:

| Header                  | Value                                  | Purpose                                      |
|-------------------------|----------------------------------------|----------------------------------------------|
| `Content-Security-Policy` | `frame-ancestors 'self'`            | Prevents clickjacking. Replaces `X-Frame-Options`, which is NOT set — `frame-ancestors` supersedes it and is the only framing control here. |
| `X-Content-Type-Options`| `nosniff`                             | Prevents MIME-type sniffing attacks          |
| `Referrer-Policy`      | `strict-origin-when-cross-origin`      | Limits referrer leakage to external sites    |
| `Permissions-Policy`   | `camera=(), microphone=(), geolocation=(self)` | Restricts browser API access         |

---

## 15. Request Body Size Limit

The API gateway caps request bodies to blunt memory-exhaustion denial of
service. It is an explicit check in `src/app/api/apps/[...slug]/route.ts`, not
route segment config:

```
Limit:     27 MB  (MAX_BODY_BYTES)
Mechanism: the `content-length` request header is compared BEFORE the body
           is read, so an oversized upload is rejected without buffering it
Scope:     All app API routes (via the gateway catch-all)
Response:  413 { "error": "Request body too large" }

Caveat:    a request that omits `content-length` (chunked transfer encoding)
           skips this check. Routes accepting uploads must enforce their own
           limit while streaming rather than relying on this one alone.
```

The rate limiter runs before body parsing (in the App Router, the request
body is not read until the handler calls `request.json()`), so rate limiting
applies even to oversized requests.

---

## 16. Connector Initialization Safety

When the gateway builds the `AppContext`, each declared connector is loaded
and initialized with decrypted credentials. If `initialize()` throws:

- The connector is **excluded** from `context.connectors` (not added in a
  half-initialized state)
- The error is **not propagated** to the app handler — the handler simply
  sees `connector.configured === false` or the connector missing from context
- Credential values that might appear in error messages are never logged or
  returned to the client

This is enforced by a nested try-catch in `src/lib/apps/context.ts` that
catches initialization failures separately from module-loading failures.


---

## 17. MCP Server and OAuth Authorization Server

MixOS exposes a single MCP server at `POST /api/mcp` so an MCP client (claude.ai,
Claude Desktop, Claude Code) can read app data on a user's behalf. This is the
only inbound surface authenticated by a **bearer token** rather than a session
cookie, and the only place MixOS acts as an OAuth **authorization server** rather
than an OAuth client.

### Authorization chain

A tool call succeeds only where three independent gates overlap. Each is checked
on **every** request; none is cached on the token.

| Gate | Source of truth | Effect of revoking |
| --- | --- | --- |
| App declares the tool | `mcp` in `app.json`, build-validated | Tool disappears at next deploy |
| User consented to the app for this client | `oauth_tokens.granted_apps` | User disconnects at `/account/mcp` |
| User still holds a grant for the app | `hasAppGrant()` — live DB read | Admin revokes; effective immediately |

Consent is a **ceiling**, the live grant is a **floor**. A refresh copies
`granted_apps` forward verbatim, so consent can never silently widen. `hasAppGrant`
(not `hasAppAccess`) is used deliberately — it is the authorization fact, and it
matches what the App Services broker already enforces for the same question.

The tool runs with the app's own `AppContext`, narrowed: same connectors, same
resolved app roles, same scoped data the user's own API-route requests get. There
is no second, subtly-different authorization surface to keep in step, and no
privilege escalation — a tool can never surface something the user couldn't
already reach in that app.

### Read-only enforcement

Three layers, because a model-driven caller with a leaked token writing to app
tables is the worst outcome this feature could have:

1. **Type** — `McpToolContext.db` is a `ReadOnlyScopedClient` with no
   `insert`/`update`/`upsert`/`delete`.
2. **Runtime** — the client is a `Proxy` that throws on those verbs and re-wraps
   itself across chained calls, so `as any` doesn't defeat it.
3. **ESLint** — `apps/**/mcp/**` cannot import `@/lib/db*`, the App Services
   broker, or the context builder.

**Known limitation:** the platform cannot determine which *connector* methods
mutate. Read-only is airtight for `ctx.db` and reviewer-enforced for
`ctx.connectors`. Treat a mutating connector call in an `mcp/` handler as a
blocking review finding.

### Token handling

- Tokens and authorization codes are **opaque** high-entropy random strings,
  never JWTs. Revocation must take effect on the next request, and that is worth
  one indexed lookup per call.
- Only `HMAC-SHA256(value, key)` digests are stored. The key is derived from
  `CONNECTOR_ENCRYPTION_KEY` via HMAC with a fixed label — the same PRF-separation
  pattern as `src/lib/apps/unlock-secret.ts` — so a database leak alone yields
  nothing replayable, and this key cannot be used to recover the base key or
  decrypt connector credentials. **No new environment secret.**
- HMAC rather than bcrypt: these are 256-bit random values with nothing to
  brute-force, and lookup must be by exact digest. (App *passwords* use bcrypt
  because those are low-entropy and human-chosen.)
- Access tokens live 1 hour; refresh tokens 30 days and **rotate** — the presented
  token is revoked in the same statement that reads it, so a replay fails.

### Authorization-code flow

- **PKCE S256 is mandatory.** `plain` is not accepted. Clients are public and no
  `client_secret` is ever issued; PKCE is the client authentication.
- Codes are **single-use with a 60-second TTL**, consumed by an `UPDATE ... WHERE
  consumed_at IS NULL` so two concurrent exchanges cannot both succeed. Rows are
  marked rather than deleted, so a replay is visible rather than looking unknown.
- Every code-exchange failure — unknown, expired, consumed, wrong client, wrong
  `redirect_uri`, bad verifier — returns an identical `invalid_grant`. A caller
  cannot probe which codes exist.
- `redirect_uri` is matched **exactly** against the set registered for that
  client. No prefix matching, no wildcards. A mismatch renders an error **on MixOS**
  and never redirects — redirecting an unvalidated URI is precisely the
  open-redirect an attacker is fishing for. A valid request the user *denies* does
  redirect, with `access_denied`.
- The origin for all issued URLs comes from `getAppOrigin()` (`NEXTAUTH_URL`),
  never the `Host` header, so host injection cannot steer a redirect target.
- The consent server action re-validates everything the page validated — client,
  redirect URI, PKCE, and every ticked app slug against both "declares MCP tools"
  and `hasAppGrant`. A server action is a public endpoint; "the page already
  checked" is not a security property.

### Open dynamic client registration

`POST /api/oauth/register` (RFC 7591) accepts registrations with no initial
access token. This is deliberate — it is what makes claude.ai's zero-config
connector flow work — and is safe because **registration grants nothing**. A
registered client can do exactly one thing: send a user to the consent screen. No
data moves until a logged-in MixOS user ticks specific apps there. Registration is
rate-limited per IP, redirect URIs must be `https`, `http` on loopback (RFC 8252),
or a native custom scheme, and only public clients are accepted.

### Transport and exposure

- `POST` only. `GET` (which would open a server→client SSE stream) and `DELETE`
  (session teardown) return 405 — MixOS is stateless and sends no server-initiated
  messages, so a single JSON response per request is the whole transport.
- Every 401 carries `WWW-Authenticate: Bearer ... resource_metadata="..."`. This
  is required for client bootstrap and is the single easiest header to omit and
  the hardest to debug from the client side.
- Rate limiting is **per token**, not per IP: claude.ai egresses from shared
  addresses, so an IP bucket would let one caller starve another.
- `Access-Control-Allow-Origin: *` is set on the two `.well-known` discovery
  documents **only**. They are public endpoint metadata with no user data. The
  token, authorize, and MCP endpoints get no CORS relaxation.
- `/api/mcp`, `/api/oauth`, and `/.well-known` are in `PUBLIC_ROUTE_PREFIXES`
  (`src/proxy.ts`) because "no session cookie" is the expected state. The consent
  screen at `/oauth/authorize` is deliberately **not** listed — it must require a
  session, and the redirect to `/login` is the intended behavior.

### Auditability

Every tool call writes a `telemetry_events` row with `source_type = 'mcp'`,
`source_slug` = the app, `event_name` = the tool, `caller_app_slug` = the OAuth
client id, and the acting user. Unlike app telemetry this is recorded whether or
not the app declares any events: the app didn't choose to be called, and an
operator needs to be able to see what a model has been reading.
