# Architecture

## Connector Structure

Each connector lives in its own directory under `/connectors` with two files: a manifest and an implementation class.

```
connectors/my-service-3f9a2c1b/
  connector.json    # Metadata, credential fields, setup guide
  README.md         # Optional — long-form description for the catalogue listing
  release-notes.json # Optional — one line per change, for the people it reaches
  index.ts          # Implementation class
  assets/           # icon.png and anything else the manifest names.
    icon.png        # Required. Square, >= 512x512. Copied to public/connector-assets/my-service-3f9a2c1b/
```

**Templates:** any connector directory whose name starts with an underscore (e.g. `connectors/_template/`) is treated as a template and skipped by the registry. Use this for starter scaffolds you want to keep in the repo without exposing to admins.

## What a connector is for

A connector is the layer between one provider's API and every app that uses it.
Building an app never changes a connector: **a connector changes when its
provider's API changes, and only then.** Five rules make that true:

1. **It covers the API, not the first app.** Every operation on each resource it
   touches, one public method per operation, named as the provider names it. A
   method that combines operations or is shaped for one screen belongs in that
   app.
2. **Each method names its operation.** `operation` on each `telemetry` entry is
   the provider operation the method calls, and the build allows one method per
   operation: a variant is an option, not a second method.
3. **It returns what the provider returns, typed.** Field selection and
   formatting are optional parameters that default to everything.
4. **It is versioned, and only adds within a major version.** See
   [Versions](#versions).
5. **It ships its writes, and each install allows them.** See
   [Changing data](#changing-data).

When an app needs something a connector lacks, and the provider has the
operation, the connector gains it as a plain mirror of that operation, in a new
minor version. If the provider doesn't have it, it belongs in the app.

## Connector Manifest (connector.json)

The manifest declares the connector's metadata and what credentials it needs. These fields appear in the Connector Registry admin UI where an admin can configure them.

```json
{
  "registryId": "my-service-3f9a2c1b",
  "displayName": "My Service",
  "version": "1.0.0",
  "icon": "assets/icon.png",
  "description": "Connector for the My Service API",
  "authors": [
    { "name": "Jane Doe", "email": "jane@example.com" }
  ],
  "setup": {
    "title": "Create an API key",
    "steps": [
      {
        "text": "Open API keys and create a key.",
        "link": { "label": "API keys", "url": "https://my-service.example.com/settings/api-keys" }
      }
    ]
  },
  "credentialFields": [
    { "key": "apiKey", "label": "API Key", "type": "password" },
    { "key": "baseUrl", "label": "Base URL", "type": "text" }
  ],
  "auth": {
    "strategy": "apiKey",
    "credentialKeys": ["apiKey"],
    "scopesUrl": "https://docs.my-service.example.com/api/scopes"
  },
  "telemetry": [
    { "method": "listItems", "operation": "GET /items", "description": "Listed items" },
    { "method": "createItem", "operation": "POST /items", "description": "Created an item", "mutates": true }
  ]
}
```

### Field Reference

| Field | Required | Description | Example |
| --- | --- | --- | --- |
| `$schema` | ✅ | Which shape the manifest is, and so which MixOS reads it: `https://mixos.org/schemas/connector/v1.json`, written first. The build refuses a manifest without it, or with a version this MixOS doesn't read. See [`$schema`](../apps/architecture.md#schema-which-shape-a-file-is). | `"$schema": "https://mixos.org/schemas/connector/v1.json"` |
| `registryId` | ✅ | The connector's name: its folder, and what apps name it by in `app.json` and `context.connectors`. A lowercase name, a hyphen and an 8-character hex id, minted once by `npm run new` or `npm run rename`. The build refuses a connector whose folder isn't named after it. | `"registryId": "my-service-3f9a2c1b"` |
| `displayName` | ✅ | Human-readable name shown in the Connector Registry admin page. | `"displayName": "My Service"` |
| `version` | ✅ | This release, as three numbers. Apps name the version they were built against, and any later release with the same major version satisfies them. See [Versions](#versions). | `"version": "1.2.0"` |
| `icon` | ✅ | Path inside the connector's own `assets/` directory, **written out in full including the `assets/` prefix**, shown on its Connector Registry tile. A `.png` or `.webp` must be **square, at least 512x512**; an `.svg` must have a `viewBox`. The generator checks the file and aborts the build otherwise. | `"icon": "assets/icon.png"` |
| `description` |  | What the **service** is, in a sentence or two. Not what the connector does with it, and not how to set it up. **Capped at 140 characters.** The tile shows its first 15 words; the configure dialog shows all of it. | `"description": "Highly popular email service by Google. Gmail tracks all of your email conversations."` |
| `tagline` |  | One line for a listing card on mixos.org — the version that fits beside the icon in a grid. Max 100 characters, single line. Where it is absent, `description` is used instead; setting only one of the two is the normal case. | `"tagline": "Read Gmail messages, threads and labels"` |
| `keywords` |  | Search and browse terms for the catalogue. Lowercase words, separated by single spaces or hyphens; max 10, no duplicates. Lowercase is enforced because a facet list dedupes on the exact string — `Gmail` next to `gmail` renders as two filters for one idea and splits the results between them. | `"keywords": ["email", "crm"]` |
| `license` |  | SPDX identifier or expression for the connector's own licence, or `UNLICENSED` for something not redistributable. Validated as a shape, not against the full SPDX list — which still rejects the mistake worth rejecting: prose. `"MIT License"` fails the build; `"MIT"` passes. | `"license": "MPL-2.0"` |
| `connectorUrl` |  | Where the connector lives for someone who wants to read about it — a homepage, a docs site, a repository directory. Absolute `https://` only: these render as links on pages served over https, and an author never sees the downgrade because their own dev server is http. | `"connectorUrl": "https://example.com/x"` |
| `connectorSupportUrl` |  | Where a user takes a problem with the connector — an issue tracker, a support page. Same `https://` rule. Kept separate from `connectorUrl` because "read about it" and "something is broken" are different destinations, and collapsing them sends bug reports to a marketing page. | `"connectorSupportUrl": "https://example.com/x/issues"` |
| `setup` | ✅ | Provisioning instructions, structured so the registry renders them as a numbered list with working links. See below. | |
| `setup.steps` | ✅ | Array of `{ text, why?, link? }`, at least one. The provider-side work only — the registry renders saving, authorizing and verifying as its own steps. One imperative sentence each; the UI numbers them, so don't number them yourself. | `{ "text": "Create an API key.", "link": { "label": "API keys", "url": "https://example.com/keys" } }` |
| `setup.steps[].why` |  | Rationale, shown behind a **"?"** the reader opens on hover or focus. Max 300 chars. Rationale *only* — a tooltip is not somewhere an instruction can live. | `"why": "Internal avoids Google's annual CASA assessment."` |
| `setup.steps[].link` |  | Where the step is carried out. If `label` appears in `text` as a standalone phrase, **that phrase becomes the link**; otherwise it trails the sentence. | `"link": { "label": "OAuth consent screen", "url": "https://…" }` |
| `setup.steps[].showRedirectUri` |  | Renders this deployment's redirect URI with a copy button beneath the step. Required on **exactly one** step of a three-legged connector, and rejected on any other strategy — both build-enforced. | `"showRedirectUri": true` |
| `setup.title` | ✅ | Label for the provider-side step. Max 60 characters. | `"title": "Create a Google Cloud OAuth app"` |
| `setup.notes` |  | `{ credentials?, authorize?, verify? }` — a provider-specific warning attached to the registry's own step, so it appears at the control it concerns. | `"notes": { "authorize": "Sign in as the shared mailbox, not as yourself." }` |
| `setup.docs` |  | Array of `{ label, url, why }` reference links — scope tables, API docs. Shown below the checklist, not as a step. **`why` is required**: it answers "when would I open this?" behind a "?", which a bare link cannot. | `{ "label": "Gmail API scopes", "url": "https://…", "why": "Open it to confirm gmail.readonly cannot send or delete." }` |
| `authors` |  | Array of `{ name, email }` objects identifying the connector's authors. Shown in the Connector Registry admin page. Optional but recommended so others know who to contact. | `"authors": [{ "name": "Jane Doe", "email": "jane@example.com" }]` |
| `credentialFields` |  | Array of credential fields the admin must provide. Each field appears as an input in the configuration form. Omit it only for a connector that needs no credentials (`auth.strategy` `none`, a public API): it is ready as soon as it is installed, and the registry has no Save step for it. Any other strategy without it fails the build. |  |
| `credentialFields[].key` | ✅ | Property name used to access this credential in the connector's `initialize()` method. | `"key": "apiKey"` |
| `credentialFields[].label` | ✅ | Label shown in the admin configuration form. | `"label": "API Key"` |
| `credentialFields[].type` | ✅ | Either `text` for visible input or `password` for masked input. Use `password` for API keys, tokens, and secrets. | `"type": "password"` |
| `auth` |  | How the platform authenticates. See below. Absent means `{ "strategy": "none" }`. | |
| `auth.scopesUrl` | ✅ (unless `strategy` is `none`) | The provider's scope reference page, which the registry's permission list is read from. See [Scopes](scopes.md). | `"scopesUrl": "https://docs.example.com/api/scopes"` |
| `http` |  | Transport policy: base URL, timeouts, retry budget, pagination. Every value has a working default. | |
| `webhook` |  | Inbound webhook verification. See [Webhooks](webhooks.md). | |
| `telemetry` | ✅ | Every public method apps can call, as `{ method, operation, description?, mutates? }`: the provider `operation` it calls, and `"mutates": true` on one that changes data. The build fails on a public method that is missing, or two naming the same operation. It is the whole of what an app can call, and each is auto-instrumented. See [Telemetry](telemetry.md). | `{ "method": "getItem", "operation": "GET /items/{id}" }` |

### Setup guidance and the icon

`description` and `setup` answer two different questions and are rendered in two
different places. `description` is what an admin reads on the **tile**, deciding
whether this is the connector they want. `setup` is what they read in the
**configure dialog**, once they have decided.

Two texts, answering two different questions:

| Field | Where | Answers |
| --- | --- | --- |
| `description` | tile (first 15 words), and the dialog in full | *what is this service?* |
| `setup` | the dialog body | *how do I connect it?* |

Write `description` about the **service**, not about the connector — "Highly
popular email service by Google", not "read-only access to a shared mailbox".
What your connector does with that service belongs in `setup` — its steps and
its `notes`. Because
the tile shows only the first 15 words, the first sentence should stand on its
own.

`description` is capped at 140, and the build fails above it. This field started
as the only place setup instructions could live, and one connector's grew to
1,400 characters of numbered steps the UI could only render as an unclickable
paragraph. `setup` is that somewhere now; the cap is what stops the prose
migrating back.

Every `url` must be `https:`; the schema rejects anything else, including
`javascript:` and `data:`. These become real anchors in an admin's browser, so a
bad URL is caught at build time rather than sanitized at render time.

**Name the destination in the sentence.** A step's `link.label` is matched
against its `text`: where the phrase appears, it becomes the link in place —
"On the [OAuth consent screen], set User type to Internal" — because that is the
thing being pointed at and the reader's eye is already there. A trailing
"OAuth consent screen ↗" after the full stop makes them read the name twice. The
match is whole-phrase, so a label of `API` will not light up the middle of
`APIs`; where the label does not appear at all the link simply trails the
sentence, which is fine for a destination the sentence never names.

**A reference link must say when it is for.** `setup.docs` renders below the
checklist rather than inside a step — a scope table sitting under "Create a
Google Cloud OAuth app" reads as part of that step and gets done or skipped
accordingly. Each one requires a `why`, shown behind a "?", because a link
inside a step is explained by the sentence around it and one of these has
nothing around it: "Gmail API scopes reference" does not tell an admin whether
they need it now, later or never. If you cannot say when someone would open it,
that is the answer — don't ship the link.

**The redirect URI goes where it is pasted.** Set `showRedirectUri` on the one
step that tells the admin to register it, and it renders there with a copy
button. It is the only value in the guide the manifest cannot contain — it comes
from the running deployment's origin — so a three-legged connector is required
to place it exactly once, and the build fails if it does not.

**Put the instruction in `text` and the justification in `why`.** Gmail's step
"set User type to Internal" is four words of instruction carrying thirty words
of justification about CASA assessments and 7-day refresh tokens. Inline, that
buries the instruction; deleted, the next person changes the setting back. The
"?" is the shape that fits — available to whoever wants it, out of the way of
whoever is just following along.

Do not write the OAuth explanation yourself. For a connector declaring
`oauth2_authorization_code`, the registry already explains what OAuth is, that
the client ID and secret must be saved *before* Connect will work, that tokens
are stored encrypted and refreshed automatically, and that whoever approves the
consent screen is the account the whole deployment acts as. It also renders the
redirect URI with a copy button, and lists `auth.scopes` so the ask is not a
surprise. `setup` covers what is specific to *this* provider.

An `icon` is a path inside the connector's own `assets/` directory, and every
connector must have one. The generator proves it exists and that a `.png` or
`.webp` is square and at least 512x512 (an `.svg` needs a `viewBox`), then
copies the whole directory to `public/connector-assets/<name>/` and rewrites the
manifest value to the URL the browser requests. `public/connector-assets/` is
generated and gitignored, exactly like `public/themes/` — the committed source
is `connectors/<name>/assets/`.

### Declarative policy

Authentication and transport behaviour are **declared, not coded**. The manifest
is schema-validated by the registry generator, and it is `strict` — an unknown
key, a wrong type, or a cross-field contradiction aborts the build with a
message pointing at the offending path. A typo in a retry policy fails at build
time rather than degrading silently in production.

```jsonc
"auth": {
  "strategy": "apiKey",        // none | apiKey | basic | oauth2_client_credentials | oauth2_authorization_code
  "in": "header",              // apiKey: header | query | bearer (default bearer)
  "name": "X-Api-Key",         // required when in is header or query
  "prefix": "Token ",          // optional value prefix
  "credentialKeys": ["apiKey"], // must exist in credentialFields; also derives `configured`
  "scopesUrl": "https://docs.example.com/api/scopes" // required unless strategy is none
},
"http": {
  "baseUrl": "https://api.example.com",  // a `baseUrl` credential overrides this at runtime
  "timeoutMs": 10000,                    // per attempt
  "deadlineMs": 15000,                   // whole call including retries
  "maxAttempts": 3,                      // TOTAL tries, not retries
  "retryOn": ["rate_limited", "upstream_error"],
  "rateLimitOn403": true,                // this API throttles with 403
  "defaultHeaders": { "X-Client": "mixos" },
  "maxResponseBytes": 8388608,
  "pagination": {
    "style": "cursor",                   // cursor | offset | page | link-header
    "itemsPath": "data",
    "cursorPath": "meta.next_cursor",
    "cursorParam": "cursor",
    "limitParam": "limit",
    "pageSize": 100,
    "maxPages": 50
  }
}
```

`maxAttempts` counts total tries deliberately — "maxRetries: 2 means 3 calls" is
exactly the off-by-one nobody should have to reason about.

Cross-field rules the schema enforces: an `apiKey` in a header or query must
name it; `basic` needs exactly two `credentialKeys`; the OAuth strategies need
a `tokenUrl` (and `authorizeUrl` for the three-legged flow); each pagination
style requires its own parameters; every credential key referenced by `auth`
or `webhook` must exist in `credentialFields`; and any strategy but `none` needs
at least one credential field.

> **Tool-written:** `lastUpdated` lives in `connector.json` as an ISO 8601 date-time (e.g. `"2026-08-24T03:21:40.694Z"`) and is stamped automatically: `.githooks/pre-commit` runs [`scripts/stamp-updated.ts`](../../scripts/stamp-updated.ts), which rewrites the date on every connector with a file in the commit and re-stages the manifest. It records when the connector last changed, so a dependency bump or a formatting pass inside it moves the date too. A commit that touches only `lastUpdated` never re-stamps, and nor does a merge, for a connector it brings in exactly as the other branch has it. Don't edit it by hand; an invalid value fails the build. A connector with no date yet shows **"Not yet committed"**.

## Versions

`version` is `X.Y.Z`, and every connector has one. An app names the version it
was built against on its entry, and any later release with the same major
version satisfies it: an app built against 1.2.0 works with 1.2.0 and 1.7.3,
and not with 2.0.0. That holds because within a major version a connector only
adds:

| Change | Version |
| --- | --- |
| A bug fixed, nothing an app can see changed | patch: 1.2.0 → 1.2.1 |
| A new method, an optional parameter, a new field in a result | minor: 1.2.0 → 1.3.0 |
| A method removed or renamed, what one takes or returns changed, a read made into a write | major: 1.2.0 → 2.0.0 |

Where it is held to that:

- **The build** fails an app whose entry the connector in the checkout doesn't
  satisfy, saying whether to update the connector or check the app against a
  new major version.
- **Registry install and update** refuse an app that needs a newer connector
  than the one installed, and a connector release with a major version an
  installed app wasn't built against.
- **The pre-commit hook and Danger**
  ([`scripts/check-connector-contract.ts`](../../scripts/check-connector-contract.ts))
  refuse a version that goes backwards, and a removed method or a read made
  into a write without a new major version.
- **mixos.org**, at publish, holds a release to the one before it: a higher
  version, at least a new minor one for an added method, a new major one for a
  removed method.

What a method takes and returns can't be read from the manifest, so changing it
is a new major version on the author's word. The Registry's checks catch the
rest.

## Release notes

`release-notes.json` beside `connector.json` says what each release changed,
one line at a time, for the admins who configure the connector and the people
whose apps use it. MixOS shows the notes from the last 14 days behind the gift
icon in the menu bar of every install where the connector is on, and App
Manager's Release Notes page keeps all of them. The file is optional.

```json
{
  "$schema": "https://mixos.org/schemas/release-notes/v1.json",
  "notes": [
    { "date": "2026-10-20", "version": "1.1.0", "note": "Apps can read attachments too. Nothing to set up: the scope it needs is one the connector already has." },
    { "date": "2026-08-28", "version": "1.0.0", "note": "First release: read-only access to one shared mailbox." }
  ]
}
```

The file is `{ "$schema", "notes" }`, and each note is `{ "date", "version"?, "note" }`: the day the release shipped as
`YYYY-MM-DD`, no later than tomorrow; the `version` from `connector.json` it
shipped as; and one line of plain text, 300 characters or fewer. Newest first,
and no note twice on one day. The build checks the file, and so does a Registry
install before the connector lands. Write for an admin, not a developer: what
the connector can now do, and anything they must do, such as allowing changes
or connecting again for a new scope. The rules are an app's, in full:
[Release notes](../apps/architecture.md#release-notes-release-notesjson).

## Changing data

A method declared `"mutates": true` changes data upstream, and every install
starts with all of them off. They run only with two keys:

1. **The app asks.** Its entry for the connector says `"access": "write"`.
2. **The admin allows.** On the connector's **Choose whether it can change data**
   step in Administration → Connectors, an admin presses **Allow changes**. It is
   kept in `platform_settings`, as `connector.writable.<name>`, so a publisher
   can't set it.

With either key missing, the method is refused before it runs: an app that
didn't ask gets an error naming its own manifest, and one that asked on a
read-only install gets a `forbidden` error telling an admin where to allow
changes. An app that requires the connector and asks to write can't be
activated until changes are allowed.

A scope only the write methods need is requested with `"requested": "write"`.
Connect asks for it only once changes are allowed, and so does a
client-credentials token for a caller allowed to write. A grant taken while the
connector was read-only doesn't hold it, so allowing changes on a connected OAuth
connector means connecting again, which the dialog and the activation gate both
ask for.

## How Connectors Work

Connectors follow a simple lifecycle:

1. The connector is **registered** automatically when the platform scans the `/connectors` directory and finds a valid `connector.json`.
2. An admin **configures credentials** in the Connector Registry admin page. Credentials are encrypted at rest using AES-256-GCM. If it has methods that change data, the admin also decides whether it may.
3. An app declares each connector it uses in its `app.json`, with the version it was built against, and the build holds the two together. The platform **initializes** the connector with decrypted credentials and injects it into the app context.
4. App API routes access the connector by its manifest name, `context.connectors["my-service-3f9a2c1b"]`, and call its declared methods.

## Security Model

Connectors run exclusively on the server side behind the secure API gateway. App client code (pages and widgets) cannot import connector modules directly — they must call their app's API routes, which receive initialized connectors via the app context. This ensures credentials are never exposed to the browser.

What an app receives is the connector narrowed to its declared methods
([`src/lib/apps/connector-reach.ts`](../../src/lib/apps/connector-reach.ts)).
`request()` and every other member the manifest doesn't declare throw, so an app
can't reach around the declaration to send its own request with the connector's
credential, and a write runs only with the two keys above.

## One credential set per connector

Every connector is *tenant-scoped*: an admin configures one credential set in
the Connector Registry and every user shares it.

**This includes OAuth.** A connector using the three-legged flow is still one
credential set: an admin presses **Connect** once on behalf of the whole
deployment, and the resulting tokens are stored in that connector's existing
encrypted `connector_configs` row alongside the client id and secret. Every user
of every app shares that single grant.

That is what makes the tenant model easy to reason about: because there is
exactly one credential set, any response a connector returns is the same
response any user would have received.

## User-scoped connectors

A connector may instead declare `"userScoped": true`, and then each person signs
into their own account. Use it only where one shared account is genuinely wrong
— somebody's own mail or calendar — because it costs the property just
described. Once a connector answers differently per user, every place a response
is stored, cached or logged becomes a place it can reach the wrong person.

The rules:

- **Three-legged OAuth only.** There is no per-user equivalent of an API key an
  admin pastes once. Build-enforced.
- **Only the grant is personal.** The client id and secret stay in
  `connector_configs` — an admin registers the application once — and the tokens
  live in `user_connector_oauth`, keyed `(user_id, connector_name)`, encrypted,
  cascading on user delete.
- **No scheduled job may use one.** A job runs with no user, so there is no
  grant to resolve; the connector would be absent at 3am and present in a page
  request. Build-enforced.
- **Absent, not broken.** `context.connectors.<name>` simply does not contain a
  user-scoped connector the caller has not connected, or whose grant the
  provider will no longer renew. An expired access token is renewed before the
  request runs, so one that is present has a grant it can use. An app checks for
  presence exactly as it already must for one an admin has not configured.
- **Cache keys must include the user.** The platform cannot enforce this,
  because an app chooses its own cache keys — see
  [Credentials](credentials.md#caching-a-user-scoped-response). A shared key
  over a per-user response serves one person's data to another.

People manage their own grants at `/account/connections`. In the Connector
Registry, an admin saves the client id and secret, which is the deployment's
whole part, and then connects their own account, which is what Verify connection
runs with.

