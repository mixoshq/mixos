# Remix

A **remix** abstracts one UI component of an installed app — a widget, a page,
or a part of a page — into another installed app, as a component of its own. You
run it through the agent, naming the app it comes from, a page's path or a
widget's id in it, and the app to build it into:

```prompt
/mixos remix careers:/ deals
```

A note can name just a part of it:

```prompt
/mixos remix careers:application-pipeline deals "the status chips above the table"
```

The agent walks you through what is being abstracted — where the component
starts and ends — then the data structure it needs to render, then what each CTA
in it does. You can remove any CTA and any part of the component. It writes all
of that up as a **remix card** and a plan, and stops. Once you approve, it builds
the component into your app, puts a credit comment at the top of every file it
wrote, and records where the component came from in your `app.json`.

That record is what tells the source app's creator their component was remixed.
Once your app is published on mixos.org with it, the creator sees which parts of
their app were remixed, from which version, and what people kept, changed and
removed.

The full procedure the agent follows is
[`.claude/skills/mixos/actions/remix.md`](../../.claude/skills/mixos/actions/remix.md);
the design and every decision behind it is
[`docs/plans/20261015_2343-remix.md`](../plans/20261015_2343-remix.md).

## The remix card

| Part | What it is | What you decide |
|---|---|---|
| **Needs** | The data structure the component needs to render, as a TypeScript type — mostly the output of the routes it calls. | Where each field comes from in your app, or that your app should add it. |
| **Gives** | What it hands its host: events, state in the URL, a refresh after a write. | Wire each up, or ignore it. |
| **Does** | Every CTA and every other action with an effect: writes, navigation, downloads, anything sent out. | **Same**, **Different** or **Remove**, one by one. |
| **Hidden rules** | Behaviour inside a route the UI doesn't show — "moving to applied stamps an applied date". | Same, Different or Remove, each on its own. |
| **Parts** | Everything else in it: sections, columns, badges, the empty state, filtering, sorting. | Which to remove. The rest come along. |

- **Same** — the action does the equivalent in your app, through one of your
  routes or a new one. The card says which, and what it costs.
- **Different** — the control stays and does something else in your app: one of
  your routes, pages or connectors.
- **Remove** — the control is left out, and anything only it needed goes too.

A few things are never offered:

- **A link back into the source app.** A remixed component depends only on the
  app it lands in, so navigation into the source can only be Different or Remove,
  and nothing in your app may import, link to or call the source.
- **A default for a destructive action**, or for one that sends something out
  of the instance — email, a push notification, a write to a connected service.
  You choose those explicitly.
- **Different pointing at another app.** Different does something in *your*
  app.

Each action you keep also asks who in your app may do it. Roles belong to each
app, so the source's rule is restated in yours.

## Adapted or rebuilt

The source app's `license` decides whether the remix may copy its code:

| Source license | The remix |
|---|---|
| MIT, Apache-2.0, BSD, ISC, 0BSD, CC0-1.0, Unlicense, Zlib, BSL-1.0, MPL-2.0 | **Adapts** the source's code. Copied files keep the source's license notice; a copied MPL file stays MPL. |
| GPL, LGPL or AGPL | Adapts only when your app already declares the same license; otherwise rebuilds. |
| None declared, `UNLICENSED`, or one the check doesn't know | **Rebuilds** from the card, without copying code. |

Rebuilding isn't a clean room: the agent reads the source to build the card. It
avoids copying code; it is not a legal clearance.

## The record: `remixedFrom`

Each remix appends one entry to your app's `app.json`:

```jsonc
"remixedFrom": [
  {
    "remixedAt": "2026-10-16",
    "source": {
      "app": "careers",
      "commitSha": "4f6c1d0e9b8a7c6d5e4f3a2b1c0d9e8f7a6b5c4d",
      "commitFrom": "install-record",
      "modified": false,
      "registry": { "origin": "https://mixos.org", "slug": "careers", "version": "1.4.0" },
      "anchors": ["page:/", "route:PATCH /applications/[id]", "route:POST /applications"]
    },
    "summary": "Table of deals with a stage on each row, a stage filter, and create and edit",
    "keywords": ["status-table", "inline-status", "crud-dialogs"],
    "license": { "spdx": "MPL-2.0", "mode": "adapted" },
    "actions": { "change-status": "same", "edit": "different", "delete": "remove" },
    "hiddenRules": { "applied-date-stamp": "same" },
    "partsRemoved": ["status-filter"],
    "landedIn": ["pages/deals.tsx", "api/deals/[id]/route.ts"]
  }
]
```

| Field | What it holds |
|---|---|
| `remixedAt` | The day the remix was taken, `YYYY-MM-DD`. |
| `source.app` | The source app's slug on this instance. |
| `source.commitSha` | **The exact commit remixed.** From the source's install record when it came from a catalogue; otherwise the last git commit that touched `apps/<source>/`; `null` for a folder never committed. |
| `source.commitFrom` | `install-record` or `git`. |
| `source.modified` | `true` when the files remixed weren't exactly that commit: edited after install, uncommitted changes, or never committed. |
| `source.registry` | The catalogue listing — origin, slug and version — from the install record; `null` for an app with none. |
| `source.anchors` | What was remixed, by names that are stable in the source: `widget:<id>`, `page:<path>`, `route:<METHOD> <path>`, `job:<name>`. The first is the component pointed at, a widget or a page; the rest are what it drew on. |
| `summary` | One sentence: what the component is in your app. |
| `keywords` | 2 to 5, recorded normalized. See below. |
| `license` | The source's license, and whether the code was `adapted` or `rebuilt`. |
| `actions`, `hiddenRules` | Each id and its decision: `same`, `different` or `remove`. |
| `partsRemoved` | The parts of the component left out. |
| `landedIn` | The files in your app the remix created or wrote, relative to its folder. |

### The credit

Every file the remix creates or substantially writes starts with a comment
crediting the original work: the source app's name, the version taken, its
authors (from its `app.json`), and the day.

```ts
// Remixed from Careers (careers) 1.4.0, by Ada Lovelace, on 2026-10-16.
// Derivative work: adapted from its code, which is MPL-2.0.
```

`npx tsx scripts/remix.ts source` prints it, and the one-time check refuses a
landed file without it. SQL files get `--` lines; JSON files carry none. Code
adapted under a license keeps that license's notice as well.

### A remix is a moment in time

The entry records the moment the remix was taken, and it is **never edited**.
The pre-commit hook and the pull-request checks refuse a change to an existing
entry (`scripts/check-remix-provenance.ts`). Adding an entry and deleting one
both pass.

- **The remixed code is yours.** Change it, rename it, move it. The entry still
  says what it was taken from.
- **The source moving on changes nothing.** The entry keeps the commit it was
  taken at. Nothing tells you when the source changes.
- **Remixing again from a newer version is a new remix**, with a new entry beside
  the old one.
- **Deleting the remixed component**: delete its entry too. The remix stops
  counting; mixos.org keeps it as history.

That is also why the build checks only an entry's **shape**: that its fields are
well formed. What held at the moment — the commit matched, the anchors existed,
the landed files existed and didn't reach back into the source — is checked
once, by `npx tsx scripts/remix.ts check <app>`, when the remix is written. The
code moves on afterwards; an entry that can't be edited must never start failing
a build because of it.

### Keywords

Two to five words that describe the component — ideally one for its layout, one
for how it's used and one for its purpose: `status-table`, `inline-edit`,
`pipeline`. They're recorded normalized:

1. lowercase; spaces, underscores, slashes and dots become hyphens; other
   punctuation goes;
2. synonyms become one term — `dnd` and `draggable` become `drag-and-drop`;
3. words that describe nothing are dropped — feature, component, page, app, ui,
   data, view.

No stemming: `status` stays `status`. The synonyms and dropped words live in
[`src/lib/apps/remix.ts`](../../src/lib/apps/remix.ts), and mixos.org applies the
same rules when it counts, so a synonym added later merges counts recorded
before it. The build never re-judges an old entry against a list that has grown.

## Where remixes show

- **On this instance:** Administration → Apps → an app's **Remixes** tab. *Remixed
  from* lists what the app took; *Remixed into* lists the apps that took from it.
  Read from the build
  (`src/generated/remix-index.ts`); nothing is tracked at runtime.
- **On mixos.org**, once the app that took the remix publishes a release there
  with the entry: the source listing's page shows how many apps remixed from it,
  broken down by the source version they took, and its creator sees each
  component that was abstracted, how often, what people called it, and what
  became of each of its actions. A remix counts toward the source only when the
  source came from mixos.org, while it is in the latest release of the app that
  took it, and never when the two apps share a publisher. Only the app a
  component was taken from is credited: a remix of a remix counts toward the app
  it was taken from, not that app's own sources.
