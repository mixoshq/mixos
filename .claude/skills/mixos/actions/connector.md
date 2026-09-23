# /mixos connector

You are creating or modifying a connector under `connectors/`.

## Write a plan first (before any code)

For anything beyond a trivial one-line tweak, **write a build plan to `connectors/<slug>/plans/YYYYMMDD_HHMM-<plan-name>.md`** before editing code — the plan lives **inside the connector it describes**, so it travels with the code. Cover: **Context** (why this change), **Decisions** (anything locked with the user), **Structure** (the file-level changes — `connector.json`, `index.ts`), and **Verification** (how you'll prove it works). Get it reviewed when the change is non-trivial.

- **Creating a new connector?** Make `connectors/<slug>/plans/` as the first thing you write, before `connector.json`.
- **Read the existing plans in that folder first** when modifying a connector — especially the auth strategy and failure-mapping decisions, which are the expensive ones to get wrong twice.
- **Changing the connector base layer** (`src/lib/connectors/`, the retry/backoff/auth machinery shared by every connector) is a *platform* plan and goes to `docs/plans/` instead.

See [`docs/plans/README.md`](docs/plans/README.md) for the full convention.

## Required reading (do this first, in order)

1. [connectors/AGENTS.md](connectors/AGENTS.md) — hard invariants and the guide index.
2. The four guides it links, in order:
   - [docs/connectors/architecture.md](docs/connectors/architecture.md)
   - [docs/connectors/implementation.md](docs/connectors/implementation.md)
   - [docs/connectors/usage-in-apps.md](docs/connectors/usage-in-apps.md)
   - [docs/connectors/credentials.md](docs/connectors/credentials.md)
   - [docs/connectors/telemetry.md](docs/connectors/telemetry.md) — declaring which connector methods to auto-instrument
   - [docs/connectors/registry-ux.md](docs/connectors/registry-ux.md) — **the admin experience the manifest builds.** Read this before writing `setup`
   - [docs/connectors/scopes.md](docs/connectors/scopes.md) — reading a provider's permissions in its own words
3. Authoritative types: [src/lib/connectors/types.ts](src/lib/connectors/types.ts).
4. For reference shape, read the Gmail connector at [italianst4/mixos-connector-gmail](https://github.com/italianst4/mixos-connector-gmail) — the worked example for all of it: a scraped scope page, a three-step provider guide with inline links and emboldened values, and a redirect URI placed on the step that registers it.
5. If updating an existing connector, read its current files before proposing edits.

Do not infer conventions from surrounding code alone, and do not guess based on training data.

## Build the configuration experience, not just the client

A connector is not finished when it can call an API. It is finished when an
admin who has never heard of the service can configure it without leaving the
dialog.

**Two surfaces are yours. The rest is not.** The registry renders the same
three-tab dialog for every connector — Details, Configure, Usage Logs — and you
do not design, choose or reorder them. **Details and Usage Logs need no
authoring at all**: dependency counts come from other apps' manifests,
permissions from the manifest's own scope catalogue, status from the credential row, and the log from
telemetry you already declare. What you write is:

1. **`setup`** — the Configure wizard's provider-side steps.
2. **`auth.scopesUrl`** — the page the permissions list is read from.

Wanting to reshape Details or Usage Logs for one connector is a platform change
and a `docs/plans/` plan, never a manifest workaround.

These fields are required and the build rejects a connector without them:

| Field | What it drives |
| --- | --- |
| `icon` | The registry tile. Written as a full path — `"assets/icon.svg"`. Square, ≥512x512 for raster; a `viewBox` for SVG |
| `setup.title` | The provider-side step's name — "Create a Google Cloud OAuth app" |
| `setup.steps[]` | What the admin does in the provider's console |
| `auth.scopesUrl` | The page the permissions list is read from |

Three-legged OAuth also requires `showRedirectUri` on **exactly one** step.

### Scopes refresh

`auth.scopes` is the provider's whole documented catalogue, each entry flagged
with whether this connector asks for it:

```jsonc
"scopes": [
  { "scope": "…/records.readonly", "description": "View your records and settings",
    "access": "read",  "requested": true },
  { "scope": "…/records.modify",   "description": "Create, edit and delete your records",
    "access": "write", "requested": false }
]
```

**The refresh is the only thing that writes it.** When a user asks for a scopes
refresh, or when you add `auth.scopesUrl` to a new connector:

```
npx tsx scripts/check-scopes.ts <name>            # report only — read this first
npx tsx scripts/check-scopes.ts <name> --write    # rewrite auth.scopes in place
npx tsx scripts/generate-project-registry.ts      # pick the change up
```

Then **show the user the diff**. That diff is the whole point of keeping the
catalogue in the manifest: a provider quietly adding a write scope is something
a human should see, and there is no admin-facing Refresh button that could
introduce it behind everyone's back.

Two rules the refresh follows, and you must not work around:

- **It preserves `requested`.** Refreshing the catalogue never changes what the
  connector asks for. Adding a scope to the request is a **hand edit**, and it
  is a security decision — invariant 17, minimum scopes only. Say so in the PR.
- **It keeps a requested scope the page no longer documents** rather than
  dropping it. Silently un-requesting a scope the connector needs would break
  authorization at the next reconnect; a provider reorganising their docs is not
  consent to change what we ask for. The script warns instead.

Read the output. "14 scopes parsed" is not the test — whether the descriptions
are English sentences and the read/write split looks right is the test.

### Getting the icon

Find the provider's logo — their brand or press page, their own docs, or a
favicon at a usable size — then:

```
npx tsx scripts/prepare-icon.ts <connector-name> <url-or-file>
```

It keys out a flat background, trims the margin and re-pads to 512x512, so one
connector's mark is not twice the size of its neighbour's in the same grid.
**Then look at it.** Keying is a heuristic, and it reports when it declines to
key a photographic or gradient backdrop — that is a signal to find a better
source, not to ship it.

### Writing the steps

Read [registry-ux.md](docs/connectors/registry-ux.md) first. In short:

- `text` is the instruction **and nothing else** — one imperative sentence.
- `values` are literal values the admin picks (`Internal`, `Web application`);
  they are emboldened in place, and the build rejects one that is not in `text`.
- `why` is the justification, behind a `?`. **Never an instruction.**
- `link` is linked **in place** where `link.label` appears in `text` — so write
  the sentence so it names the destination: "On the **OAuth consent screen**, set
  User type to **Internal**."
- `setup.notes.{credentials,authorize,verify}` attaches a provider-specific
  warning to a platform step, so it appears beside the control it is about.
- **Do not** write an OAuth explainer, restate the redirect URI, or list the
  scopes. The registry renders all three itself.

## Non-negotiable invariants (from connectors/AGENTS.md)

- Folder name === `name` in `connector.json` (lowercase, hyphens). No leading underscore on shipped connectors.
- Connectors are server-side only. Never import one from client code.
- Credentials flow through `initialize(credentials)` only — no env vars, no hardcoded secrets, no fallbacks. `credentialFields[].key` must match what `initialize()` reads.
- Stateless: no caching across requests.
- `configured` must be `true` only when every required credential is present.
- Never set `lastUpdated` in `connector.json`; never hand-edit `src/generated/connector-registry.ts`.
- **Every public method on the class must be declared in `telemetry`**, with `mutates: true` on anything that changes state upstream. The build rejects an undeclared one: the registry reports what a connector can do from that list, so a method missing from it is one an admin is never told about.

## Verify before reporting done

1. `npx tsx scripts/generate-project-registry.ts` — confirm the connector appears in the regenerated registry.
2. `npm run typecheck`.
3. `npm run verify:connectors`.
4. `npx tsx scripts/check-scopes.ts <name>` — proves `auth.scopesUrl` parses. **Read the output.** "14 scopes parsed" is not the test; whether the descriptions are English sentences and the read/write split is right is the test. A requested scope the page never documents is flagged — that is usually a typo in `auth.scopes`.
5. Dev server → Administration → Connector Registry. Confirm it renders, save real credentials, and exercise it from a test app API route. Do not claim "done" without actually calling it.
6. **Walk the wizard as an admin would**, from an unconfigured state. Each step's instructions should be followable without leaving the dialog, and each tick should appear only after the platform actually verified something.

## User request

The arguments the dispatcher passed — everything after `connector` in the invocation.
