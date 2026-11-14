# How to Create or Modify a Connector

You are about to create or modify a connector under `connectors/`. **Read the sections below in order before writing any code.** The linked guides under `docs/connectors/` are the authoritative reference; do not guess based on training data.

The same guides are published on mixos.org, which the Connector Registry admin page links to.

**Before you start: write a plan.** For anything beyond a trivial tweak, write a build plan to `connectors/<slug>/plans/YYYYMMDD_HHMM-<plan-name>.md` first — **beside the connector it describes**, so the design history travels with the code (Context, decisions, file-level changes, verification). Every connector has a `plans/` directory, [`_template`](_template/plans/) included, so a scaffolded connector inherits the convention. A change to the connector *base layer* (`src/lib/connectors/`) is a *platform* plan and goes to `docs/plans/` instead. See [`../docs/plans/README.md`](../docs/plans/README.md).

---

## The contract: a connector mirrors its provider

A connector is the layer between one provider's API and every app that uses it. **Building an app never changes a connector: a connector changes when its provider's API changes, and only then.** Five rules make that true, and the build enforces the parts it can check.

1. **Cover the API, not the first app.** Every operation on each resource the connector touches, one public method per operation, named as the provider names it (`spreadsheets.values.batchGet` becomes `batchGetValues`). Not only the calls the app in front of you needs: the next app needs the others. A method that combines two operations, filters for one screen, or is named after an app's idea (`getKeyNumbers`) belongs in that app's `lib/server/`.
2. **Name each method's operation.** Every `telemetry` entry has `operation`: the provider operation it calls, as the provider's reference names it. The build allows one method per operation, so a variant is an option on the method, not a second method.
3. **Return what the provider returns, typed.** Declare upstream shapes with `z.looseObject`, so a field the schema doesn't name still reaches the app, and convert nothing lossily: a number stays a number. Field selection and formatting are optional parameters that default to the whole record. An app that wants less asks for less.
4. **Version it, and only add within a major version.** `version` in `connector.json` is `X.Y.Z`, and required. A new method, an optional parameter or a new field in a result is a new minor version. Removing or renaming a method, changing what one takes or returns, or making a read into a write is a new major version. Apps name the version they were built against, and the build, Register and the pre-commit hook hold every change to that ([`scripts/check-connector-contract.ts`](../scripts/check-connector-contract.ts)).
5. **Ship the writes; the admin allows them.** Declare each method that changes data `"mutates": true`, and request the scopes they need with `"requested": "write"`. On every install they stay off until an admin allows changes, and an app calls them only when its entry asks for `"access": "write"`. Minimum access is each install's decision, not each release's.

**When an app needs something a connector lacks:** if the provider has the operation, add it to the connector as a plain mirror of it, a new minor version, in a change of its own; never shape it for the app. If the provider doesn't have it, it belongs in the app.

## Hard invariants

Read these once, then read the guides. Most agent failures come from ignoring these rules, not from misreading the guides.

1. **`registryId` in `connector.json` is the connector's name, and the folder is named after it.** It reads `"registryId": "my-service-3f9a2c1b"`: lowercase letters and digits in words joined by single hyphens, then an id, eight hex characters minted once, so two people's `slack` can be installed side by side. The connector lives in `connectors/<registryId>/`, and apps name it by its `registryId` (`connectors`, `sync`, `mcp`, `context.connectors["…"]`). The build refuses a connector whose folder and `registryId` differ, and a Registry install refuses a release whose `registryId` isn't the name it is listed under. **Create a connector with `npm run new -- connector <name>`** (`--oauth` for the OAuth template): it copies the template, mints the id, names the folder after it and writes `registryId`. mixos.org lists the connector under its `registryId` and never mints one of its own. **Rename a connector only with `npm run rename`**, which records it in `extension-renames.json` so every instance moves its credentials and its users' connections to the new name. Its OAuth redirect URI and webhook URL name it, so register the new ones with the provider.
2. **Underscore-prefixed folders are templates** (`connectors/_template/`). The registry skips them. Never ship a real connector with a leading underscore. It skips dot-prefixed folders too, such as a copy set aside as `connectors/.old-<name>/`, so never start a connector's folder name with a dot either.
3. **Extend `HttpConnector`, never implement `BaseConnector` directly.** Authentication, timeouts, retries, backoff, `Retry-After`, status classification, and user-safe error messages all live in the base class. A connector that calls `fetch` itself opts out of every one of them — and reliably reinvents the `res.json()`-on-a-204 crash.
4. **Declare policy, don't code it.** Auth strategy, base URL, timeouts, retry budget, and pagination go in `connector.json` and are schema-validated at build time. Do not hand-roll a retry loop, a backoff, or an `Authorization` header.
5. **`testConnection()` is required.** One cheap authenticated call. It powers the Registry's Verify connection button, which is how a non-technical admin discovers a bad credential now instead of through a broken widget later.
6. **Connectors run server-side only.** Client code (widgets, pages) must never import a connector module. Apps reach connectors through their own API routes via `context.connectors.<name>`.
7. **No embedded secrets, ever.** Credentials come *only* through `initialize(credentials)` at runtime, sourced from the admin-configured, encrypted `connector_configs` table. Do not read env vars, hardcode tokens, or fall back to defaults for secrets. Access to `connector_configs` is enforced at the application layer — the `configureConnector` server action calls `requireAdmin()`, and credentials are decrypted only inside trusted server code.
8. **Do not hand-edit `src/generated/connector-registry.ts`.** It is produced by `scripts/generate-project-registry.ts`. Run the generator after changes (see Verify below).
9. **Do not hand-edit `lastUpdated` in `connector.json`.** It is stamped automatically by `.githooks/pre-commit` (via `scripts/stamp-updated.ts`) on any commit that touches this connector, and re-staged into that commit. A merge that only brings in another branch's change to the connector keeps that branch's date. It records when the connector last changed. A connector installed from the Registry is never stamped: its `.registry.json` records the files that were verified.
10. **`credentialFields[].key` must match what `initialize()` reads.** A typo here is a silent break.
11. **Connectors are stateless wrappers.** Do not cache data between requests — the connector is re-initialised for every app context build. If `initialize()` throws, the connector is excluded from context entirely — it is never added in a half-initialized state.
12. **`configured` must reflect reality.** Derive it from `auth.credentialKeys` rather than writing it by hand — the base class does this for you, and for the three-legged OAuth flow it additionally requires an actual grant, so a connector whose admin never pressed Connect correctly reports `false`. The rule itself lives in [`src/lib/connectors/status.ts`](../src/lib/connectors/status.ts), because the Connector Registry has to answer the same question about credentials it has read but never instantiated. Anything else needing to know how ready a connector is calls that function — it does not re-derive the answer.
13. **`description` is the tile blurb; `setup` is the instructions.** Both are written for admins — the Connector Registry is the only place a connector is ever surfaced to a human — but they are rendered in different places and only one of them can carry links. `description` is **what the service is** ("Highly popular email service by Google"), capped at 140 characters — not what your connector does with it, which belongs in `setup`. The registry tile shows its first 15 words and the configure dialog shows all of it, so the first sentence must stand on its own. In `setup.steps`, `text` is the instruction and `why` is the justification behind a "?" tooltip — never put something the reader must DO in `why`. Provisioning steps go in **`setup`** (`{ title, steps[], notes?, docs? }`) and cover the PROVIDER's console only — the registry renders saving, authorizing and verifying as its own steps and knows whether each is done. A step's `link.label` is linked in place where it appears in `text`; put the redirect URI on the one step that registers it with `showRedirectUri`. Every URL must be `https:`; the schema rejects anything else. Do not hand-write an explanation of OAuth or restate the redirect URI or the scopes — for an `oauth2_authorization_code` connector the registry already renders all three. See [Architecture](../docs/connectors/architecture.md#setup-guidance-and-the-icon).
14. **An `icon` is a file in the connector's own `assets/`.** Declare it as the full relative path (`"icon": "assets/icon.svg"`) — not a bare filename — ship the file at `connectors/<name>/assets/icon.svg`, and let the generator copy it to `public/connector-assets/<name>/`. A `.png` or `.webp` must be **square and at least 512x512**; an `.svg` must have a `viewBox`. The generator checks it and aborts the build otherwise. Never point `icon` at a URL, an absolute path, or anything containing `..`. It is required (see 15).
15. **Every connector ships a configuration experience.** `icon`, `setup.title`, `setup.steps` and — for any connector that authenticates — `auth.scopesUrl` are **required**; the build rejects a connector without them and names all of them at once. They are not decoration: without them an admin gets an unidentifiable tile, a blank first step, and a permissions list that can never populate. A connector with `auth.strategy` `none` reaches a public API, which has no permissions to list, so it needs no `scopesUrl`. A three-legged connector must also set `showRedirectUri` on exactly one step. `auth.scopes` — the provider's whole documented catalogue, each entry `{ scope, description?, access?, requested }` — is written **only** by `npx tsx scripts/check-scopes.ts <name> --write`, never by hand, and there is no admin-facing refresh: the catalogue is committed so a new write scope shows up in a diff. See [Registry UX](../docs/connectors/registry-ux.md) and [Scopes](../docs/connectors/scopes.md).
16. **Telemetry is declared, never coded.** List every public method of the class (except `initialize`, `testConnection` and `handleWebhook`, which only the platform calls) in `connector.json` `telemetry` (`[{ method, operation, description?, mutates? }]`), with the provider `operation` it calls and `"mutates": true` on any that changes anything upstream. The build fails on a public method missing from the list, a listed one the class doesn't have, or two naming the same operation; make a helper `private` if apps should not call it. The list is the whole of what an app can call: the platform hands an app its connector narrowed to these methods, so `request()` and every other member stay out of reach. It auto-instruments the listed methods and records which app and which user made each call. Never import a tracker, call one, or write `public.telemetry_events` from `index.ts`; the connector class stays untouched. See [`docs/connectors/telemetry.md`](../docs/connectors/telemetry.md).

**An admin can disable a connector** at Admin > Connectors. The platform then never constructs it: apps get a stand-in whose calls fail, and its webhooks, OAuth and Verify connection are refused before they reach the class. There is nothing to handle in `index.ts`, and a connector does not add an on/off setting of its own to `connector.json` or `credentialFields`. See [Credentials](../docs/connectors/credentials.md#turning-a-connector-off).

**An admin allows a connector to change data** at Admin > Connectors, on its own step of the Configure wizard; every connector starts read-only. Until then the platform refuses each method declared `mutates` before it runs, and Connect asks for none of the scopes requested with `"write"`. There is nothing to handle in `index.ts` either: a connector does not add a read-only mode of its own. See [Architecture](../docs/connectors/architecture.md#changing-data).

## Credential handling

Connectors are **tenant-scoped by default**: one credential set, configured once
by an admin in the Connector Registry and shared by every user. That is the
right answer for almost everything, and it is what makes a connector's output
easy to reason about — every user sees the same response.

A connector may declare `"userScoped": true` when one shared account is
genuinely wrong (a person's own mail or calendar). Then the client id and secret
are still tenant-wide, but each person authorises their own grant, stored in
`user_connector_oauth`. Three-legged OAuth only, never usable from a scheduled
job, and both rules are build-enforced. See
[Architecture](../docs/connectors/architecture.md#user-scoped-connectors).

Hard rules:

17. **Credentials come from `connector_configs`.** API keys, tokens, service-account identifiers — all of it arrives through [`getDecryptedConfig()`](../src/lib/connectors/config.ts) (AES-256-GCM at rest) and is handed to `initialize()`. Never read the table directly, and never accept a credential as a method argument from app code.
18. **Never log or echo credentials.** Not in `console.*`, not in error messages, not in API responses. Drop upstream error bodies on failure — they often contain account or tenant detail.
19. **Minimum scopes only.** Request the smallest scope set the connector's methods need when provisioning the upstream credential. In practice this is the `requested` flags in `auth.scopes`: `true` for what the read methods need, `"write"` for what only the write methods need, which is asked for only on an install whose admin allowed changes. The refresh preserves the flags precisely so that flipping one stays a deliberate, reviewable act. Adding a scope requires a security note in the PR. Never ask for `*.ReadWrite` with `true` when `*.Read` would do and the write scope can be `"write"`.
20. **Stay stateless.** Do not stash credentials or responses in module-level variables, closures outside the instance, or caches that outlive the request. The platform creates a fresh instance and calls `initialize()` per request — that is the only legal lifecycle.

## Release notes

21. **Release notes are one line each, in `release-notes.json` beside `connector.json`, never in the manifest.** The file is `{ "$schema", "notes": [...] }`, newest first, each note `{ "date", "version"?, "note" }`: the day the release shipped (`YYYY-MM-DD`, no later than tomorrow), the `version` it shipped as, and one line of plain text of 300 characters or fewer. Add one with every release an admin or a person whose apps use the connector would notice: a new method, a write that needs **Allow changes**, a new scope that means connecting again. Write it for them, not for a developer. The menu bar shows the last 14 days' notes on every install where the connector is on, and App Manager's Release Notes page all of them. The build and a Registry install check the file. See [Release notes](../docs/connectors/architecture.md#release-notes).

## Manifest versions

22. **Every JSON file starts with `$schema`, which says which shape it is.** `connector.json` starts `"$schema": "https://mixos.org/schemas/connector/v1.json"`, and `release-notes.json` `"$schema": "https://mixos.org/schemas/release-notes/v1.json"`. The build and a Registry install refuse a file without it, or naming a version this MixOS doesn't read: a newer one needs a newer MixOS, and an older one is a shape it no longer reads. Start from `npm run new`, whose template carries both; the pre-commit hook adds `$schema` to a manifest that has none, and `registryId` when the folder already ends in an id, and never changes either once set. `.registry.json` carries one too, written by install. mixos.org sets each release's minimum MixOS version from it. See [`$schema`](../docs/apps/architecture.md#schema-which-shape-a-file-is).

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
8. [Registry UX](../docs/connectors/registry-ux.md) — the admin experience the manifest builds: the four tabs, the one-step-at-a-time wizard, Next vs. a step's own action, how instructions carry links and values
9. [Scopes](../docs/connectors/scopes.md) — reading a provider's permissions in its own words, and what granted / documented / observed can each actually answer

Creating or modifying an **app** instead? See [`../apps/AGENTS.md`](../apps/AGENTS.md). A **theme**? See [`../themes/AGENTS.md`](../themes/AGENTS.md).

---

## Verify (run these before reporting done)

From the repo root:

1. `npx tsx scripts/generate-project-registry.ts` — regenerates `src/generated/connector-registry.ts`. Confirm your connector appears. The generator **schema-validates `connector.json`** (via `scripts/manifest-schemas.ts`): an unknown field, a wrong-typed value, a bad `credentialFields[].type`, or a `registryId` that doesn't match the folder **aborts the whole build** with a message pointing at the offending path. Keep the manifest within the fields in `src/lib/connectors/types.ts`. A Registry install runs these same checks on its download, none of which runs your code, and leaves the connector in `.mixos/pending/connectors/<name>/` until someone registers it in their checkout: **Review and register** on Admin > Connectors, which first shows what will run, or `npm run register -- connector/<name>`. Either moves it into `connectors/` and runs this generator, which is the first time your code runs there; a refusal puts it back in pending. A newer release of an installed connector is an update: **Update** on its notice or its Browse listing downloads it to pending, and Register swaps it for the folder in `connectors/`, keeping the old folder in `.mixos/backup/` until this generator accepts the new one, and putting it back if it doesn't. Its credentials and its users' connections carry over. The connector's folder carries `.registry.json`, written by install, which says where it came from and what was verified; it is committed with the connector, and never written by hand. A connector that is a different one than an instance knew under its name, by that record (a local connector reinstalled from the Registry, or a release from another repository), arrives there disabled, keeping its credentials, until an admin enables it by typing its name. To remove a connector from a checkout, use **Remove** on Admin > Connectors or `npm run remove -- connector/<name>`: it refuses while an app requires the connector, and its credentials stay in each database until an admin deletes them there with **Delete data…** on Admin > Connectors.
2. `npm run typecheck` — ensures the class conforms to `HttpConnector` and `credentialFields` shapes match.
3. `npm run verify:connectors` — runs the abstraction against a local stub upstream (and a stub OAuth token endpoint): retries, `Retry-After`, the write-safety rule, every auth strategy, write scopes asked for only once changes are allowed, the failure envelope, and webhook verification. Set `DATABASE_URL` to additionally exercise the advisory-lock and webhook-replay guarantees against real Postgres.
4. `npx tsx scripts/check-scopes.ts <name>` — proves `auth.scopesUrl` parses, and prints every scope with its read/write classification. **Read the output**: "14 scopes parsed" is not the test; whether the descriptions are English sentences and the split looks right is.
5. Start the dev server and, as an admin, open **Administration → Connectors**. Confirm the new connector renders with the expected credential fields, save credentials, and exercise it from a test app API route. For a connector with write methods, call one with changes off (it is refused) and again after allowing changes. Do not claim "done" on a connector you haven't actually configured and called.
6. Changing an existing connector: `npx tsx scripts/check-connector-contract.ts` after staging, which the pre-commit hook also runs. It refuses a version that goes backwards, and a removed method or a read made into a write without a new major version.

---

## Anti-patterns (do not do these)

- A method shaped around one app: named after the app's idea, combining operations, or filtering for one screen. That belongs in the app.
- Covering only the operations the current app calls, so the next app has to change the connector.
- Projecting away fields, or converting a value lossily, to fit one app's mapper. Make the field list a parameter.
- Removing or renaming a method, or changing what it takes or returns, without a new major version.
- Two methods for the same provider operation. Make the difference an option.
- `"requested": true` on a write scope that only the write methods need. Use `"write"`.
- Calling `fetch` directly instead of `this.request()`, or hand-rolling a retry loop, a backoff, or an `Authorization` header.
- Catching a `ConnectorError` to re-throw it with the upstream's response body attached. Those bodies carry account and tenant detail — the base class drops them on purpose.
- Re-verifying a webhook signature inside `handleWebhook()`, or swallowing an error there (the delivery is then lost for good — throw instead, and the provider retries).
- Declaring the reserved `oauth_*` credential keys, or reading them from a connector method.
- Reading secrets from `process.env` or hardcoding them.
- Importing a connector from client code.
- Stateful caching across requests on the connector instance.
- Adding fields to `connector.json` that aren't in `src/lib/connectors/types.ts`.
- Burying setup instructions in `description`, where the UI renders them as an unclickable paragraph, instead of in `setup`.
- Pointing `icon` at a remote URL, or shipping a PNG or WebP that isn't a square of at least 512x512. Use `npx tsx scripts/prepare-icon.ts <name> <url-or-file>` — it keys out a flat background, trims and re-pads, so one connector's mark isn't twice the size of its neighbour's.
- Hand-writing an explanation of OAuth, or restating the redirect URI or the scopes, in `setup`. The registry renders all three itself.
- Putting an instruction in `why`. It is a tooltip; anything the reader must DO belongs in `text`.
- Pointing `auth.scopesUrl` at an API overview rather than the page that tabulates scopes against descriptions.
- Editing `src/generated/connector-registry.ts` by hand.
- Shipping a real connector under a folder starting with `_`.
- A folder name that doesn't match the manifest `registryId`.
- Reporting `configured: true` when required credentials are missing.
- Logging credentials, or surfacing an upstream error body to a client — those bodies routinely carry account and tenant detail.
- Reading `public.connector_configs` directly from an app or widget — always go through `context.connectors.<name>` so the platform's access checks run.
