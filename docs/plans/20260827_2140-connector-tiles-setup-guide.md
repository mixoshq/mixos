# Connector Registry: tiles, a setup guide, and connector icons

## Context

`/admin/connectors` renders the connector registry as a vertical list of
accordion rows. Expanding a row reveals everything at once — the credential
form, Test Connection, the OAuth authorization block and the redirect URI —
stacked in a strip that pushes every other connector down the page.

Three problems the redesign fixes:

1. **Status is a claim, not a fact.** The page derives `configured` from
   [`isConnectorConfigured()`](../../src/lib/connectors/config.ts), which asks
   only whether a `connector_configs` row exists. `HttpConnector.configured`
   asks a much harder question — for a three-legged connector, client
   credentials *and* an actual grant. So a connector whose admin saved a client
   ID and never pressed Connect renders **Configured** on the admin page while
   the runtime correctly reports `false` and refuses every call. That is
   invariant 12 failing in the one place a human looks.

2. **Setup instructions have nowhere to live.** Invariant 13 says to keep them
   in `description`, and Gmail's manifest does exactly that: a single
   ~1,400-character paragraph carrying five numbered steps, a scope list and two
   warnings. It renders as the row subtitle. Nothing in it is clickable, and an
   admin who has never provisioned a Google OAuth client cannot follow it
   without leaving the page to search for each console.

3. **Connectors have no visual identity.** Every row shows the same `Plug`
   glyph, so the registry is a wall of identical text.

## Decisions

Locked with the user before implementation:

| Decision | Choice | Rejected |
| --- | --- | --- |
| Layout | 3-column tile grid | keep the list |
| Status states | three — ready / needs authorization / not configured | two (green/gray) hides the OAuth half-state |
| Tile contents | icon, name, description, status, Configure | adding Test to the tile; a metadata footer |
| Search + filter tabs | keep both, unchanged | drop them while the registry is small |
| Setup guidance | new `setup` block in `connector.json` | a generic explainer; rendering `description` as-is |
| Connector text | `description` — about the service, ≤140 chars, first 15 words on the tile and all of it in the dialog — plus `setup` for how to connect | a 30-char blurb; a separate `tagline` field for the tile |
| Icon source | `connectors/<name>/assets/`, copied to `public/connector-assets/<name>/` | a remote URL; a lucide name |
| Icon validation | PNG/WebP/SVG; build fails on non-square or `< 512×512` | existence check only |
| Missing icon | falls back to the lucide `Plug` glyph | a monogram; making the icon required |
| Gmail's icon | the user adds `connectors/gmail/assets/icon.png` | committing Google's mark on their behalf |

**Why three states.** For `oauth2_authorization_code`, saved client credentials
and a completed authorization are different facts, and only the second one means
an app can call the connector. Amber is the state the two-colour scheme would
have to round to green — the exact lie problem 1 describes.

**Why the tile cuts by word, not by character.** The tile shows the first 15
words of `description` and the dialog shows all of it. An earlier pass cut it to
16 *characters*, which lands inside a word — `"Highly popular e…"` — and reads
as a rendering fault rather than as "there is more". A word boundary reads as
deliberate. `description` is capped at 140, build-enforced: this is the field
that grew to 1,400 characters of numbered steps for want of anywhere else to put
them, and a cap is what stops that migrating back now that `setup` exists.

**Why a `setup` block rather than more prose in `description`.** Links are the
requirement, and a link cannot be expressed in a paragraph the UI renders as
plain text. Structured steps also let the modal interleave *platform*-owned
facts the manifest cannot know — chiefly the redirect URI, which is built from
this deployment's origin at runtime — into the middle of a provider's own
instructions, which is precisely where an admin needs it.

## Structure

### Platform — status derivation

- **`src/lib/connectors/status.ts`** (new). One exported pure function,
  `connectorConfigState(auth, credentials) → "ready" | "needs-authorization" |
  "unconfigured"`, holding the rule that was previously written out inside the
  `HttpConnector.configured` getter.
- **`src/lib/connectors/http-connector.ts`**. `configured` becomes
  `connectorConfigState(...) === "ready"`. Behaviour is unchanged by
  construction; the point is that the admin page and the runtime can no longer
  drift, which is what let problem 1 exist.
- **`src/app/(main)/admin/connectors/page.tsx`**. Derives each tile's state from
  the same function over the decrypted credential blob, instead of from
  `isConnectorConfigured()`. `getDecryptedConfig()` was already being read here
  for OAuth connectors; this widens it to all of them. **Only the derived state,
  the expiry timestamp and booleans cross to the client — never a credential
  value**, which is the existing rule in this file and stays enforced.

### Platform — the manifest gains `icon` and `setup`

- **`scripts/manifest-schemas.ts`**. `RawConnectorManifestSchema` is a
  `z.strictObject`, so both fields must be declared or a manifest carrying them
  aborts the build.
  - `icon` — a relative path inside the connector's `assets/` directory. Rejects
    absolute paths, `..` traversal and URLs at schema level.
  - `setup` — `{ summary, steps[], docs[] }`. Every `url` must be `https:`;
    `http:`, `javascript:` and `data:` are rejected by the schema rather than
    sanitized at render time, so a bad link fails the build instead of reaching
    an admin's browser.
- **`scripts/generate-project-registry.ts`**.
  - `validateConnectorIcon()` — resolves the path under `assets/`, confirms the
    file exists, and reads its dimensions **from the file header directly** (PNG
    IHDR; WebP VP8/VP8L/VP8X) rather than adding an image dependency. Non-square
    or under 512×512 aborts the build with the measured size in the message. SVG
    is exempt from the pixel check but must declare a `viewBox`.
  - Copies `connectors/<name>/assets/` → `public/connector-assets/<name>/`, mirroring
    what themes already do at line 1062.
  - Passes `icon` (rewritten to its public URL) and `setup` into the emitted
    registry entry.
- **`src/lib/connectors/types.ts`**. `ConnectorSetupGuide`,
  `ConnectorSetupStep`, `ConnectorDocLink`; `icon?` and `setup?` on
  `ConnectorManifest`.
- **`.gitignore`**. `/public/connector-assets/` joins `/public/themes/` — generated
  output, with `connectors/<name>/assets/` as the committed source.

### The dialog is three tabs

**Details** answers "what is this and is it working". Before anything is
configured it is a single inert skeleton with **Configure &lt;name&gt;
connection** overlaid — and the skeleton deliberately does not pulse, because a
pulsing skeleton says *content is on its way, wait*, and here nothing is coming
until the admin presses the button. `ui/skeleton.tsx` gained `pulse={false}` for
that distinction rather than this file hand-rolling grey bars. Once configured
it shows status, **Configured &lt;when&gt; by &lt;who&gt;**, last verified, and
the granted scopes.

That attribution pairs `updated_at` with `configured_by`, not `configured_at`
with `configured_by`. `configured_by` is overwritten on every save while
`configured_at` is set once, so the natural-looking pairing renders "Configured
12 Jan by Bob" when Alice set it up in January and Bob changed a secret in
March. Both halves now describe the same event. Read with a `LEFT JOIN` onto
`users` — one round trip, and the row survives a `configured_by` pointing at a
deleted account.

**Configure** holds the wizard. **References** holds the reference links, each
with its one-sentence purpose *on screen* rather than behind a "?" — a list of
bare labels is a list of things whose relevance you learn one hover at a time.
The tab is not rendered at all for a connector with no references, per the
design system's "filter, don't disable" rule. Step-level "?" tooltips are
untouched: those are rationale for an instruction you are part-way through.

The tab band lives in the dialog chrome rather than the scrolling body, so it
stays put while its panel scrolls, and it shares one muted ground with the
header — no rule between them, one rule beneath the pair, running the full width
of the panel.

### The Access tab: three sources, deliberately not merged

An admin opening this asks a risk question — *what could this reach, and can it
change anything?* Three things can answer it, and conflating them is the trap:

| Source | Where from | Answers |
| --- | --- | --- |
| **Granted** | `oauth_scope`, captured at the token exchange | what the provider actually gave |
| **Declared** | `telemetry[].mutates` | what the connector's methods do, read vs write |
| **Observed** | `telemetry_events` outcomes | what has actually run, and how it went |

**Granted was already being stored and thrown away.** `tokensToCredentials`
persists the provider's returned `scope`, and nothing had ever shown it. It can
be narrower than what was requested — a consent screen where someone unticked a
box — and that mismatch is the single most actionable fact on the tab, because
every call relying on the missing scope will fail with no other warning. It is
now surfaced with the diff called out.

**Observed is evidence, not capability, and the UI says so in those words.**
Usage cannot answer the risk question: a method that has never run is not a
method that cannot run, and the case that matters most — a connector that *can*
write and simply has not yet — is exactly the one usage-derived answers miss.
Under-reporting capability is the failure mode a permissions view cannot have.

To make "how did it go" real, `instrumentConnector` now records on **settlement**
rather than on call. The tradeoff is deliberate: a call that never settles now
records nothing, where before it recorded an attempt. The failure category comes
off `ConnectorError` rather than off an HTTP status, which is what keeps
"denied" separate from "throttled" — a 403 means either, depending on the
provider, which is why `rateLimitOn403` exists in the first place.
`telemetry_events` gains nullable `outcome` and `error_category`, so a row with
no outcome stays a third state rather than reading as success.

**Completeness is build-enforced.** `telemetry` was designed as opt-in
instrumentation, which made the capability list unsound the moment it was
presented as exhaustive: a connector could ship an undeclared `sendMessage()`
and the tab would report that nothing changes anything upstream.
`validateConnectorMethods()` now parses each connector's `index.ts` and rejects
any public method missing from `telemetry`, so the list cannot be quietly
incomplete. Parsed from the TypeScript AST rather than by regex — a regex cannot
distinguish a method on the connector class from one on a helper class in the
same file, nor see the `private` that makes it not count. `initialize`,
`testConnection` and `handleWebhook` are exempt: the platform calls those, an
app never can, so they are contract rather than capability.

Over-reporting a capability is a nuisance; under-reporting one is a false
assurance, and this is the screen an admin opens to find out what a connector
could do to their data.

### The Configure tab is a validated checklist, not a form

The dialog shows the connector's icon and name in its header, the full
`description` below it, the status, then a **one-step-at-a-time wizard** whose
steps are ticked by **checking**, never by asking.

Only the current step's content renders. That is the point — an admin pasting a
client secret does not need three other steps in view — but hiding the rest
costs the two things a list gave for free: *where am I* and *how much is left*.
A progress rail across the top gives both back in one line, and is where the
green ticks live, so progress stays visible while content does not. Its circles
are buttons: once a step is no longer rendered, that is the only way back to
re-copy a redirect URI or replace a leaked secret.

The primary control sits bottom-right of every step — "Save credentials",
"Connect", "Verify" — so it is in the same corner each time. Step one is the
exception that proves the rule: it has nothing to validate, so it is the only
step carrying a plain **Next**. Every other step advances by *succeeding*, which
is why they need no Next of their own — a successful save clears the pinned step
and the next render lands on whatever is now unfinished.

What can actually be checked draws the line:

| Step | Ticked by |
| --- | --- |
| Create the app in the provider's console | *inferred* — credentials exist, so the app does |
| Save credentials | the declared `credentialKeys` are all present |
| Authorize | a refresh or access token is stored |
| Verify | `connector_configs.last_verified_at` is set |

The first cannot be observed from here — nothing in this codebase can tell
whether the Gmail API got enabled. Inferring it from the credentials arriving
beats a checkbox the admin ticks themselves, which records only that they
clicked it. `last_verified_at` and `last_verified_detail` are new columns, folded
into the squashed baseline per its own header; only a *success* writes them, so
a failed test leaves "it worked on Tuesday" standing rather than blanking it.

Once every step is done the checklist collapses to one "Setup complete" line and
the dialog leads with the three things an admin actually reopens it for —
update credentials, reconnect, verify again — each jumping to the step that owns
it rather than duplicating its controls.

**The manifest now carries provider-side work only.** `setup.steps` had grown to
six entries, three of which ("paste the credentials below", "press Connect",
"press Test Connection") described buttons the registry renders itself and knows
the state of. Those are gone; what is left is what happens in someone else's
console. Two new fields carry the rest: `setup.title` labels that step ("Create
a Google Cloud OAuth app"), and `setup.notes.{credentials,authorize,verify}`
attaches a provider-specific warning to the platform step it concerns — so
Gmail's "sign in as the shared mailbox, not as yourself" appears beside the
Connect button, not in a summary paragraph read four minutes earlier.

**Three violations the design-system lint caught in this work**, all real: a step
badge and the footer at `text-muted-foreground` on `bg-muted` (4.34:1, under the
floor), and a disabled Connect control dimmed with a bare `opacity-50` (2.59:1).
The last is why the Connect control is an anchor when it works and a real
disabled `<button>` when it does not — dimming a token is legal for a genuinely
disabled control and nowhere else.

### Platform — two bugs the redesign exposed

Neither was the point of this work; both were found by building it, and both
made the new UI wrong until fixed.

**`saveConnectorConfig()` destroyed credentials it wasn't given.** It wrote the
blob it was handed, whole, and the admin form only submits fields the admin
actually filled in. So re-saving a *connected* three-legged connector — to
correct a mistyped client secret — wrote `{clientId, clientSecret}` over a row
that also held `oauth_access_token` and `oauth_refresh_token`, disconnecting it
with no warning. Leaving a password field blank erased that secret for the same
reason. It now merges through `mutateConnectorCredentials()`, under the advisory
lock that every other credential write already uses, which is also what makes
the form's "leave blank to keep the current value" hint true. `configured_by`
moves into that helper as an option so an interactive save still records the
admin behind it. The deliberate tradeoff: a credential can be replaced through
this path but not cleared, and nothing in the UI offers clearing.

**Connector assets cannot live at `/connectors/`.** That prefix is already a
signed-in page route (`/connectors/guide`, which has no `requireSession()` of
its own and depends on the proxy redirect). An icon served from under it 307s to
`/login` for anyone without a session — and, worse, for `next/image`'s optimizer,
which fetches the source URL server-side with no cookies and therefore fails on
every icon even for a signed-in admin. Assets go to `public/connector-assets/`
instead, exempted in `src/proxy.ts` exactly as `themes/` already is and for the
same stated reason. Exempting `/connectors/` would have taken the guard off a
real page.

### Platform — the UI

- **`src/components/admin/connector-tile.tsx`** (new). Icon or `Plug` fallback,
  display name, truncated description, a `StatusPill`, a Configure button.
  Tinted `bg-success/10` + `border-success/40` when ready, `bg-warning/10` when
  authorization is pending, plain `bg-card` otherwise. Status is never
  colour-only: the pill carries the words, per `ui/status.tsx`.
- **`src/components/admin/connector-configure-dialog.tsx`** (new). Wraps the
  existing focus-trapped [`Dialog`](../../src/components/ui/dialog.tsx) rather
  than hand-rolling one. Holds, in order: the OAuth explainer and numbered setup
  steps with links; the redirect URI with a copy button; the credential form;
  the authorization block; Test Connection; authors and last-updated.
- **`src/components/admin/connector-registry-list.tsx`**. Search box and the
  All/Configured/Unconfigured tabs are kept as-is; the divided list below them
  becomes `grid gap-4 sm:grid-cols-2 lg:grid-cols-3`. Owns which tile's dialog
  is open.
- **`src/components/admin/connector-registry-row.tsx`** is deleted — the tile
  and the dialog replace it.
- Returning from an OAuth round trip carries `?connector=<name>` alongside the
  existing `?oauth=<status>`, so the dialog the admin was working in reopens
  instead of dumping them back at a closed grid.

### Connector + templates

- **`connectors/gmail/connector.json`**. `description` becomes a sentence about
  Gmail itself ("Highly popular email service by Google…"). Everything the old
  description carried about *this connector* —
  one shared mailbox, read-only, cannot read a user's own inbox — moves to
  `setup.summary`, and the five setup steps and console links become `setup.steps`
  with links. `"icon": "icon.png"` is declared, with the user's supplied artwork.
- **`connectors/_template/`** and **`connectors/_template-oauth/`** gain a
  `setup` block and an `assets/` directory, so a scaffolded connector inherits
  the convention rather than discovering it in review.

### Docs

- **`docs/connectors/architecture.md`** — `icon` and `setup` in the field
  reference, with the icon rules and the `assets/` layout.
- **`connectors/AGENTS.md`** — invariant 13 currently says setup instructions
  belong in `description`. It now points at `setup`, and gains the icon rules.

## Verification

Per `connectors/AGENTS.md`:

1. `npx tsx scripts/generate-project-registry.ts` — gmail appears carrying
   `setup`; assets copy to `public/connector-assets/`. Additionally proved by
   deliberately breaking a manifest: a non-square icon, an icon under 512×512,
   an `http:` link and a missing icon file must each abort the build with a
   message naming the offending path.
2. `npm run typecheck`.
3. `npm run lint` — the palette fence rejects raw palette colours and `dark:`
   variants across `src/`, which the new tinted tile states must clear.
4. `npm run verify:connectors` — `configured` is load-bearing in the connector
   abstraction; this proves moving it into `status.ts` changed no behaviour.
5. `npx next build` — the page and both new client components compile.
6. Against the running dev stack, unauthenticated: `/connector-assets/gmail/icon.png`
   returns 200, `/_next/image?url=%2Fconnector-assets%2Fgmail%2Ficon.png` returns
   200 (the path that was broken), and `/connectors/guide` still 307s to `/login`.
7. Dev server as an admin: grid renders three-up, Gmail reads **Needs
   authorization** with client credentials saved and no grant, the dialog's
   steps and links render, Test Connection still reports, and the dialog reopens
   after the OAuth round trip.

### Proved

1–6 pass, including each icon guard firing on a deliberately broken manifest
(non-square, under 512, missing file, `http:` link, `..` traversal) and 119/119
in `verify:connectors`. **7 is not done** — it needs an admin session on the
running deployment.
