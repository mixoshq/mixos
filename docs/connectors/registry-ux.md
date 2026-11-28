# The Connector Registry experience

Every connector gets the same admin experience, and it is not assembled by hand
per connector. The registry builds it from the manifest — so what a connector
declares *is* its configuration UI. This document is the contract: what the
platform renders, what the manifest must supply, and why each piece is shaped
the way it is.

The one-line summary: **an admin should be able to configure a connector they
have never heard of, without leaving the dialog to work out what to do next.**

And the one-line summary of an author's job: **write the steps for the
provider's own console, and point at the provider's scope page.** The rest of
the dialog builds itself.

---

## The registry contract

A connector cannot ship without these. The generator rejects the build and names
everything missing at once, because learning about four gaps in four
consecutive builds is how an author gives up.

| Field | Why the platform cannot invent it |
| --- | --- |
| `icon` | Otherwise the grid is a wall of identical plug glyphs |
| `setup.title` | Names the provider-side step: "Create a Google Cloud OAuth app" |
| `setup.steps[]` | What the admin does in someone else's console |
| `auth.scopesUrl` | The page the Scopes tab's permission list is read from — see [Scopes](scopes.md). Not needed by a connector that authenticates with nothing (`auth.strategy` `none`): a public API has no permissions to list |

An `oauth2_authorization_code` connector additionally must set
`showRedirectUri` on **exactly one** step. It is the only value in the whole
guide the manifest cannot contain — it is built from the running deployment's
origin — and a connector that never shows it strands the admin: the URI cannot
be guessed and the provider rejects the flow without it.

---

## What is fixed, and what you actually write

Read this before anything else, because it is smaller than it looks.

**The dialog is identical for every connector.** Five tabs, in this order,
always. An author does not design them, choose them, reorder them or add to
them — the platform renders the same shell for Gmail and for a connector written
next year.

| Tab | Built from | You write |
| --- | --- | --- |
| **Details** | the credential row (configured, last verified), the admin switch, Allow changes, other apps' manifests and switches, the last 30 days of `telemetry_events` | *nothing structural* |
| **Configure** | the platform's save / authorize / verify steps, plus your provider-side steps | **`setup`** |
| **Methods** | `telemetry`: each method, its operation and description, whether it changes data, and the scopes it needs with the grant's verdict on each | **`telemetry[].scopes`** |
| **Scopes** | `auth.scopes`, checked against the grant, citing `auth.scopesUrl` | **`auth.scopesUrl`** |
| **Usage Logs** | `telemetry_events` — the last 100 recorded calls | *nothing* |

So there are exactly **three authored surfaces**:

1. **`setup`** — the provider-side steps of the Configure wizard: what an admin
   does in someone else's console before they have anything to paste in.
2. **`auth.scopesUrl`** — which page the permissions list is read from.
3. **`telemetry[].scopes`** — which of the scopes you request each method needs,
   read from the provider's reference for that operation. Where it says "one
   of" several, name the one you request. The build holds each to `auth.scopes`,
   and warns about a read that needs a scope requested only with `"write"`,
   which fails on an install that is read-only. A method without it reads
   "scopes not declared" on the Methods tab.

Plus `icon` and `description`, which are content rather than design.

Everything else on all five tabs is derived from data the platform already
holds. **Usage Logs takes no authoring at all** — declare your methods in
`telemetry` (which invariant 16 requires anyway) and the log populates itself.
**Details takes none either**: its Reach section comes from other apps'
manifests, their switches and the recorded calls, status from the credential
row. **Scopes** lists `auth.scopes`,
which `scripts/check-scopes.ts` writes from your `auth.scopesUrl`. Where the
provider grants one scope as part of another, add `includes` to the broader
entry by hand (see [Scopes](scopes.md#a-scope-that-includes-others)), or a
grant that names only the broader one reports the narrower one refused.

If you find yourself wanting to change the shape of Details or Usage Logs for
one connector, that is a platform change and a `docs/plans/` plan — not
something to work around in a manifest.

### The shell you get

The status pill lives in the **tab band**, not in a panel: status belongs to the
connection rather than to any one view of it, so it stays put while the tabs
change beneath it. The header carries the icon, the display name and the
`description`; the footer carries provenance — last updated, and the author.

Tabs are **never filtered or disabled**: all five render for every connector,
and one with nothing to show says why in words — a public API's Scopes tab, a
log no app has written to yet. A disabled tab poses a question ("why can't I
click that?") the tab bar has no room to answer.

### The Reach section

The Details tab's **Reach** section answers two questions an admin asks before
changing a connector, and one they ask during an incident: which apps does
this affect, and what could each one do with it? For every app that declares
the connector, required or optional:

- whether it runs. An inactive app runs none of its code, so it calls nothing,
  and it is listed last with an **Inactive** pill, since activating it hands
  it what its row lists;
- what MixOS lets it call: every declared read, and every declared write only
  when its entry asks for `"access": "write"` *and* an admin has allowed
  changes. Its row carries a **Changes data** pill then, and **Read-only
  here** when it asks and the connector is read-only. These are the rules the
  app's facade enforces
  ([`connector-reach.ts`](../../src/lib/apps/connector-reach.ts)), applied in
  [`src/lib/connectors/reach.ts`](../../src/lib/connectors/reach.ts);
- what it called in the last 30 days, method by method, with failures, from
  `telemetry_events`. A method it called that it can't call now says so. Calls
  from an app that no longer declares the connector are listed beneath.

Each row of a tenant connector that authenticates also offers **Give it its
own credentials…**, which opens that app's credentials inline: the connector's
fields, **Connect its account** for OAuth, **Verify its connection**, and
**Use the shared credentials** to take them away. A row with its own carries an
**Own credentials** pill that says how far they are set up, and the section's
first line counts who shares the credential and who has their own. The way
back from an app's Connect lands on its row, opened.

The tile carries the summary: "Used by 3 active apps · 1 can change data".

The section shows what MixOS allows, not what the provider does: that is the
credential's scopes, on the Methods and Scopes tabs. It is shown before the
credentials are saved too, since saving them is what hands the connector to
these apps.

Two things it never does, because both would show less reach than there is:

- **Guess that an app is off.** When the apps' switches can't be read, every
  app counts as running, and the section says so.
- **Say "no calls" when it doesn't know.** The calls are streamed in after the
  page, from one query for every connector, and a table that can't be read
  reads "Couldn't read which methods it called."

The calls are evidence, not a full account: a call the facade refused never
reached the connector, so it isn't recorded, and recording is best-effort.

---

## The Configure wizard

### One step at a time, with a rail

Only the current step's content renders. That is the point — an admin pasting a
client secret does not need three other steps in view — but hiding the rest
costs the two things a list gave for free: *where am I* and *how much is left*.
A progress rail across the top gives both back in one line, and it is where the
green ticks live, so progress stays visible while content does not. Its circles
are buttons: once a step is no longer rendered, that is the only way back to
re-copy a redirect URI or replace a leaked secret.

### Next vs. the step's own action

This is the distinction the whole wizard turns on:

- A step the platform **can check** carries its own action — *Save credentials*,
  *Connect*, *Verify connection* — and advances by **succeeding**. It has no
  Next, because completing it *is* advancing.
- A step the platform **cannot check** carries a plain **Next**. Only the
  provider-side step is in this category: nothing here can tell whether you
  enabled an API in someone else's console.

The primary control sits **bottom-right of every step**, whichever kind it is. A
wizard whose button moves per step makes the reader hunt for it four times.

### Advancing must never resolve backwards

Advance by pinning the next step **by id**. Never by clearing state and letting
it fall back to "the first unfinished step": immediately after a save the
revalidated props have not landed, so the checklist still says step one and the
wizard snaps backwards, then jumps forward a moment later.

Equally, do not advance blindly. Whether a step completed is a **server** fact —
the action just did the write, so it returns the answer. A client that guesses
gets it wrong in one of two directions: advance regardless and an empty submit
skips a step; re-derive from stale props and it snaps back.

### Whether it can change data

A connector with a method declared `mutates` gets one more step, before Connect
because it decides which scopes Connect asks for: **Choose whether it can change
data**. It shows whether the connector is read-only or allowed to change data,
lists the methods that change data, names the apps that ask to, and lists the
scopes allowing changes adds at Connect. Its action is **Allow changes** or
**Make read-only**, and you write nothing for it: it is built from `telemetry`,
`auth.scopes` and the apps' entries.

Read-only is a finished choice, so the step needs nothing done, except while an
app asks to change data in the connector and changes aren't allowed: that app
can't be activated, so the checklist stops there. It never locks a later step,
because keeping a connector read-only is allowed. When changes are allowed on a
connector whose grant was taken while it was read-only, the Connect step is
unfinished again until it is connected once more.

### Gating

A step that takes a value or proves something is `mustComplete`. Everything
after the first incomplete one of those is **locked** — the rail's buttons are
disabled and Next is not rendered — because those steps cannot be attempted
anyway: *Connect* without a client secret is a request the provider rejects.

Gate the **controls**, not the open step. Clamping which step may be open fights
that same post-save moment where the server has confirmed a write the props do
not yet reflect.

### Instructions

Steps come from `setup.steps[]`, and each carries at most four things:

- **`text`** — the instruction, one imperative sentence. Nothing else.
- **`values`** — literal values the admin must choose (`Internal`, `Web
  application`), **emboldened in place**. The build rejects a value that does not
  appear in the sentence, since it would silently render nothing.
- **`why`** — the justification, behind a **?** that opens on hover *and*
  keyboard focus. Gmail's "set User type to Internal" is four words of
  instruction carrying thirty words about CASA assessments and 7-day refresh
  tokens. Inline, that buries the instruction; deleted, the next person changes
  the setting back. Rationale only — a tooltip is not somewhere an instruction
  can live.
- **`link`** — where the step is carried out. **If `link.label` appears in
  `text`, that phrase becomes the link**: "On the [OAuth consent screen], set
  User type to **Internal**." A trailing "OAuth consent screen ↗" after the full
  stop makes the reader read the name twice and click the second one. Where the
  label does not appear, the link trails the sentence — fine for a destination
  the sentence never names.

Write the sentence so the destination is named in it. `setup.notes` puts a
provider-specific warning on a *platform* step instead — Gmail's "sign in as the
shared mailbox, not as yourself" belongs beside the Connect button, not in a
paragraph read four minutes earlier.

**Do not hand-write an OAuth explanation.** The registry already explains what
OAuth is, that credentials must be saved before Connect will work, that tokens
are stored encrypted and refreshed, and that whoever approves is the account the
whole deployment acts as.

---

## Validation is checked, never asked

Every tick in this dialog is a fact the platform verified. There are no
"I've done this" checkboxes: a tick that records only that someone clicked it is
worse than no tick, because it looks like the same thing.

| Step | Ticked by |
| --- | --- |
| Provider-side setup | *inferred* — credentials exist, so the app behind them does |
| Save credentials | every declared `credentialKeys` present |
| Authorize | a refresh or access token stored |
| Verify | `connector_configs.last_verified_at` set by a real call |

A connector that declares no `credentialFields` has no Save step: there is
nothing to save. A `userScoped` connector has no deployment-wide grant, so its
Authorize step connects the admin's own account, and Verify makes its call with
that grant. The tile reads **Configured** once the client id and secret are
saved, since everyone else connects their own account at `/account/connections`.

The first is inferred rather than self-reported: you cannot hold a Client ID for
an app you never created. Only a **successful** verify writes its timestamp — a
failure leaves "it worked on Tuesday" standing, which is still true and more
useful than a blank.

---

## Colour, contrast and the things that bite

- **Status is never colour alone.** Every tint carries its words. See
  `src/components/ui/status.tsx`.
- **`text-muted-foreground` on `bg-muted` is 4.34:1** — under the floor. The
  striped permission rows use `bg-muted/60`, measured at 4.51:1; at 75% it is
  4.46:1 and fails. Dividers carry the rest of the separation, because they cost
  nothing in contrast.
- **Dimming a token is legal only on a genuinely disabled control**, via the
  `disabled:` variant. A bare `opacity-50` on a token is not.
- **Anything relative to *now* is client-only.** The dialog is server-rendered
  when the OAuth return reopens it, so "3 days ago" computed during render is a
  hydration mismatch. Use `useClientValue`.

---

## Referenced by

[`connectors/AGENTS.md`](../../connectors/AGENTS.md) ·
[`/mixos connector`](../../.claude/skills/mixos/actions/connector.md) ·
[Architecture](architecture.md) · [Scopes](scopes.md)
