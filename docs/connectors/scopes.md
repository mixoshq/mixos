# Scopes: reading permissions from the provider

`https://api.example.com/auth/records.readonly` tells a non-technical admin
nothing. *"View your records and settings"* tells them everything — and the
provider already wrote that sentence, because it is what their own consent
screen shows. This is how the registry gets it.

---

## What each source can and cannot answer

Three things look like they answer "what can this connector do". They do not
answer the same question, and merging them is how a permissions screen starts
lying.

| Source | Where from | Answers |
| --- | --- | --- |
| **Documented** | the provider's scope page, scraped | what this API offers at all |
| **Granted** | `oauth_scope`, captured at the token exchange | what this deployment actually holds |
| **Observed** | `telemetry_events` | what has actually been called, and how it went |

**Observed can never answer the first two.** A scope nobody has exercised is not
a scope that was refused, and the case that matters most — a connector that
*can* write and simply has not yet — is exactly the one usage-derived answers
miss. Under-reporting is the single failure a permissions view cannot have.
Usage lives on its own tab, under its own heading, and says so in words.

---

## `auth.scopesUrl`

Point it at the page that **tabulates scopes against descriptions** — not an API
overview, not a quickstart. The parser looks for table rows containing something
shaped like a scope, and takes the longest other cell as the description. A
scope is a URL (`https://…/auth/records.readonly`), a name with structure
(`channels:read`, `Mail.Read`, `read_products`), or a single word the page sets
as code in a row's first cell (GitHub's `repo`).

Read it, and write the result into the manifest:

```
npx tsx scripts/check-scopes.ts <connector>            # report only
npx tsx scripts/check-scopes.ts <connector> --write    # rewrite auth.scopes
```

It prints every parsed scope with its read/write classification, marks the ones
this connector requests, and warns about a requested scope the page never
documents — which is almost always a typo.

This is an **authoring** step, deliberately not a build step, and it is the only
way `auth.scopes` changes. Putting the fetch in the build would make
`npm run build` fail whenever a third party has a bad afternoon; leaving it to
the running product would make a permissions screen depend on someone else's
uptime.

---

## Read, write, or both

Classification comes from the provider's own description, by detecting read
verbs and write verbs **independently** and combining them:

- read: *see, view, read*
- write: *send, compose, create, delete, edit, change, insert, modify, write,
  manage, add*
- *manage* and *full access* imply **both**, even with no read verb present

Both present → **Read+Write**. Only write → **Write**. Otherwise → **Read**.

Two bugs found running this against a real provider's page, both worth knowing
because both were silent:

- Matching whole phrases instead of independent verbs classified a scope
  described as *"Read, compose, send, and permanently delete all your …"* as
  **Write**, when it is plainly Read+Write. Detect each verb independently and
  combine, rather than matching the sentence.
- `\badd\b` matched inside **"add-on"**, so several read-only add-on scopes were
  reported as writes. The pattern is `add(?!-)`.

Both were over-reports. On a permissions screen that is a false alarm nobody can
dismiss — and the opposite error is worse.

**Send `Accept-Language`.** Without it, providers localise: one served its scope
page in Hindi to a request that expressed no preference, and the descriptions
were classified correctly and cached unreadable. Nothing errored.

---

## The catalogue is committed, not cached

A third party's HTML is not a contract. It will break, quietly, the day the
provider reshapes the page. That is an argument for reading it **rarely, on
purpose, and under review** — not for reading it in production.

So the parse lands in `connector.json` as `auth.scopes`:

```jsonc
"scopes": [
  { "scope": "…/records.readonly", "description": "View your records and settings",
    "access": "read",  "requested": true },
  { "scope": "…/records.modify",   "description": "Create, edit and delete your records",
    "access": "write", "requested": "write" },
  { "scope": "…/admin",            "description": "Manage your account",
    "access": "read-write", "requested": false }
]
```

`requested` says when the connector asks for a scope: `true` always, `"write"`
only on an install whose admin has allowed the connector to change data, and
`false` never. A scope only the connector's write methods need is `"write"`, so
a read-only install never holds it: the decision to grant it moves from each
release to each install. The build refuses a `"write"` scope on a connector with
no method declared `mutates`, which would have nothing to use it. See
[Changing data](architecture.md#changing-data).

One array, not two. The catalogue and the request are the same list seen from
two angles, and keeping them in separate places is how they drift apart.

### A scope that includes others

Some providers grant a broad scope in place of the narrower ones it covers, and
then name only the broad one in the grant. Todoist documents `data:read_write`
as including `task:add` and `data:read`; asked for `data:read` and
`data:read_write`, it answers `data:read_write`. Say so on the broad scope's
entry, with `includes`:

```jsonc
{ "scope": "data:read", "access": "read", "requested": true },
{ "scope": "data:read_write", "access": "read-write", "requested": "write",
  "includes": ["task:add", "data:read"] }
```

A grant that names `data:read_write` then holds `data:read` too, and the verdict
below marks it Granted rather than Refused. Inclusion is followed through: what
an included scope includes is held as well. The including scope needs only to
be in the grant, whether or not this connector asked for it.

`includes` is the provider's fact, written as its documentation says it, so it
sits on the entry whatever `requested` says. The build refuses a name that
isn't in `auth.scopes`, one listed twice, and a scope that includes itself.

It changes nothing about what Connect asks for. Each scope is still asked for as
its own `requested` says: a read-only install asks for `data:read`, which it
needs, and dropping it from the request because another scope covers it would be
a security decision taken as a side effect. Like `requested`, `includes` is a
hand edit; the refresh keeps it, and drops a name the refreshed catalogue no
longer has, with a warning.

**`requested` is required and never inferred.** The refresh writes far more
entries than a connector asks for, so a flag defaulting to true would silently
request the provider's entire catalogue. `--write` also *preserves* the existing
flags: refreshing the catalogue must never change what a connector asks for.
Adding a scope to the request is a hand edit, because it is a security decision
(minimum scopes only).

What this buys: the list is identical on every install, it shows up in a diff
where someone can object to a new write scope, and no page load depends on a
third party being up. What it costs: a provider adding a scope needs a developer
to run the refresh and ship the result. That is the trade, taken deliberately.

There is no Refresh button in the registry, because there is nothing an admin
could refresh.

---

## The per-scope verdict

Each documented scope is marked against what this connector actually holds. The
verdict is **recorded in `connector_scope_status` at the OAuth callback**, which
is the only moment it can change — not recomputed on every render, where three
lists arriving from three places is exactly how a permissions screen starts
disagreeing with itself.

The row is keyed by connector, scope, **and grant-holder**: null for the
tenant-wide grant an admin connected, and the user's id for a `userScoped`
connector, where each person holds their own grant and a single per-connector
answer would report one user's refusal as everybody's.

| | Meaning |
| --- | --- |
| ✓ **Granted** | requested by this connector, and in the grant, by name or through a scope that [includes](#a-scope-that-includes-others) it |
| ✗ **Refused** | requested, and **not** in the grant |
| ? **Unknown** | this API documents it; this connector never asks for it |

A provider may leave `scope` out of its token response when it granted exactly
what was requested (RFC 6749 §5.1). That is recorded as a grant of every
requested scope, not as a grant of none.

A scope another one includes carries a pill on the Scopes tab, **Included in**
that scope, so a Granted row the provider's grant doesn't name explains itself.
The verdict is recorded at the callback like any other: one taken before the
connector declared `includes` reads Refused until someone connects again.

**Refused is the one that earns the feature.** It happens when someone unticks a
permission on the consent screen, when a workspace policy narrows the grant, or
— the routine one — when a connector update adds a scope to the manifest and
every already-authorized install keeps running on the older, narrower grant
until somebody reconnects. Nothing else in the product surfaces that; the calls
simply start failing.

**Unknown carries most of the rows, and that is correct.** A scope the provider offers
but this connector never requests is not broken. Rendering those as ✗ would
report a dozen failures on a perfectly healthy connector.

## Which methods a scope decides

A verdict says what the grant holds; it doesn't say which calls that breaks.
Each `telemetry` entry can name the scopes its method needs (`scopes`, see
[Telemetry](telemetry.md)), and the connector dialog's **Methods** tab shows
every method with those scopes and the verdict on each. A method also says, when
it applies:

- **Off while read-only** — it changes data and changes aren't allowed, so the
  platform refuses it before the provider is asked;
- **Works once changes are allowed** — it only reads, but needs a scope this
  connector requests only with `"write"` (Google Sheets' data-filter reads take
  `spreadsheets`, never `spreadsheets.readonly`), so the provider refuses it
  until changes are allowed;
- **Scope refused** — one of its scopes is ✗ above, so it fails until someone
  connects again and approves it.

A method with no `scopes` reads "scopes not declared": the platform doesn't
guess which of the read scopes a read needs.

---

## Referenced by

[`connectors/AGENTS.md`](../../connectors/AGENTS.md) ·
[`/mixos connector`](../../.claude/skills/mixos/actions/connector.md) ·
[Registry UX](registry-ux.md) · [Credentials](credentials.md)
