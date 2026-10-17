# /mixos remix

You are **abstracting one UI component of an installed app into another installed
app**: a widget, a page, or a part of a page that the developer saw in the *source*
app and wants in the *target* app, as a component of its own. You guide the
developer through three things, in order: **what is being abstracted** (where the
component starts and ends), **the data it needs to render** (its shape, field by
field), and **what each CTA in it does** (the same, something different, or
nothing). They can remove any CTA and any part of the component. The design is
[`docs/plans/20261015_2343-remix.md`](docs/plans/20261015_2343-remix.md), and the
developer-facing guide is [`docs/apps/remix.md`](docs/apps/remix.md). Read both.

```
/mixos remix <source-app>[:<widget-id|page-path>] <target-app> [notes]
```

The notes can name part of a page: "the status chips above the table". If the
first argument is a path to an existing remix plan — `apps/<target>/plans/*-remix-*.md`
— skip to [Phase 2](#phase-2--build), after re-reading the plan in full: it is
the contract the developer approved.

This is a two-phase command with a **hard stop between them**, like
[`/mixos convert`](.claude/skills/mixos/actions/convert.md):

- **Phase 1 — Analyze.** Pin the moment, find the component's footprint, build
  the remix card, ask the developer about every action, write the plan. **Then
  stop and wait for approval.** Write no code in Phase 1.
- **Phase 2 — Build.** Build it into the target app, record where it came from,
  check the record, verify.

Four rules hold throughout. Each is a decision in the plan, not a preference:

1. **Code lands only in the target app.** Never edit the source app — not a
   file, not its `app.json`. It is evidence.
2. **Nothing reaches back into the source.** No import from it (the build
   refuses one anyway), no link to `/apps/<source>/`, no `createAppClient` or
   `callAppRoute` naming it. A remixed component depends only on the app it
   lands in. "Different" points only at the target app's own routes, pages and
   connectors — never another app, even through App Services.
3. **A remix is a moment in time.** You record the commit it was taken from, and
   the record is never edited afterwards — by you or anyone. The remixed code
   is the developer's to keep changing.
4. **The license decides copy or rebuild.** `scripts/remix.ts source` says which.
   Never copy code from a source the verdict says to rebuild.

---

## Phase 0 — Before anything

1. **Both apps exist and differ.** `apps/<source>/app.json` and
   `apps/<target>/app.json`. If the target doesn't exist yet, stop: the
   developer creates it first with `/mixos app create <target>`.
2. **Pin the moment and get the license verdict:**

   ```bash
   npx tsx scripts/remix.ts source <source> <target>
   ```

   It prints JSON: `source` (`app`, `commitSha`, `commitFrom`, `modified`,
   `registry`), `license` (`source`, `target`, `mode`, `reason`) and `credit`
   (the source app's `name`, `version`, `authors`, the `date`, and the `lines`
   of the comment every landed file carries). Keep it; the provenance entry and
   the credit are built from it. Tell the developer two things now:
   - the commit being remixed, and if `modified` is true, that the code they are
     remixing isn't exactly that commit (edited after install, uncommitted
     changes, or never committed at all);
   - whether the code will be **adapted** or **rebuilt**, and the verdict's reason.
3. **Required reading**, before the footprint: [AGENTS.md](AGENTS.md),
   [apps/AGENTS.md](apps/AGENTS.md) (every invariant applies to what you build),
   [docs/apps/remix.md](docs/apps/remix.md), and, driven by what the component
   uses: [api-routes.md](docs/apps/api-routes.md), [pages.md](docs/apps/pages.md),
   [widgets.md](docs/apps/widgets.md), [database.md](docs/apps/database.md),
   [connectors.md](docs/apps/connectors.md), [app-services.md](docs/apps/app-services.md),
   [ux.md](docs/apps/ux.md).

---

## Phase 1 — Analyze

### 1.1 Find the component

The anchor the developer pointed at becomes the entry's **first anchor**:

| They named | Anchor | Where it is |
|---|---|---|
| a widget | `widget:<id>` | `apps/<source>/widgets/<id>.tsx` |
| a page | `page:<path>` | `apps/<source>/pages/<path>/Main.tsx` (`page:/` is `pages/Main.tsx`) |
| part of a page | `page:<path>` | the page it is on; the notes say which part |

If the argument names nothing, or the notes are ambiguous, ask which component
— with the candidates you found — before going further. Then say back what you
will abstract, in a sentence or two — "the pipeline table on the main page: the
stage chips, the rows, the row menu; not the page header" — and confirm it before
walking the footprint. That boundary is the first thing the developer decides.

### 1.2 Walk the footprint

From that file, follow everything the component uses, and list each with its
`file:line`:

- **Routes it calls** — `createAppClient(...).call("METHOD /path", …)` and
  `callAppRoute(...)`. Each becomes an anchor `route:METHOD /path`.
- **Their handlers**, and the `lib/server/` code they call.
- **Tables** — `context.db.table("<name>")`, and the app's migrations that
  define them.
- **Connectors**, and which of their methods are declared `mutates`.
- **Jobs** that fill what it reads (`job:<name>` anchors), hooks it fires,
  notifications it sends, telemetry it tracks.
- **App Services** — `context.services.request(...)`. Data the source gets from
  a third app is **not** carried over: the remix maps it to the target's own
  data (decision 10).

### 1.3 Build the remix card

Five parts, in the plan, in this order. Use the developer's words for things
where you can.

**Needs (inputs).** The data structure the component needs to render, written
as a TypeScript type — the component's props — with every field's type, whether
it is required, and where the source gets it: usually the output schema of a
route it calls. For each field, propose where the target's data comes from (an
existing route or table field), or "add it" (a column, a table, a setting).

**Gives (outputs).** What it hands its host: events, state kept in the URL, a
refresh after a write. Each is wired up or ignored.

**Does (actions).** Every CTA and every other action with an effect:

| Action | Trigger | What it does in the source | Sends | Who may | Notes |
|---|---|---|---|---|---|
| `change-status` | dropdown on each row | PATCH /applications/[id]: sets status | id, status | the row's owner | |
| `delete` | row button → confirm | DELETE /applications/[id] | id | the row's owner | **destructive** |
| `go-to-library` | header link | navigates to `/apps/<source>/library` | — | anyone | **into the source** |

Writes come from the mutating route calls; their full effect from the route
handler — table writes, `mutates` connector calls, notifications, hooks,
telemetry. Navigation comes from links and router calls; downloads and
clipboard copies from the code that makes them. Mark each action
**destructive** (deletes or overwrites), **leaves the instance** (email, push, a
write through a connector), or **into the source** (navigates to the source app).

**Hidden rules.** Behaviour inside a handler the UI doesn't show — "moving to
applied for the first time stamps an applied date". Each gets an id and its own
line.

**Parts.** The pieces of the component that aren't actions: sections, columns,
badges, the header, the empty state, the loading skeleton, and interactions with
no effect outside it — filtering, sorting, expanding. Any of them can be removed.

Then **Depends on** (tables, connectors, roles, platform capabilities) and the
**license verdict** from Phase 0.

Ids — for actions, hidden rules and parts — are lowercase-hyphenated:
`change-status`, `applied-date-stamp`, `status-filter`.

### 1.4 Ask

Use the question tool (`AskUserQuestion`): at most four questions per call, two
to four options each, the recommended option first and marked "(Recommended)".
The developer can always type their own answer.

1. **Each action** — one question per CTA:
   - **Same** — the equivalent in the target: name the target route it would use,
     or what it would need ("Same — needs a `stage` column and a PATCH route").
   - **Different** — the control stays and does something else *in the target*.
     Offer the target's own routes, pages and connectors that fit; take free text.
   - **Remove** — the control is left out, and anything only it needed goes too.

   Recommend where the target clearly has an equivalent. **No recommendation**
   for a destructive action or one that leaves the instance — present the options
   neutrally. An action **into the source** offers only Different and Remove.
2. **Each hidden rule** — its own question: Same, Different or Remove.
3. **Parts** — one multi-select question: "Which parts should be left out?"
   Unselected ones are kept.
4. **Each kept or changed action: who may do it in the target.** Roles belong to
   each app, so restate the source's rule in the target's terms.
5. **Inputs** — show the mapping you propose as a table and ask the developer
   to confirm or correct it. **Outputs** — wire up or ignore.
6. **Keywords** — propose 2 to 5 that describe the component, ideally one each
   for its layout, its interaction and its purpose (`status-table`,
   `inline-edit`, `pipeline`). Lowercase words joined by hyphens; no
   `feature`, `component`, `page`, `app`, `ui`, `data` or `view`. Let them edit.

Update the card as answers come in: removing an action or a part drops the
inputs, dialogs and routes only it needed; Same may add an input.

A component that was itself remixed into the source is credited to the source
alone. Nothing earlier is tracked.

### 1.5 Write the plan, then stop

`apps/<target>/plans/YYYYMMDD_HHMM-remix-<source>-<component>.md`, per
[`docs/plans/README.md`](docs/plans/README.md), with these sections:

- **Context** — what is being remixed from where, the commit (and `modified`),
  the license verdict and its reason. If the code will be rebuilt, say plainly:
  you read the source to build the card, so this is not a clean room; it avoids
  copying code and is not a legal clearance.
- **The remix card** — the five parts from 1.3.
- **Decisions** — every answer from 1.4, as a table.
- **Input mapping** — source field → target field or addition.
- **Structure** — the files you will create or change in the target, and any
  migration.
- **Parity checklist** — one row per kept or changed action, kept hidden rule and
  kept part: what it does in the target, status `todo`.
- **Provenance** — the exact entry you will append to `remixedFrom` (see 2.4).
- **Verification** — [Verify](#verify), made concrete.

Then **stop.** Summarize in chat — the component, the commit, adapt or rebuild,
the decisions counted (kept / changed / removed), what the target needs adding —
and **wait for approval.** Phase 1 writes the plan file and nothing else.

---

## Phase 2 — Build

Approved. Follow [`/mixos app`](.claude/skills/mixos/actions/app.md); every rule in
it and in [apps/AGENTS.md](apps/AGENTS.md) applies.

### 2.1 Build into the target

- **Only `apps/<target>/`.** Imports go to the target's own files, platform
  modules and the allowed packages — the build refuses anything else.
- **An adapter** between the target's data and the component's inputs, so the
  component keeps the shape the card gave it. It sits in the target's
  `lib/server/` or beside the component, wherever the target's conventions put it.
- **New tables** are new migrations in the target's own `migrations/`.
- **Each decision as made:** Same and Different through the target's routes;
  Remove as absent, never disabled; roles as agreed.
- **The credit, in every landed file.** At the top of each file the remix
  creates or substantially writes — after any license header — put `credit.lines`
  from Phase 0 as a comment, exactly: `//` lines in TypeScript and JavaScript,
  `--` in SQL. It names the source app, the version, its authors and the day:
  `// Remixed from Careers (careers) 1.4.0, by Ada Lovelace, on 2026-10-16.`
  JSON files carry none. The check in 2.4 refuses a landed file without it.
- **Adapted:** copied files also keep the source's license notice at the top. For
  MPL-2.0 that is the MPL header, unchanged. For MIT, BSD, Apache-2.0 and the
  like, a header naming the source app, its authors from its `app.json`, and its
  license. **Rebuilt:** write the code from the card, not from the source's code.
- Update the parity checklist in the plan as you go. A row is `done` when it
  works in the browser.

### 2.2 Never

- Edit anything in `apps/<source>/`.
- Edit an existing entry in any app's `remixedFrom`. A second remix of the same
  component is a new entry.
- Link, import or call the source app.
- Copy a secret value anywhere.

### 2.3 Gather the provenance

- `remixedAt` — today, `YYYY-MM-DD`.
- `source` — `app`, `commitSha`, `commitFrom`, `modified` and `registry` exactly
  as `scripts/remix.ts source` printed them in Phase 0; `anchors` — the component
  first, then every route and job the footprint drew on.
- `summary` — one sentence: what the component is in the target.
- `keywords` — the 2 to 5 agreed.
- `license` — `{ "spdx": <source license or null>, "mode": "adapted" | "rebuilt" }`.
- `actions` and `hiddenRules` — `{ "<id>": "same" | "different" | "remove" }`
  for every one on the card.
- `partsRemoved` — the ids of the parts left out; `[]` for none.
- `landedIn` — every file in the target the remix created or substantially wrote,
  relative to `apps/<target>/`.

### 2.4 Record it

Append the entry to the **end** of `remixedFrom` in `apps/<target>/app.json`
(create the array if there is none). Don't reorder or touch any other entry.
Then:

```bash
npx tsx scripts/remix.ts check <target>
```

It checks the last entry against the moment: the commit still matches, the
anchors exist in the source, the keywords are recorded normalized and number 2
to 5, the license allows what the entry says, every landed file exists and
carries the credit, and none reaches back into the source.
Fix what it reports and run it again until it prints that the entry checks out.
This is the only time these are checked; the build checks only the entry's shape
from now on.

---

## Verify

Everything in [`/mixos app`'s verification](.claude/skills/mixos/actions/app.md#verify-before-reporting-done)
— registry generation, `npm run typecheck`, `npm run lint`, migrations, a real
browser pass — plus:

1. **`npx tsx scripts/remix.ts check <target>`** is clean.
2. **Every parity row is `done`**, walked in the browser: each kept action does
   what was agreed in the target, each changed one does the new thing, each
   removed one is absent, each kept hidden rule holds.
3. **The source is untouched:** `git status --short apps/<source>/` shows nothing
   this remix did.
4. **Nothing reaches back:** grep the landed files for `/apps/<source>` and the
   source's slug.

---

## Report

Close with: the component and the source commit (and `modified`) · adapted or
rebuilt, and why · actions kept / changed / removed, and hidden rules and
parts removed · the keywords · the files that landed · anything the target
gained (a column, a table, a setting) · that the remix counts toward the source's
creator on mixos.org once the target app is published with it · the next step:
`/mixos deploy` to commit and open a PR.

---

## User request

The arguments the dispatcher passed — everything after `remix` in the invocation.
