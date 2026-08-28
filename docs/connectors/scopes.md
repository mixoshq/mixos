# Scopes: reading permissions from the provider

`https://www.googleapis.com/auth/gmail.readonly` tells a non-technical admin
nothing. *"View your email messages and settings"* tells them everything — and
the provider already wrote that sentence, because it is what their own consent
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
shaped like a scope, and takes the longest other cell as the description.

Verify it while you are still holding the manifest:

```
npx tsx scripts/check-scopes.ts gmail
```

It prints every parsed scope with its read/write classification, marks the ones
this connector requests, and warns about a requested scope the page never
documents — which is almost always a typo in `auth.scopes`.

This is an **authoring** step, deliberately not a build step. The registry reads
that page at an admin's request and caches the result, so a wrong URL is not a
broken build; it is an empty list nobody notices for a week. Putting the fetch in
the build would make `npm run build` fail whenever a third party has a bad
afternoon.

---

## Read, write, or both

Classification comes from the provider's own description, by detecting read
verbs and write verbs **independently** and combining them:

- read: *see, view, read*
- write: *send, compose, create, delete, edit, change, insert, modify, write,
  manage, add*
- *manage* and *full access* imply **both**, even with no read verb present

Both present → **Read+Write**. Only write → **Write**. Otherwise → **Read**.

Two bugs found doing this to Gmail's real page, both worth knowing because both
were silent:

- Matching whole phrases instead of independent verbs classified
  `mail.google.com` ("Read, compose, send, and permanently delete all your
  email") and `gmail.modify` as **Write**, when both are plainly Read+Write.
- `\badd\b` matched inside **"add-on"**, so three read-only add-on scopes were
  reported as writes. The pattern is `add(?!-)`.

Both were over-reports. On a permissions screen that is a false alarm nobody can
dismiss — and the opposite error is worse.

**Send `Accept-Language`.** Without it, providers localise: Google served this
exact page in Hindi to a request that expressed no preference, and the
descriptions were classified correctly and cached unreadable. Nothing errored.

---

## Cache, not source of truth

A third party's HTML is not a contract. This will break, quietly, the day the
provider reshapes the page. So:

- The parse is **cached** in `connector_scope_docs` and re-read only when an
  admin presses Refresh. No page load depends on a third party being up.
- A failed refresh records **why** and **when it was attempted**, and leaves the
  previous `scopes` and `fetched_at` untouched. Stale-but-accurate beats blank:
  a permissions list that empties itself because a docs page moved is a worse
  outcome than one showing last month's read with a note saying so.

Store the parsed array with `sql.json(...)`. `${JSON.stringify(x)}::jsonb` looks
right and is not — postgres.js infers the parameter type from the target column,
sees `jsonb`, and JSON-encodes the string you already stringified, so the column
holds a JSON *string* rather than an array. It reads back as "no scopes found":
a refresh that reports success and displays nothing.

---

## The per-scope verdict

Each documented scope is marked against what this connector actually holds:

| | Meaning |
| --- | --- |
| ✓ **Granted** | requested by this connector, and in the grant |
| ✗ **Refused** | requested, and **not** in the grant |
| ? **Unknown** | this API documents it; this connector never asks for it |

**Refused is the one that earns the feature.** It happens when someone unticks a
permission on the consent screen, when a workspace policy narrows the grant, or
— the routine one — when a connector update adds a scope to the manifest and
every already-authorized install keeps running on the older, narrower grant
until somebody reconnects. Nothing else in the product surfaces that; the calls
simply start failing.

**Unknown carries most of the rows, and that is correct.** A scope Gmail offers
but this connector never requests is not broken. Rendering those as ✗ would
report a dozen failures on a perfectly healthy connector.

---

## Referenced by

[`connectors/AGENTS.md`](../../connectors/AGENTS.md) ·
[`/mix-connector`](../../.claude/commands/mix-connector.md) ·
[Registry UX](registry-ux.md) · [Credentials](credentials.md)
