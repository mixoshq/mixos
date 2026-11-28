# Secrets out of the app process (design only)

**Status:** decided, 28 November 2026: T3a isn't built, and T3b and T3c are
the runners of
[`20261128_0146-out-of-process-runners.md`](20261128_0146-out-of-process-runners.md),
approved the same day. Nothing here is built on its own. It is Item 4's T3 in
[`20261127_1649-runtime-isolation-hardening.md`](20261127_1649-runtime-isolation-hardening.md)
§7.

**Scope:** platform. Where the server's keys, the database password and
connector credentials live, relative to the code of the apps it runs.

## Context

App code runs in the platform's Node process. Item 4's cheap tiers make the
secrets hard to reach:

- **T0** (Item 0): a frozen `context`, and connectors handed over as facades
  with no fields.
- **T1**: the secrets out of `process.env` at startup
  (`src/lib/env/secrets.ts`).
- **T2**, in its shipped form: `Function` locked against reflection
  (`src/lib/platform/reflection-lock.ts`).
- **The scan**: `.constructor`, `__proto__` and the prototype getters refused
  in app code.

None of them changes the fact underneath: the secrets are in the same address
space as the app's code. Code that gets around the scan, and the reflection
lock, can call `readSecret()`, use the platform's database pool, or read a
connector's decrypted credentials off the heap. The threat model says so
(`docs/threat-model.md`, the first row's last column).

Moving the secrets is the only way to stop that. Three options follow, from
narrowest to widest.

## The options

| | What moves | What it stops | What it leaves | Vercel | Render | Railway | Compose |
|---|---|---|---|---|---|---|---|
| **T3a** Key service | The encryption keys. A sidecar decrypts on request, bound to a purpose, and audits each call. | Bulk theft of the keys for use offline, with a copy of the database | A live attacker asking the sidecar; decrypted credentials, which the process still holds while it uses them; `DATABASE_URL` | ✗ no sidecar; only as a separate HTTPS deployment, with its latency | ✓ private service (a second billed service) | ✓ private networking | ✓ a container |
| **T3b** Connector gateway | Connectors and their credentials. A service runs connector methods; an app's process gets a stub for each method its manifest lets it call. | Credentials in the app's process: "the manifest is the whole of what an app can do with a connector" becomes true at runtime | `DATABASE_URL` and the other keys, still in the process | ✗ realistically | ✓ | ✓ | ✓ |
| **T3c** Apps out of process | Apps. The platform process never runs app code (= Item 5b). | Everything above, for the apps that move | The platform's own dependencies | partial | ✓ | ✓ | ✓ |

### T3a: a key service

**Shape.** A small HTTP service on a private network, holding
`CONNECTOR_ENCRYPTION_KEY`, `USER_OAUTH_ENCRYPTION_KEY`,
`APP_SETTINGS_ENCRYPTION_KEY` and `GITHUB_APP_ENCRYPTION_KEY`. The platform
calls `decrypt(purpose, ciphertext)`, where `purpose` names the table and
row, and the service checks that the ciphertext's AAD matches the purpose.
Every call is logged with the request's app.

**Why it is narrow.** The platform decrypts on almost every request: each
context build reads its connectors' credentials. So the process still holds
plaintext credentials for as long as a request uses them. An attacker inside
the process asks the service, as the platform does. What it stops is a key
leaving with the database for decryption elsewhere, which `docs/threat-model.md`
already bounds ("an encryption key is useless without the database").

**Recommendation:** not worth a second service on its own.

### T3b: a connector gateway

**Shape.** Connector code and the credential tables move to a gateway
process. It shares the database, under a role that can read
`connector_configs`, `connector_app_configs` and `user_connector_oauth`, and
that the platform's role can't. The app's process gets, for each declared
connector, a stub with one method per method the app may call (the rules in
`appReachRules`, `src/lib/apps/connector-reach.ts`). A call is an RPC:

```
POST /call
{ app, connector, method, args, userId?, writes }   → result, or a ConnectorError envelope
```

The gateway:

- authenticates the platform with a per-deployment secret. The platform's
  process holds that secret, so an attacker inside it could call the gateway,
  but only through the methods and checks below;
- re-checks the rules itself, from its own copy of the registry: the app
  declares the connector, the method is declared, a write needs `"write"` and
  Allow changes. The platform's check stays as a first refusal;
- resolves the credential (an app's own first, §3.4), renews tokens under the
  existing advisory locks, and records telemetry with the app;
- runs webhooks, Verify and OAuth callbacks, which also need the credentials.

**What changes for authors.** Nothing for an app: `context.connectors.x.method()`
is already an async call. A connector's arguments and results must be JSON, which
almost all are; a connector method that takes a callback or returns a stream
needs a different shape, and the build can flag it from the TypeScript types.

**Cost.** A network hop per connector call: about 1 ms on a private network,
small beside the upstream API's own latency. A second service on Render and
Railway; a second container on Compose. On Vercel there is no private network
and a second function's cold start would sit on every connector call, so the
gateway stays in-process there, as today, and the docs say which hosts have it.

**What it leaves.** The database password and the platform's own keys are still
in the app's process, so an attacker there still has the database (bounded,
since Item 2, to what the platform's role can do: every app's tables, not the
credential tables, under the role split above).

**Recommendation:** the most value per unit of work. It shares its runner,
authentication and deployment shape with 5b and 7b, so it should be designed
with them, in the one design doc §15 already schedules after 5a.

### T3c: apps out of process

The platform process never runs app code, so nothing in it is an app's to
reach: not the keys, not the pool, not the credentials. This is Item 5b, for
Registry apps first, and its design doc is the one §15 schedules. It is the
complete answer and the largest change: routes, jobs, MCP tools, services and
hooks all become calls into an app runner, which needs `context` rebuilt as an
RPC surface (database through the runner of Item 2, connectors through T3b).

## Recommendation

1. Don't build T3a.
2. Design T3b and T3c together, with 7b, in the 5b/7b design doc: one runner
   process type, one authentication scheme, one deployment shape per host.
3. Until then, the four in-process tiers above are what holds, and the docs say
   exactly how far.

## Open questions

- **Vercel.** Does any shape of T3b or T3c run there without a second billed
  deployment? §10 of the hardening plan says strong isolation may be
  Docker/Render/Railway-only; this doc assumes so.
- **The database role split for T3b.** The credential tables would need a
  role the platform's own login can't assume, and the release step would have
  to create it. That is a migration and a change to the hosting docs'
  one-connection-string setup.
- **Telemetry and audit.** Whether the gateway writes `telemetry_events` itself
  (simpler, one writer) or returns what the platform writes (no new database
  privilege).
