# Architecture

## Connector Structure

Each connector lives in its own directory under `/connectors` with two files: a manifest and an implementation class.

```
connectors/my-service/
  connector.json    # Metadata, credential fields, setup guide
  README.md         # Optional — long-form description for the catalogue listing
  index.ts          # Implementation class
  assets/           # Optional. icon.png and anything else the manifest names.
    icon.png        # Square, >= 512x512. Copied to public/connector-assets/my-service/
```

**Templates:** any connector directory whose name starts with an underscore (e.g. `connectors/_template/`) is treated as a template and skipped by the registry. Use this for starter scaffolds you want to keep in the repo without exposing to admins.

## Connector Manifest (connector.json)

The manifest declares the connector's metadata and what credentials it needs. These fields appear in the Connector Registry admin UI where an admin can configure them.

```json
{
  "name": "my-service",
  "displayName": "My Service",
  "description": "Connector for the My Service API",
  "authors": [
    { "name": "Jane Doe", "email": "jane@example.com" }
  ],
  "credentialFields": [
    { "key": "apiKey", "label": "API Key", "type": "password" },
    { "key": "baseUrl", "label": "Base URL", "type": "text" }
  ]
}
```

### Field Reference

| Field | Required | Description | Example |
| --- | --- | --- | --- |
| `name` | ✅ | Unique identifier for the connector. Used in app.json and internally. Should be lowercase with hyphens. | `"name": "my-service"` |
| `displayName` | ✅ | Human-readable name shown in the Connector Registry admin page. | `"displayName": "My Service"` |
| `icon` |  | Path inside the connector's own `assets/` directory, **written out in full including the `assets/` prefix**, shown on its Connector Registry tile. **Square, at least 512x512**, `.png` / `.webp` / `.svg`; the generator measures it and aborts the build otherwise. Omit it and the tile renders a generic plug glyph. | `"icon": "assets/icon.png"` |
| `description` |  | What the **service** is, in a sentence or two. Not what the connector does with it, and not how to set it up. **Capped at 140 characters.** The tile shows its first 15 words; the configure dialog shows all of it. | `"description": "Highly popular email service by Google. Gmail tracks all of your email conversations."` |
| `tagline` |  | One line for a listing card on mixos.org — the version that fits beside the icon in a grid. Max 100 characters, single line. Where it is absent, `description` is used instead; setting only one of the two is the normal case. | `"tagline": "Read Gmail messages, threads and labels"` |
| `keywords` |  | Search and browse terms for the catalogue. Lowercase words, separated by single spaces or hyphens; max 10, no duplicates. Lowercase is enforced because a facet list dedupes on the exact string — `Gmail` next to `gmail` renders as two filters for one idea and splits the results between them. | `"keywords": ["email", "crm"]` |
| `license` |  | SPDX identifier or expression for the connector's own licence, or `UNLICENSED` for something not redistributable. Validated as a shape, not against the full SPDX list — which still rejects the mistake worth rejecting: prose. `"MIT License"` fails the build; `"MIT"` passes. | `"license": "MPL-2.0"` |
| `connectorUrl` |  | Where the connector lives for someone who wants to read about it — a homepage, a docs site, a repository directory. Absolute `https://` only: these render as links on pages served over https, and an author never sees the downgrade because their own dev server is http. | `"connectorUrl": "https://example.com/x"` |
| `connectorSupportUrl` |  | Where a user takes a problem with the connector — an issue tracker, a support page. Same `https://` rule. Kept separate from `connectorUrl` because "read about it" and "something is broken" are different destinations, and collapsing them sends bug reports to a marketing page. | `"connectorSupportUrl": "https://example.com/x/issues"` |
| `setup` |  | Provisioning instructions, structured so the registry renders them as a numbered list with working links. See below. | |
| `setup.steps` | ✅ (if `setup`) | Array of `{ text, why?, link? }`. The provider-side work only — the registry renders saving, authorizing and verifying as its own steps. One imperative sentence each; the UI numbers them, so don't number them yourself. | `{ "text": "Create an API key.", "link": { "label": "API keys", "url": "https://example.com/keys" } }` |
| `setup.steps[].why` |  | Rationale, shown behind a **"?"** the reader opens on hover or focus. Max 300 chars. Rationale *only* — a tooltip is not somewhere an instruction can live. | `"why": "Internal avoids Google's annual CASA assessment."` |
| `setup.steps[].link` |  | Where the step is carried out. If `label` appears in `text` as a standalone phrase, **that phrase becomes the link**; otherwise it trails the sentence. | `"link": { "label": "OAuth consent screen", "url": "https://…" }` |
| `setup.steps[].showRedirectUri` |  | Renders this deployment's redirect URI with a copy button beneath the step. Required on **exactly one** step of a three-legged connector, and rejected on any other strategy — both build-enforced. | `"showRedirectUri": true` |
| `setup.title` |  | Label for the provider-side step. Defaults to "Get your credentials". | `"title": "Create a Google Cloud OAuth app"` |
| `setup.notes` |  | `{ credentials?, authorize?, verify? }` — a provider-specific warning attached to the registry's own step, so it appears at the control it concerns. | `"notes": { "authorize": "Sign in as the shared mailbox, not as yourself." }` |
| `setup.docs` |  | Array of `{ label, url, why }` reference links — scope tables, API docs. Shown below the checklist, not as a step. **`why` is required**: it answers "when would I open this?" behind a "?", which a bare link cannot. | `{ "label": "Gmail API scopes", "url": "https://…", "why": "Open it to confirm gmail.readonly cannot send or delete." }` |
| `authors` |  | Array of `{ name, email }` objects identifying the connector's authors. Shown in the Connector Registry admin page. Optional but recommended so others know who to contact. | `"authors": [{ "name": "Jane Doe", "email": "jane@example.com" }]` |
| `credentialFields` | ✅ | Array of credential fields the admin must provide. Each field appears as an input in the configuration form. |  |
| `credentialFields[].key` | ✅ | Property name used to access this credential in the connector's `initialize()` method. | `"key": "apiKey"` |
| `credentialFields[].label` | ✅ | Label shown in the admin configuration form. | `"label": "API Key"` |
| `credentialFields[].type` | ✅ | Either `text` for visible input or `password` for masked input. Use `password` for API keys, tokens, and secrets. | `"type": "password"` |
| `auth` |  | How the platform authenticates. See below. Absent means `{ "strategy": "none" }`. | |
| `http` |  | Transport policy: base URL, timeouts, retry budget, pagination. Every value has a working default. | |
| `webhook` |  | Inbound webhook verification. See [Webhooks](webhooks.md). | |
| `telemetry` |  | Methods to auto-instrument. See [Telemetry](telemetry.md). | |

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

An `icon` is a filename inside the connector's own `assets/` directory. The
generator proves it exists, proves it is square and at least 512x512, then
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
  "credentialKeys": ["apiKey"] // must exist in credentialFields; also derives `configured`
},
"http": {
  "baseUrl": "https://api.example.com",  // a `baseUrl` credential overrides this at runtime
  "timeoutMs": 10000,                    // per attempt
  "deadlineMs": 15000,                   // whole call including retries
  "maxAttempts": 3,                      // TOTAL tries, not retries
  "retryOn": ["rate_limited", "upstream_error"],
  "rateLimitOn403": true,                // this API throttles with 403
  "defaultHeaders": { "X-Client": "mos" },
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
style requires its own parameters; and every credential key referenced by `auth`
or `webhook` must exist in `credentialFields`.

> **Tool-written:** `lastUpdated` lives in `connector.json` as an ISO 8601 date-time (e.g. `"2026-08-24T03:21:40.694Z"`) and is stamped automatically: `.githooks/pre-commit` runs [`scripts/stamp-updated.ts`](../../scripts/stamp-updated.ts), which rewrites the date on every connector with a file in the commit and re-stages the manifest. It records when the connector last changed, so a dependency bump or a formatting pass inside it moves the date too. A commit that touches only `lastUpdated` never re-stamps. Don't edit it by hand; an invalid value fails the build. A connector with no date yet shows **"Not yet committed"**.

## How Connectors Work

Connectors follow a simple lifecycle:

1. The connector is **registered** automatically when the platform scans the `/connectors` directory and finds a valid `connector.json`.
2. An admin **configures credentials** in the Connector Registry admin page. Credentials are encrypted at rest using AES-256-GCM.
3. When an app declares a connector dependency in its `app.json`, the platform **initializes** the connector with decrypted credentials and injects it into the app context.
4. App API routes access the connector via `context.connectors.myService` and call its methods.

## Security Model

Connectors run exclusively on the server side behind the secure API gateway. App client code (pages and widgets) cannot import connector modules directly — they must call their app's API routes, which receive initialized connectors via the app context. This ensures credentials are never exposed to the browser.

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
  user-scoped connector the caller has not connected. An app checks for presence
  exactly as it already must for one an admin has not configured.
- **Cache keys must include the user.** The platform cannot enforce this,
  because an app chooses its own cache keys — see
  [Credentials](credentials.md#caching-a-user-scoped-response). A shared key
  over a per-user response serves one person's data to another.

People manage their own grants at `/account/connections`.

