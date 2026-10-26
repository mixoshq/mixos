# /mixos convert

You are converting an **existing, non-MixOS application** into a MixOS app under `apps/`.

This is a two-phase command with a **hard stop between them**:

- **Phase 1 — Analyze.** Inventory the source, map every piece onto a MixOS primitive, decide the app boundary, slice the work into phases, and write a build plan. **Then stop and wait for approval.** Write no app code in Phase 1.
- **Phase 2 — Build.** Build **phase 1 of the slice only**, following [`/mixos app`](.claude/skills/mixos/actions/app.md) end to end, and close out the parity checklist.

**If the first argument is a path to an existing conversion plan — `apps/<slug>/plans/*.md` — skip Phase 1 and resume at [Phase 2](#phase-2--build-the-first-slice).** Re-read the plan in full first; it is the contract you agreed to.

A conversion is a **re-architecture, not a port.** The original code is a *specification* of behaviour — what the app does, what data it holds, what rules it enforces. It is not source material to paste. Everything the platform already owns (auth, routing, HTTP, styling, state, secrets, tenancy) gets discarded and re-expressed in MixOS terms. See [What does not come over](#18-what-does-not-come-over--say-this-out-loud).

---

## Phase 0 — Get the source, read-only

Resolve the first argument:

- **Git URL** → `git clone --depth 1 <url> <scratchpad>/convert-src` into the session scratchpad. Never clone into `apps/` or anywhere else in this repo.
- **Local path outside the repo** → read it in place.
- **A path already inside this repo** (a scratch folder, a staged drop) → read it in place, and note in the plan that it must be deleted before the conversion PR merges. Legacy source must not ship inside `apps/`.

Then, before reading a line of logic:

1. **Never modify the source.** No edits, no `npm install`, no migrations, no running its test suite against a live database. It is evidence.
2. **Record provenance and license.** Who wrote it, where it came from, what license file (if any) it carries. Put this in the plan's Context section. If the source is third-party and its license is restrictive or absent, say so explicitly and ask the user before converting.
3. **Scan for committed secrets** — `.env`, `config/*.yml`, hardcoded keys, `credentials.json`. **Never copy a secret value into this repo**, not into `app.json`, not into a plan file, not into a comment. Record only the *name* of each setting and where it belongs (`env[]` in the manifest, or a connector credential an admin enters at `/admin/connectors`). If you find a live-looking credential in the source, tell the user — it may need rotating regardless of this conversion.

---

## Required reading (do this before Phase 1's mapping step)

You cannot map onto primitives you have not read. In order:

1. [AGENTS.md](AGENTS.md) — this is not vanilla Next.js.
2. [apps/AGENTS.md](apps/AGENTS.md) — the 28 hard invariants. Read all of them; a conversion trips more of them than a greenfield app does, because the source has its own opinion about every one.
3. [docs/apps/architecture.md](docs/apps/architecture.md) — directory layout and the full `app.json` field reference. This is the manifest you are mapping *onto*.
4. Then, driven by what the inventory turns up: [pages.md](docs/apps/pages.md), [widgets.md](docs/apps/widgets.md), [api-routes.md](docs/apps/api-routes.md), [roles.md](docs/apps/roles.md), [database.md](docs/apps/database.md), [connectors.md](docs/apps/connectors.md), [scheduled-jobs.md](docs/apps/scheduled-jobs.md), [data-freshness.md](docs/apps/data-freshness.md), [app-services.md](docs/apps/app-services.md), [notifications.md](docs/apps/notifications.md), [telemetry.md](docs/apps/telemetry.md), [mcp.md](docs/apps/mcp.md), [ux.md](docs/apps/ux.md), [app-shell.md](docs/apps/app-shell.md).
5. Authoritative types: [src/lib/apps/types.ts](src/lib/apps/types.ts). Canonical template: [apps/_template/](apps/_template/).

Do not infer conventions from surrounding code, and do not guess based on training data.

---

## Phase 1 — Analyze

### 1.1 Identify the stack

Read the manifest of the *source* first — `package.json`, `Gemfile`, `requirements.txt`, `composer.json`, `pyproject.toml`, or the export format of a low-code tool. It tells you the shape of everything else. Then pick the matching profile in [Stack profiles](#stack-profiles) below.

### 1.2 Inventory the surface

Enumerate, exhaustively, with a source `file:line` for each row. **This inventory is the parity checklist** — it is the artifact everything else is measured against, so undercounting here is the single most expensive mistake in the command.

| Bucket | What to list |
| --- | --- |
| **Screens** | Every user-visible route/page/view/tab/modal, including admin-only and rarely-used ones. |
| **Endpoints** | Every HTTP handler, GraphQL resolver, RPC method, or form POST target. Method + path + what it returns. |
| **Data model** | Every table/model/collection, its columns and types, and the relationships between them. |
| **Background work** | Cron entries, queue workers, schedulers, polling loops, webhook receivers. |
| **Roles** | Every role, permission flag, or `if current_user.admin?` branch. Note which endpoints each gates. |
| **Outbound integrations** | Every external service the app calls, with the credential it uses. |
| **Configuration** | Every env var / config key, and what breaks without it. |
| **Notifications** | Email, SMS, Slack, push — what triggers each and who receives it. |
| **Assets** | Logos, fonts, uploaded files, static data files. |

### 1.3 Map each row onto a MixOS primitive

Universal translation table. Apply it row by row against the inventory:

| Legacy concept | MixOS home | Notes |
| --- | --- | --- |
| Login page, session store, users table, JWT middleware | **Delete.** Platform session; `context.user` | Never port an auth system. This is the #1 source of wasted conversion effort. |
| Roles / permission flags | `roles: [{ key, label }]` + `defaultRole` in `app.json`; `context.user.hasRole([...])` | The platform stores the role; **your handler enforces the policy**. `hasRole` ignores `isAdmin` — write `context.user.isAdmin \|\| context.user.hasRole([...])` if admins bypass. |
| REST/GraphQL endpoint, form POST | `api/<path>/route.ts` exporting `defineRoute({ auth, roles, input, output, budget, handler })` | Handler returns **plain data**, never a `NextResponse`. Throw `AppError.notFound()/.forbidden()/.unavailable()`. |
| Public/unauthenticated endpoint | `auth: ["public"]` (or `["password"]`) on the route | Derived into `/api/p/<slug>/...`. `context.user` becomes nullable and the compiler makes you handle it. |
| ORM models + migrations | `"database": true`, `migrations/*.sql`, `context.db` | Write **bare** table names; they live in the app's own schema. Triggers and functions do not translate: an `updated_at` trigger becomes an `updatedAt` entry in `app.json`, and other logic moves into routes or jobs. |
| Cron job, queue worker, scheduler | `schedules: [{ name, everyMinutes \| cron }]` + `jobs/<name>.ts` | One cadence per job. `everyMinutes` ≥ 5 and a multiple of 5. Handler gets a **user-less** `SystemAppContext`. |
| Incremental pull from an upstream (watermarks, "sync since") | `sync: [{ name, schedule, source, window, budgetMs }]` + `sync/<name>.ts` via `defineSync` | Prefer this over a hand-rolled job. The platform owns the watermark, budget, window halving, and empty-result guard — and the provider cursor never leaves the run. |
| API client with credentials (Stripe, Salesforce, an internal API with a token) | A **connector** under `connectors/` | Tenant-scoped, admin-configured. See [1.4](#14-outbound-integrations--reuse-flag-delegate). |
| Outbound HTTP with no credential | `context.http` + the hostname in `egress: []` | Raw `fetch` — or any other network constructor or HTTP client — fails the build in `apps/**`, with no escape. |
| `.env` / config keys | `env: [{ key, label, type }]` in `app.json` → `context.env.<KEY>` | `process.env` fails the build, with no escape — the raw environment carries platform secrets. `password`-typed values are encrypted at rest. |
| Page / screen / view template | `pages/*.tsx` | Server page calls `await callAppRoute("<slug>", "GET /items", input)`; client page calls `createAppClient<"<slug>">(slug).call(...)`. |
| Dashboard card, KPI tile, embeddable chart | `widgets/*.tsx` + a `widgets[]` entry | Widget `id` comes from the filename. Widgets never import connectors, `context`, the DB, or `lib/server`. |
| CSS, Tailwind config, theme file, design tokens, `dark:` classes | **Delete.** Semantic tokens from the design system | `text-foreground`, `bg-card`, `bg-primary`, `text-success/warning/destructive`, `cat-1`…`cat-6` for categorical. No hex, no palette classes, no `dark:` variants — colour forks in the theme, never in an app. |
| Hand-rolled `<button>`, `<input>`, `<table>`, card markup | `Button`/`IconButton`, `Input`/`Select`/`Checkbox` in `Field`, `DataTable`, `Card`/`SectionCard` | Raw elements are build failures in `apps/**`. |
| Redux / Zustand / react-query / manual loading flags | `useAppQuery` + `AsyncView` | It refuses to render data without a layout-matching `skeleton` and an `empty` that names its `cause`. Filter state goes in the URL. |
| axios/fetch wrapper in the client | `createAppClient(appSlug)` | Typed against the route's own schemas. |
| A library from the source's `package.json` | `react`, `zod`, `lucide-react`, `next/link`, `next/navigation` or `next/font/*`; otherwise a UI primitive, a connector, `context.http`, or plain code in the app | App code imports nothing else and no Node built-in, and the build skips an app that tries. Map every dependency to one of these; one that maps to none is a **gap**: record it in the plan as a decision for the user. Copying a library's source into the app is not a way round: that code is held to the same rules. See [What an app can import](docs/apps/architecture.md#what-an-app-can-import). |
| Server code calling into the platform: look up users, change roles, send notifications, read settings, call another service | `context.user`, `context.notifications`, `context.env`, `context.services`, each behind its manifest declaration | Never a platform module: those are off the import list because each would be a capability without its declaration. User and role administration has no app equivalent; it is the platform's. |
| Email / SMS / Slack notification | `"notifications": true` + `context.notifications.send({ userIds, ... })` (Web Push) | **Not a like-for-like swap.** If the original emails external recipients, that is a *gap* — record it and ask the user, don't silently downgrade it to a push to platform users. |
| Analytics / event tracking calls | `telemetry: [{ name, description }]` + `context.telemetry?.track(...)` | Undeclared names are dropped. Keep properties free of PII. |
| `org_id` / `tenant_id` / workspace column threaded through every query | **Delete the column.** | The platform deployment *is* the tenant, and a connector's credentials are the deployment's (or, for a user-scoped one, each person's). Porting a tenancy column duplicates a boundary the platform already draws and quietly breaks every scoped query. Exception: the original really did model multiple *customer* records as data — then it stays as an ordinary domain column, not as a security boundary. |
| Feature flags / kill switches | `env[]` entries, or plain code | Do not build a flag system. |
| File uploads / blob storage | **Gap.** Flag it. | Confirm what the platform supports before promising it in the plan. Do not invent a storage path. |
| Server-rendered HTML fragments, `dangerouslySetInnerHTML` | Rebuild as components; formatted text from elsewhere (a CMS, a README, notes) through `Markdown` from `@/components/ui/markdown` | There is no escape: the HTML sinks fail the build. If the source only offers HTML, that is a *gap* — record it and ask the user. |
| File downloads, streamed or non-JSON responses, redirects | `defineRoute({ raw: true, … })` returning a `Response` | Declare `escapes: [{ rule: "raw-response", reason }]` in `app.json` — a raw route without it keeps the app out of the registry. Auth, roles, CSRF and the rate limit still apply. |
| A second app hiding inside this one | A separate app + `provides`/`consumes` App Services | See [1.5](#15-decide-the-boundary-one-app-or-several). |

### 1.4 Outbound integrations — reuse, flag, delegate

For each outbound integration in the inventory:

1. **Look for an existing connector first.** `ls connectors/` and read the manifest of anything close. Then search the Registry (`curl -sG https://mixos.org/api/v1/search -d kind=connector --data-urlencode 'q=<service>'`): a connector published there with a `latestVersion` is installed by an admin from **Admin > Connectors > Browse Connectors** on a local checkout. Reuse beats building.
2. **If none exists**, record it in the plan as a **blocking dependency**, naming the service, the operations the app needs, and the credentials involved. **Do not build the connector inside `/mixos convert`** — tell the user to run `/mixos connector create <name>`. A connector is a shared, security-sensitive artifact; it deserves its own plan and its own review, not a side effect of an app conversion.
3. **If there is no credential involved**, it is not a connector — it is `context.http` plus an `egress` entry. Say which you chose and why.

An integration in the "no connector yet" list means the conversion phase that depends on it **cannot be built**. Sequence the slice so phase 1 does not depend on a connector that does not exist.

### 1.5 Decide the boundary: one app or several

Default to **one app**. Split only when the source genuinely contains separate domains with different audiences and their own data — then declare the split explicitly, wire them with `provides`/`consumes`, and build them one at a time. Splitting is a real cost: two-sided consent, a broker hop, two manifests. Do not split just because the source had two top-level folders.

### 1.6 Slice into phases — build phase 1 only

Almost every real conversion is too big for one pass. **Phase 1 is a walking skeleton**, not a subset of screens picked at random:

- The **complete data model** for the slice (migrations), because schema churn later is the expensive kind.
- The **manifest** — every field you can already commit to.
- The **two or three highest-traffic screens** end to end, with real data.
- The **routes those screens need**, and nothing more.

Everything else goes into numbered follow-up phases **in the same plan document**, each with its parity-checklist rows attached, so nothing silently disappears between phases. A deferred row is a *decision with a reason*, never an omission.

### 1.7 Data: schema only

Translate the schema into `migrations/*.sql` with bare table names. **Moving production data is out of scope for this command** — state that explicitly in the plan, note what would be involved (dump format, row counts, PII, ordering constraints), and leave it as the user's exercise. Do not write an importer, and do not promise one.

Two things to fix while translating rather than after:

- **Drop tenancy and auth columns** — `org_id`, `user_password_hash`, `session_token`, `api_key`. Foreign keys to a users table become the platform user id, in a plain `uuid` column: an app's foreign keys can point only at its own tables.
- **Keep the types honest.** A legacy `varchar` holding a JSON blob, an integer holding an enum, a string holding money — translate to the type the data actually is, and note the change in the plan. This is the one moment where fixing it is nearly free.

### 1.8 What does not come over — say this out loud

The plan **must contain this list**, explicitly, with the source files being dropped. Readers who wrote the original will otherwise assume the conversion lost the code by accident:

Authentication and session handling · the user table · the routing layer · the HTTP client wrapper · state management · CSS/theme/design tokens · the component library · the config/secrets loader · the tenancy column · the logging framework · the test harness · the build tooling · anything that exists to solve a problem the platform already solves.

### 1.9 Write the plan, then stop

Write to `apps/<slug>/plans/YYYYMMDD_HHMM-convert-<slug>.md` per [`docs/plans/README.md`](docs/plans/README.md), with these sections:

- **Context** — what the original is, where it came from, its license, why it's being converted.
- **Decisions** — the app slug and name, one-app-vs-split, the phase slicing, every judgment call from the mapping table, and anything you locked with the user.
- **Structure** — the file-level plan: the full `app.json` you intend to write, migrations, routes, pages, widgets, jobs/syncs.
- **Dependencies & gaps** — missing connectors, unsupported features (file storage, email), unanswered questions.
- **Not converted** — the [1.8](#18-what-does-not-come-over--say-this-out-loud) list.
- **Parity checklist** — the [1.2](#12-inventory-the-surface) inventory as a table: `source file:line` · what it is · MixOS destination · phase · status (`todo` / `done` / `deferred: reason` / `dropped: reason`).
- **Verification** — the [Verify](#verify) section below, made concrete for this app.

Then **stop.** Present a short summary in chat — the slug, the inventory counts, the phase-1 slice, the blocking gaps, and any question you need answered — and **wait for approval.**

**Phase 1 creates `apps/<slug>/plans/` and nothing else.** The plan file goes there so it lives beside the app it describes, and an app folder holding only a plan is a legitimate state — the registry reports it as *planned, not yet built* and skips it. Write **no** `app.json`, no migrations, no routes, no pages, no widgets until the plan is approved.

---

## Stack profiles

Use alongside the universal table. These are the mappings that differ by source shape.

**React / Next / Vue SPA + API.** The cleanest case, and the one where the temptation to paste is strongest — resist it: components come over as *layouts*, rewritten against the design system's primitives. Client routes → `pages/`; the API layer → `defineRoute` handlers; the fetch/axios wrapper → `createAppClient`; react-query/SWR/Redux → `useAppQuery` + `AsyncView`. A component that fetches its own data and could stand alone on a dashboard is a **widget**, not a page. Watch for auth logic embedded in components (`{user.isAdmin && ...}`) — that becomes a fail-closed capability context, and the *route* enforces the role independently.

**Server-rendered monolith (Rails / Django / Laravel / Express+templates).** Controllers → routes; models → migrations + `context.db` queries; views → `pages/` (server pages calling `callAppRoute`); helpers/services → `lib/server/`; workers (Sidekiq/Celery/Resque) → `jobs/` or `sync/`; `before_action`/middleware → the route's declared `auth` and `roles`. Two traps: an ORM with lazy loading hides N+1s that were tolerable in-process and are not tolerable through a connector — see [connector-call discipline](.claude/skills/mixos/actions/app.md#connector-call-discipline-widgets--routes); and fat models often hide business rules that no controller mentions — read the model callbacks, not just the actions.

**Low-code / internal tools (Retool, Airtable, Streamlit, Apps Script, Zapier).** Usually a data model + a few screens + a sync, wearing a lot of vendor scaffolding. The vendor's data store → scoped tables; its scheduled refresh → `sync[]`; its connections → connectors; its query/transform blocks → route handlers. Expect **undocumented business logic in formulas and filters** — read every one, since it is often the only place a rule is written down. Expect no real role model: derive roles from who the user says uses it, and ask.

**Standalone script or dashboard (cron script, Jupyter/Streamlit, CLI report).** Typically becomes one job + one page + a couple of widgets. The script's `main()` → `jobs/<name>.ts` under a wall-clock deadline; its output file/DataFrame → a scoped snapshot table; its plots → widgets reading a route. This is where the [data-freshness rules](docs/apps/data-freshness.md) bite hardest: a script that re-reads everything each run is a full refresh, and the platform will not tolerate it at the 4-minute timeout. Convert it to a watermarked incremental sync in phase 1, not later.

---

## Phase 2 — Build the first slice

Approved. Now follow [`/mixos app`](.claude/skills/mixos/actions/app.md) — every rule in it applies, including all of [apps/AGENTS.md](apps/AGENTS.md). Conversion-specific order of operations:

1. **`app.json` first.** Copy [`apps/_template/`](apps/_template/) as the starting shape. Folder name is the slug — no `slug` field, no `hasPages`, no `hookCounts`, no hand-written `lastUpdated`. `icon` is a lowercase-hyphenated Lucide name.
2. **Migrations next**, then `npm run migrate:apps`. Get the schema right before anything reads from it.
3. **Routes**, then **pages and widgets** — in that order, so the UI is built against a route that actually returns data.
4. **Update the parity checklist in the plan file as you go**, not at the end. A row moves to `done` when its behaviour works in the browser, not when its file exists.
5. **When the source contradicts a platform invariant, the invariant wins** — and you note the behaviour change in the plan. If the difference is user-visible (a permission that widens, a notification that no longer sends, a field that changes type), **stop and ask**. Silent behaviour changes are how a conversion loses trust.
6. **When the source is ambiguous, ask — don't invent.** "This endpoint's role check is `user.level >= 2` and I can't find what level 2 means. Which app role should gate it?" is a good question. Guessing at a permission boundary is not.
7. **Start the release notes.** `release-notes.json` beside `app.json`, its one entry the first release: what the app does in MixOS, for the people who will use it, in one line of 300 characters or fewer. Each later phase that changes what they see adds a line at the top. See [Release notes](docs/apps/architecture.md#release-notes-release-notesjson).

Delete any legacy source you staged inside the repo before reporting done.

---

## Verify

Everything in [`/mixos app`'s verification](.claude/skills/mixos/actions/app.md#verify-before-reporting-done) — registry generation, `npm run typecheck`, migrations, the route smoke test, a real browser pass on every surface you built, a double tick for any schedule or sync — **plus the parity audit**:

1. **Every inventory row has a terminal status.** `done`, `deferred: <reason>`, or `dropped: <reason>`. No blanks, no `todo` left in a shipped phase. A row you cannot account for means the inventory was wrong, which means go back and fix the inventory.
2. **Walk the phase-1 rows against the running app.** For each `done` row, exercise that behaviour in the browser and confirm it matches what the source did. Reading the code you just wrote is not verification.
3. **Re-check the drops.** For each `dropped` row, confirm the reason still holds now that the app exists. "The platform handles this" is easy to assert in a plan and wrong in practice.
4. **Confirm no legacy leakage.** `npx eslint apps/<slug>` clean, and grep the app for `process.env`, raw `fetch(`, `dark:`, hex colours, `org_id`/`tenant_id`, and any leftover reference to the original's auth. These are the artifacts that survive a conversion.

---

## Report

Close with: the app slug and where it lives · phase-1 rows done / deferred / dropped with counts · the blocking gaps (missing connectors, unsupported features) and what unblocks each · every user-visible behaviour change from the original · the exact next command to run for phase 2 of the slice.

---

## User request

The arguments the dispatcher passed — everything after `convert` in the invocation.
