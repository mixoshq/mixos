# How to Create or Modify a Connector

You are about to create or modify a connector under `connectors/`. **Read the sections below in order before writing any code.** The linked guides under `docs/connectors/` are the authoritative reference; do not guess based on training data.

The same content is rendered in the UI at the Connector Registry admin page by [`src/components/connectors/connector-guide-tabs.tsx`](../src/components/connectors/connector-guide-tabs.tsx), which reads these markdown files directly. Editing a guide updates the UI; adding a new one means registering it in that component's `TABS` list.

**Before you start: write a plan.** For anything beyond a trivial tweak, write a build plan to `docs/plans/YYYYMMDD_HHMM-<plan-name>.md` first (Context, decisions, file-level changes, verification). See [`../docs/plans/README.md`](../docs/plans/README.md).

---

## Hard invariants

Read these once, then read the guides. Most agent failures come from ignoring these rules, not from misreading the guides.

1. **Folder name *is* the `name` in `connector.json`.** They must match exactly. Use lowercase letters, digits, and hyphens (e.g. `my-service`).
2. **Underscore-prefixed folders are templates** (`connectors/_template/`). The registry skips them. Never ship a real connector with a leading underscore.
3. **Extend `HttpConnector`, never implement `BaseConnector` directly.** Authentication, timeouts, retries, backoff, `Retry-After`, status classification, and user-safe error messages all live in the base class. A connector that calls `fetch` itself opts out of every one of them — and reliably reinvents the `res.json()`-on-a-204 crash.
4. **Declare policy, don't code it.** Auth strategy, base URL, timeouts, retry budget, and pagination go in `connector.json` and are schema-validated at build time. Do not hand-roll a retry loop, a backoff, or an `Authorization` header.
5. **`testConnection()` is required.** One cheap authenticated call. It powers the Registry's Test Connection button, which is how a non-technical admin discovers a bad credential now instead of through a broken widget later.
6. **Connectors run server-side only.** Client code (widgets, pages) must never import a connector module. Apps reach connectors through their own API routes via `context.connectors.<name>`.
7. **No embedded secrets, ever.** Credentials come *only* through `initialize(credentials)` at runtime, sourced from the admin-configured, encrypted `connector_configs` table. Do not read env vars, hardcode tokens, or fall back to defaults for secrets. Access to `connector_configs` is enforced at the application layer — the `configureConnector` server action calls `requireAdmin()`, and credentials are decrypted only inside trusted server code.
8. **Do not hand-edit `src/generated/connector-registry.ts`.** It is produced by `scripts/generate-project-registry.ts`. Run the generator after changes (see Verify below).
9. **Do not hand-edit `lastUpdated` in `connector.json`.** It is stamped automatically by `.githooks/pre-commit` (via `scripts/stamp-updated.ts`) on any commit that touches this connector, and re-staged into that commit. It records when the connector last changed.
10. **`credentialFields[].key` must match what `initialize()` reads.** A typo here is a silent break.
11. **Connectors are stateless wrappers.** Do not cache data between requests — the connector is re-initialised for every app context build. If `initialize()` throws, the connector is excluded from context entirely — it is never added in a half-initialized state.
12. **`configured` must reflect reality.** Derive it from `auth.credentialKeys` rather than writing it by hand — the base class does this for you, and for the three-legged OAuth flow it additionally requires an actual grant, so a connector whose admin never pressed Connect correctly reports `false`.
13. **`description` is written for admins.** It is shown in the Connector Registry, which is the only place a connector is ever surfaced to a human. Keep setup instructions and required scopes there.
14. **Telemetry is declared, never coded.** To track usage, list the methods to count in `connector.json` `telemetry` (`[{ method, description? }]`) — the platform auto-instruments them via the `context.connectors.<name>` proxy and records which app made each call. Never import a tracker, call one, or write `public.telemetry_events` from `index.ts`; the connector class stays untouched. `method` names must match public methods on the class. See [`docs/connectors/telemetry.md`](../docs/connectors/telemetry.md).

## Credential handling

Every connector is **tenant-scoped**: one credential set, configured once by an
admin in the Connector Registry and shared by every user. There is no per-user
authentication, and no per-user token storage.

Hard rules:

15. **Credentials come from `connector_configs`.** API keys, tokens, service-account identifiers — all of it arrives through [`getDecryptedConfig()`](../src/lib/connectors/config.ts) (AES-256-GCM at rest) and is handed to `initialize()`. Never read the table directly, and never accept a credential as a method argument from app code.
16. **Never log or echo credentials.** Not in `console.*`, not in error messages, not in API responses. Drop upstream error bodies on failure — they often contain account or tenant detail.
17. **Minimum scopes only.** Request the smallest scope set the feature needs when provisioning the upstream credential. Adding a scope requires a security note in the PR. Never ask for `*.ReadWrite` if `*.Read` would do.
18. **Stay stateless.** Do not stash credentials or responses in module-level variables, closures outside the instance, or caches that outlive the request. The platform creates a fresh instance and calls `initialize()` per request — that is the only legal lifecycle.

Authoritative types: [`src/lib/connectors/types.ts`](../src/lib/connectors/types.ts). Starting point: [`connectors/_template/`](_template/).

---

## Guides (read in order)

1. [Architecture](../docs/connectors/architecture.md) — directory layout, `connector.json` manifest and its declarative `auth` / `http` policy, lifecycle, security model
2. [Implementation](../docs/connectors/implementation.md) — `HttpConnector`, `request()`, retries, pagination, `testConnection()`, full example
3. [Usage in Apps](../docs/connectors/usage-in-apps.md) — how apps declare and call connectors
4. [Failure handling](../docs/connectors/failure-handling.md) — the error taxonomy, the response envelope, and what a user actually sees
5. [Credentials](../docs/connectors/credentials.md) — encryption, tenant OAuth, configuration status checks
6. [Webhooks](../docs/connectors/webhooks.md) — signature verification, freshness, replay protection
7. [Telemetry](../docs/connectors/telemetry.md) — declaring which methods to count, auto-instrumented usage tracking, caller-app attribution

Creating or modifying an **app** instead? See [`../apps/AGENTS.md`](../apps/AGENTS.md).

---

## Verify (run these before reporting done)

From the repo root:

1. `npx tsx scripts/generate-project-registry.ts` — regenerates `src/generated/connector-registry.ts`. Confirm your connector appears. The generator **schema-validates `connector.json`** (via `scripts/manifest-schemas.ts`): an unknown field, a wrong-typed value, a bad `credentialFields[].type`, or a `name` that doesn't match the folder **aborts the whole build** with a message pointing at the offending path. Keep the manifest within the fields in `src/lib/connectors/types.ts`.
2. `npm run typecheck` — ensures the class conforms to `HttpConnector` and `credentialFields` shapes match.
3. `npm run verify:connectors` — runs the abstraction against a local stub upstream (and a stub OAuth token endpoint): retries, `Retry-After`, the write-safety rule, every auth strategy, the failure envelope, and webhook verification. Set `DATABASE_URL` to additionally exercise the advisory-lock and webhook-replay guarantees against real Postgres.
3. Start the dev server and, as an admin, open **Administration → Connector Registry**. Confirm the new connector renders with the expected credential fields, save credentials, and exercise it from a test app API route. Do not claim "done" on a connector you haven't actually configured and called.

---

## Anti-patterns (do not do these)

- Calling `fetch` directly instead of `this.request()`, or hand-rolling a retry loop, a backoff, or an `Authorization` header.
- Catching a `ConnectorError` to re-throw it with the upstream's response body attached. Those bodies carry account and tenant detail — the base class drops them on purpose.
- Re-verifying a webhook signature inside `handleWebhook()`, or swallowing an error there (the delivery is then lost for good — throw instead, and the provider retries).
- Declaring the reserved `oauth_*` credential keys, or reading them from a connector method.
- Reading secrets from `process.env` or hardcoding them.
- Importing a connector from client code.
- Stateful caching across requests on the connector instance.
- Adding fields to `connector.json` that aren't in `src/lib/connectors/types.ts`.
- Editing `src/generated/connector-registry.ts` by hand.
- Shipping a real connector under a folder starting with `_`.
- A folder name that doesn't match the manifest `name`.
- Reporting `configured: true` when required credentials are missing.
- Logging credentials, or surfacing an upstream error body to a client — those bodies routinely carry account and tenant detail.
- Reading `public.connector_configs` directly from an app or widget — always go through `context.connectors.<name>` so the platform's access checks run.
