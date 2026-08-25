# Connector abstraction: resilient HTTP, auth strategies, and typed failure

## Context

Connectors today are a three-member interface — `name`, `configured`,
`initialize()` — and nothing else. Every connector hand-rolls `fetch` and
repeats one line of error handling:

```ts
if (!res.ok) throw new Error(`MyService API error: ${res.status}`);
```

That line is the entire HTTP story. There is no timeout, no retry, no backoff,
no `Retry-After` handling, no circuit protection, and no way for a caller to
tell "the admin typed the key wrong" apart from "the upstream is having an
outage." Both arrive as an untyped `Error` whose message is a bare number.

The intended audience makes this worse. A connector is supposed to be writable
by someone who is *not* a software engineer and has never integrated a
third-party API. Handed the current template, that person will produce
something that works on the happy path and fails opaquely everywhere else —
because the template teaches them to. `_template/index.ts` repeats the same
unprotected `fetch` three times.

The goal is to move all of it below the waterline: a connector author declares
*what* their API looks like and writes only the methods that are genuinely
specific to it. Authentication, retries, rate-limit behavior, status
classification, pagination, and user-safe error messages come from the
platform.

### What already exists (and what it constrains)

| Thing | Where | Why it matters here |
| --- | --- | --- |
| `BaseConnector` | [types.ts:55-59](../../src/lib/connectors/types.ts#L55-L59) | `initialize()` is **synchronous, returns `void`** — cannot await a token refresh. Must change. |
| Credential read | [config.ts:4-16](../../src/lib/connectors/config.ts#L4-L16) | Read-only at runtime. `saveConnectorConfig()` is reachable only from an admin action, so a refreshed token has nowhere to go. Must change. |
| Connector loading | [context.ts:55-93](../../src/lib/apps/context.ts#L55-L93), [context.ts:166-215](../../src/lib/apps/context.ts#L166-L215) | Two near-duplicate loaders. Fresh instance + `initialize()` per request; stateless by invariant 8. |
| Telemetry proxy | [telemetry.ts:136-167](../../src/lib/apps/telemetry.ts#L136-L167) | Existing per-method chokepoint. Sees method calls, **not** HTTP responses — so it cannot read `Retry-After` and must not be where retries live. |
| Config gate | [connector-gates.ts](../../src/lib/apps/connector-gates.ts) | Blocks app registration when credentials are absent. Explicitly "not a security boundary." |
| Manifest validation | [manifest-schemas.ts](../../scripts/manifest-schemas.ts) | Zod 4, already strict-object and build-aborting. New manifest fields plug straight in. |
| Platform-as-OAuth-*provider* | `src/lib/mcp/oauth.ts`, `/api/oauth/*` | Opposite direction (we serve MCP clients). `verifyPkce`, `hashSecret`, `randomSecret` are reusable primitives; the flow is not. |

**Prior art worth respecting.** A *user-scoped* OAuth model existed and was
deliberately removed — `OAuthCapableConnector`, the `scope` manifest field,
`/api/connectors/<name>/oauth/*`, `/account/connections`, and the
`user_connector_oauth` table ([architecture.md:62-69](../connectors/architecture.md#L62-L69),
[0001_initial.sql:144-156](../../supabase/migrations/0001_initial.sql#L144-L156)).
This plan does **not** resurrect that. What it adds is *tenant-scoped*
three-legged OAuth: one admin consents once on behalf of the deployment, and
the resulting tokens live in the existing `connector_configs` row like any
other credential. The one-credential-set-per-connector invariant holds.

**Dead code found.** `src/components/account/connector-row.tsx` is orphaned
from that removal — nothing imports it, `/account/connections` no longer
exists, and it references a deleted `src/lib/connectors/oauth.ts`. Delete it
in Phase 0 so it isn't mistaken for the model we're building.

---

## Decisions

Locked with the user:

1. **OAuth: tenant-level three-legged + client credentials.** Admin clicks
   "Connect" in the Registry, consents upstream, callback stores the refresh
   token. Platform refreshes automatically and writes back. Also supports
   2-legged client-credentials for machine-to-machine APIs.
2. **Policy lives in a base class, tuned by manifest data.** Connectors extend
   `HttpConnector` and call `this.request()`. Timeouts, retry counts, retryable
   statuses, rate-limit hints, pagination style, and auth strategy are declared
   in `connector.json` and schema-validated by the existing generator. A
   non-engineer edits JSON, never control flow — and the policy shows up in a
   diff.
3. **Resilience state is per-request for v1.** Honor `Retry-After`, bounded
   backoff with jitter, no cross-invocation memory. Zero new infra. The state
   interface is defined as a pluggable store so a shared backend can drop in
   later without touching any connector.
4. **Typed errors behind a platform envelope.** `ConnectorError` carries a
   category; a route helper converts it to a consistent JSON envelope. Upstream
   bodies are always dropped (invariant 13).
5. **Base surface includes all four:** required `testConnection()`, pagination
   helper, response-shape validation, inbound webhooks.
6. **No target platform — proven against a stub, not a vendor.** The
   abstraction is validated against a local stub authorization server and a fake
   upstream that can be driven into any status code on demand. No connector in
   this plan is written against a named third party; choosing a first real
   integration is separate work that *consumes* this abstraction rather than
   shaping it.
7. **Degraded UX is named and actionable**, non-technical. The connector's
   `displayName` is interpolated into a fixed sentence — *"Billing data is
   unavailable right now — an administrator needs to finish setting up
   {displayName}."* — so every connector produces the same shape of message
   without its author writing one. Admins additionally get a deep link to the
   Registry page.

### Consequences worth stating plainly

- **Decision 3 does not cover token refresh.** Per-request-only applies to
  *rate-limit and circuit state*. OAuth refresh tokens are persistence, not
  resilience state, and inherently need shared storage plus a lock — most
  providers rotate the refresh token on use, so two serverless invocations
  refreshing concurrently can permanently invalidate the credential. Phase 2
  adds a Postgres advisory lock for exactly this. These are different problems
  that happen to both involve "state."
- **Decision 5 makes v1 large.** Webhooks are a genuinely separate axis from
  outbound calls — inbound routing, signature verification, replay protection.
  Sequenced last (Phase 4) so Phases 0–3 ship a coherent, useful abstraction
  even if webhooks slip.
- **Retrying writes is unsafe by default.** Not asked about, decided here:
  non-idempotent methods (`POST`, `PATCH`) are **never** auto-retried unless
  the manifest declares `idempotent: true` or the call supplies an
  `Idempotency-Key`. A silently duplicated write is worse than a visible
  failure. Overrule this if a specific API makes it wrong.
- **Rate limiting classifies on the header, not the status code.** `429 Too
  Many Requests` is canonical, but it is not the only status that means "slow
  down" — some APIs throttle with `403`, others with `503`. Classification
  therefore reads `Retry-After` and documented rate-limit headers *first* and
  treats the number as a hint. Keying on `429` alone would misfile a throttled
  call as a permissions failure and never retry it.

---

## Structure

### Phase 0 — Foundations

**`src/lib/connectors/errors.ts`** *(new)* — the taxonomy everything else
speaks.

```ts
export type ConnectorErrorCategory =
  | "unconfigured"        // no credentials; configured === false
  | "auth_failed"         // 401, or OAuth refresh failed — admin must re-auth
  | "forbidden"           // valid credential, insufficient scope/permission
  | "rate_limited"        // 429, or 403/503 carrying rate-limit signals
  | "not_found"           // 404, 410
  | "invalid_request"     // 400, 405, 415, 422 — caller bug, never retryable
  | "conflict"            // 409, 412, 428
  | "payload_too_large"   // 413, 414
  | "timeout"             // client abort, 408, 504
  | "upstream_error"      // 500, 502, 503, 507
  | "network_error"       // DNS/TCP/TLS — fetch itself threw
  | "unexpected_response" // 2xx whose body failed schema validation
```

`ConnectorError` fields: `category`, `connectorName`, `status | null`,
`retryAfterMs | null`, `retryable`, `attempts`, `userMessage` (safe, plain
English), `adminHint` (what an admin should do), `upstreamRequestId | null`
(from `x-request-id` / `x-correlation-id` — safe and invaluable for support),
and `cause` (server-side only, non-enumerable so it cannot be accidentally
serialized).

**The upstream response body is never read into the error.** Status,
classification, and our own copy only — per invariant 13, those bodies
routinely carry account and tenant detail.

**`src/lib/connectors/status-map.ts`** *(new)* — the full classification table.

| Status | Category | Retry | Notes |
| --- | --- | --- | --- |
| 200, 201 | success | — | Parse per declared `responseType`. |
| 202 | success | — | Accepted ≠ complete; connector may need to poll. |
| 204, 205 | success | — | **No body.** Return `null`, never `res.json()` — the single most common hand-rolled bug. |
| 206 | success | — | Partial; only valid when a Range was sent. |
| 304 | success | — | Not-modified; return cached sentinel when using ETags. |
| 3xx (other) | `upstream_error` | no | `fetch` follows redirects; a surfaced 3xx means a loop or `redirect: "manual"`. |
| 400 | `invalid_request` | no | App bug. Fix the call, not the retry count. |
| 401 | `auth_failed` | **once** | OAuth only: refresh **exactly once**, replay, then fail. Never loop. |
| 403 | `forbidden` *or* `rate_limited` | conditional | Scope problem — **unless** rate-limit headers are present; some APIs throttle with 403. Manifest can force the reading. |
| 404 | `not_found` | no | Distinguish "no such record" from "wrong base URL" via `adminHint`. |
| 405, 415 | `invalid_request` | no | Wrong method / content type. |
| 408 | `timeout` | yes | Upstream-declared request timeout. |
| 409 | `conflict` | no | Caller resolves; retrying reproduces it. |
| 410 | `not_found` | no | Permanently gone. |
| 412, 428 | `conflict` | no | Precondition failed / required. |
| 413, 414 | `payload_too_large` | no | Chunk the request instead. |
| 422 | `invalid_request` | no | Validation failure. |
| 425 | `timeout` | yes | Too Early — replay-safe backoff. |
| 429 | `rate_limited` | yes | **Honor `Retry-After`** (delta-seconds *or* HTTP-date). |
| 431 | `invalid_request` | no | Headers too large — usually a token gone wrong. |
| 4xx (other) | `invalid_request` | no | Conservative default: don't hammer. |
| 500 | `upstream_error` | yes | |
| 501 | `invalid_request` | **no** | Not implemented — retrying never helps. |
| 502, 503 | `upstream_error` / `rate_limited` | yes | 503 **with** `Retry-After` is a throttle, not an outage — treat as rate-limited. |
| 504 | `timeout` | yes | |
| 505, 506 | `upstream_error` | no | Protocol-level; retrying never helps. |
| 507, 508 | `upstream_error` | yes | Storage/loop detected — may clear. |
| 5xx (other) | `upstream_error` | yes | |

**`src/lib/connectors/http-connector.ts`** *(new)* — the abstract base.

- `protected request<T>(path, init?, opts?)` — the only outbound path. Applies
  auth, timeout (`AbortSignal.timeout`), classification, retry, and validation.
- `protected paginate<T>(path, opts)` — `AsyncIterable<T>` over the declared
  pagination style, with a `maxPages` cap so a broken cursor can't spin
  forever.
- `abstract testConnection(): Promise<{ ok: true; detail?: string }>` —
  **required**. A cheap upstream call proving the credentials actually work.
- `configured` stays a cheap synchronous "are the required fields present";
  `testConnection()` is the live proof. Keeping them separate is what makes
  invariant 9 checkable rather than aspirational.

**Retry policy.** Exponential backoff, full jitter, base 250ms, cap 8s, 3
attempts default. Retries only `rate_limited`, `timeout`, `network_error`,
`upstream_error`. A `Retry-After` longer than the remaining deadline **fails
fast** carrying `retryAfterMs` instead of sleeping — a serverless function must
not burn its wall clock waiting. A per-call deadline (default 15s) bounds the
whole sequence including retries, so no app route can hang on a connector.

**`scripts/manifest-schemas.ts`** *(extend)* — new strict-object fields:
`auth` (strategy + per-strategy config), `http` (`baseUrl`, `timeoutMs`,
`maxRetries`, `retryOn`, `rateLimit`, `pagination`, `defaultHeaders`), and
`webhook`. Because the schema is strict and build-aborting, a typo in a
connector's policy fails the build rather than degrading silently at 3am.

**Also in Phase 0:** delete the orphaned
`src/components/account/connector-row.tsx`; collapse the two duplicate loaders
in [context.ts](../../src/lib/apps/context.ts) into one now that
`initialize()` becomes async.

### Phase 1 — Auth strategies

Declared in the manifest, implemented once in the base: `none`, `apiKey`
(header / query / bearer, configurable name and prefix), `basic`, and
`oauth2_client_credentials` (token fetched per request, cached for the request
lifetime only, refetched on 401).

`initialize()` becomes `async initialize(credentials): Promise<void>`. Both
call sites in [context.ts](../../src/lib/apps/context.ts) already sit in
`async` functions inside `try/catch`, so this is a signature change, not a
control-flow change.

### Phase 2 — Tenant three-legged OAuth

- `/api/connectors/<name>/oauth/start` — admin-only (`requireAdmin()`), builds
  the authorize URL with PKCE and a signed `state`.
- `/api/connectors/<name>/oauth/callback` — verifies `state`, exchanges the
  code, merges `{access_token, refresh_token, expires_at}` into the existing
  encrypted `connector_configs` row.
- Refresh-on-demand in the base class: if the access token is expired or within
  a 60s skew, refresh before the call.
- **Concurrency:** `pg_advisory_xact_lock` keyed on the connector name around
  refresh-and-write-back. Without it, two concurrent invocations both refresh,
  and a provider that rotates refresh tokens invalidates the credential
  permanently. Re-read inside the lock; if another invocation already
  refreshed, use its token.
- `saveConnectorConfig()` gains a narrow, non-admin, server-only sibling for
  token write-back — it may merge *only* token fields, never overwrite
  admin-entered client credentials.
- Registry UI: "Connect" / "Reconnect" button, token expiry, and the redirect
  URI to paste into the provider's console.

Reuse `verifyPkce`, `hashSecret`, `randomSecret` from `src/lib/mcp/oauth.ts`
rather than reimplementing.

### Phase 3 — Surfacing failure

**`src/lib/connectors/response.ts`** *(new)* — `connectorErrorResponse(err)`
maps a `ConnectorError` to a stable envelope and HTTP status:

```jsonc
{ "error": {
    "category": "unconfigured",
    "message": "Billing data is unavailable right now — an administrator needs to finish setting up Acme Billing.",
    "connector": "Acme Billing",                        // the connector's displayName
    "retryAfterMs": null,
    "adminActionUrl": "/admin/connectors/acme-billing"  // admins only
} }
```

`adminActionUrl` and `adminHint` are attached **only** when the requesting user
is an admin. Non-admins get the named, actionable sentence with no internal
detail; `unconfigured` and `auth_failed` both render as "an administrator needs
to…" because from the user's seat they are the same problem.

Client side: a shared degraded-state component so widgets look consistent
rather than each inventing an error style.

### Phase 4 — Response validation, webhooks, docs

- Zod 4 (already a dependency) for declared per-method response schemas →
  `unexpected_response` on drift, so an upstream silently changing its payload
  surfaces as a clear connector error instead of an undefined-property crash
  inside a widget.
- `/api/connectors/<name>/webhook` — HMAC verification (algorithm, header, and
  timestamp tolerance declared in the manifest), replay protection via a seen-id
  table, then dispatch to an optional `handleWebhook()` on the connector.
- Rewrite `connectors/_template/` to the new shape — this is the highest-
  leverage file in the change, since it is what every future author copies.
- Update [docs/connectors/](../connectors/) (all five guides),
  [connectors/AGENTS.md](../../connectors/AGENTS.md) invariants, and
  [connector-guide-tabs.tsx](../../src/components/connectors/connector-guide-tabs.tsx),
  which AGENTS.md requires be kept in sync.
- Build the test fixtures that stand in for a vendor: a **stub upstream** that
  can be driven into any status code, header, or body on demand, and a **stub
  authorization server** implementing authorize → code → token → refresh.
  Commit both — they are how every future connector's policy gets tested
  without credentials for a live third party.
- Add a `connectors/_template-oauth/` scaffold beside the existing
  `_template/`. Both stay underscore-prefixed, so the registry skips them
  (invariant 2) and neither can ship as a real connector.

---

## Verification

Per [connectors/AGENTS.md](../../connectors/AGENTS.md):

1. `npx tsx scripts/generate-project-registry.ts` — confirm new manifest fields
   validate and a bad policy value aborts the build with a path.
2. `npm run typecheck` — confirm `HttpConnector` conforms and async
   `initialize()` propagates cleanly.
3. `npm run lint` — the repo has custom rules in `eslint-rules/`.
4. Admin → Connector Registry: configure credentials, click **Test
   Connection**, confirm green check; enter a deliberately wrong key and
   confirm a plain-English failure with no upstream body echoed.
5. Complete a three-legged connect end to end against the **stub authorization
   server**: confirm PKCE and `state` are verified, tokens write back into
   `connector_configs`, and a forced expiry triggers exactly one refresh. Then
   point the stub at rotating refresh tokens and fire two concurrent calls —
   expect **one** refresh, not two. A stub tests this better than a real vendor
   could, because rotation and expiry are triggerable on demand rather than
   waited out.
6. Exercise each failure category against a stub upstream (401 → refresh-once
   then `auth_failed`; 429 with `Retry-After` → honored; 500 → backs off and
   succeeds on retry; 204 → no JSON parse crash; `POST` + 500 → **not**
   retried).
7. Confirm a non-admin sees the named-but-non-technical message and an admin
   sees the Registry deep link.

## Non-goals

- **No named third-party integration.** This plan delivers the abstraction and
  its test fixtures, nothing else. The first real connector is separate work
  that consumes it — deliberately, so the base class isn't quietly shaped
  around one vendor's quirks. Anything a single platform needs and others don't
  belongs in that connector's manifest policy, never in `HttpConnector`.
- **No per-user OAuth.** The removed user-scoped model stays removed. Every
  connector remains tenant-scoped: one admin-configured credential set, shared.
- **No shared rate-limit or circuit state in v1** (decision 3) — behind a
  pluggable store interface so a backend can be added later without touching a
  single connector.
