# /mixos app

You are creating or modifying an app under `apps/`.

**If the first argument is `review`, skip to [Review mode](#review-mode-design--ux-audit) below** — it is an audit that reports before it writes, not a build.

## Write a plan first (before any code)

For anything beyond a trivial one-line tweak, **write a build plan to `apps/<slug>/plans/YYYYMMDD_HHMM-<plan-name>.md`** before editing code — the plan lives **inside the app it describes**, so it travels with the code. Cover: **Context** (why this change), **Decisions** (anything locked with the user), **Structure** (the file-level changes — manifest, migrations, routes, pages/widgets), and **Verification** (how you'll prove it works). Get it reviewed when the change is non-trivial.

- **Creating a new app?** Make `apps/<slug>/plans/` as the first thing you write, before `app.json`. It is legitimate for the folder to hold only a plan until the build starts.
- **Read the existing plans in that folder first** when modifying an app. They record decisions already locked with the user; contradicting one silently is how a change loses trust.
- **Changing the platform, not the app?** (`src/`, `scripts/`, `eslint.config.mjs`, the build.) That is a *platform* plan and goes to `docs/plans/` instead.

See [`docs/plans/README.md`](docs/plans/README.md) for the full convention.

## Required reading (do this first, in order)

1. [AGENTS.md](AGENTS.md) — this is not vanilla Next.js.
2. [apps/AGENTS.md](apps/AGENTS.md) — hard invariants and the guide index.
3. The guides it links, in order:
   - [docs/apps/architecture.md](docs/apps/architecture.md)
   - [docs/apps/pages.md](docs/apps/pages.md)
   - [docs/apps/widgets.md](docs/apps/widgets.md)
   - [docs/apps/api-routes.md](docs/apps/api-routes.md)
   - [docs/apps/roles.md](docs/apps/roles.md)
   - [docs/apps/assets.md](docs/apps/assets.md)
   - [docs/apps/connectors.md](docs/apps/connectors.md)
   - [docs/apps/database.md](docs/apps/database.md)
   - [docs/apps/notifications.md](docs/apps/notifications.md)
   - [docs/apps/scheduled-jobs.md](docs/apps/scheduled-jobs.md)
   - [docs/apps/data-freshness.md](docs/apps/data-freshness.md) — incremental sync, snapshots, caching
   - [docs/apps/hooks.md](docs/apps/hooks.md)
   - [docs/apps/app-services.md](docs/apps/app-services.md) — cross-app data requests via `provides`/`consumes`
   - [docs/apps/ux.md](docs/apps/ux.md)
   - [docs/apps/app-shell.md](docs/apps/app-shell.md) — settings surfaces, headers, tabs, URL state, permission-aware UI
   - [docs/apps/telemetry.md](docs/apps/telemetry.md) — declaring and recording key-usage events
   - [docs/apps/mcp.md](docs/apps/mcp.md) — exposing read-only tools to Claude via the MixOS MCP server
4. Authoritative types: [src/lib/apps/types.ts](src/lib/apps/types.ts). Canonical template: [apps/_template/](apps/_template/).
5. For any Next.js API you're not certain about in this repo's version, read the relevant file in `node_modules/next/dist/docs/` before using it.
6. If updating an existing app, read its current files before proposing edits.

Do not infer conventions from surrounding code alone, and do not guess based on training data.

## Non-negotiable invariants (from apps/AGENTS.md)

- Folder name === slug. No separate `slug` field in `app.json`. No leading underscore on shipped apps.
- Widgets and client pages must NEVER import connectors, `context`, or server modules. They call the app's own API routes via `createAppClient(appSlug)`.
- App code imports its own files, the platform modules on the published list, and `react`, `zod`, `lucide-react`, `next/link`, `next/navigation` and `next/font/*`. Nothing else, no Node built-ins, and no `require` or computed `import()`: the build skips an app that tries (see [What an app can import](docs/apps/architecture.md#what-an-app-can-import)). What a platform module would have done comes from `context`, behind a manifest declaration. Types may come from anywhere.
- A server page calls `callAppRoute("<this app's slug>", …)` with its own slug written as a string, and nothing imported from outside the app is written to. Both are build errors otherwise.
- Never hand-edit `src/generated/app-registry.ts`.
- Do not set `slug`, `hasPages`, or `hookCounts` in `app.json` — the registry fills these in. `lastUpdated` is stamped automatically by the pre-commit hook, not written by hand.
- `icon` must be a lowercase hyphenated Lucide name (e.g. `bar-chart`).
- Widget `id` is derived from the component filename — renaming breaks saved dashboards.
- Scoped-DB tables: each app has its own schema (`app_<slug>`, needs `"database": true`); write bare names in migrations and queries. Migrations are checked before they run: no triggers, functions, `DO`, grants, `SET`, or anything outside the app's schema (list `updatedAt` columns in `app.json` instead of writing a trigger). See `docs/apps/database.md`.
- MCP tools (`mcp` in `app.json` → `mcp/<name>.ts`) are READ-ONLY and capped at 5 per app. Export both `inputSchema` (Zod) and a default handler. Never write from one, and never call a connector method that mutates — `ctx.db` blocks writes, but the connector is on you. Share the builder the matching API route uses; don't duplicate query logic.

## Connector-call discipline (widgets & routes)

Connector calls dominate latency and many APIs force per-record fan-out. Before shipping a connector-backed route or widget, confirm the [api-routes efficiency rules](docs/apps/api-routes.md#calling-connectors-efficiently):

- **Fetch only what's rendered.** A widget must request just the data it shows; a route should make only the calls that data needs. When one route feeds several widgets, accept an `include`/`scope` param and guard each enrichment block — don't run a ticket scan for a widget that only shows names.
- **Scope before you enrich.** Filter the primary records (by user, date, status) *before* the expensive per-record enrichment, not after. "My book" should never pay to enrich the whole book.
- **No unscoped N+1 loops.** Prefer batch reads; if you must loop per-record associations, scope first, chunk, and `sleep()` between chunks.
- **`resolveConfig` blocks the config modal.** Point it at a lightweight endpoint (option lists only — never the heavy data route), `.catch()` to static options, and race a timeout so the modal can't hang on "Loading configuration...". See [widgets.md](docs/apps/widgets.md#resolveconfig-blocks-the-modal--keep-it-fast-and-bulletproof).

## Data-freshness discipline (jobs & cached read paths)

If the app has a `jobs/` handler or caches upstream data, confirm the [data-freshness rules](docs/apps/data-freshness.md) before shipping. These are `apps/AGENTS.md` invariant 21, and each one is here because it broke production:

- **Budget by wall clock.** `const DEADLINE_MS = 200_000;` in the job file, `ctx.signal.aborted || Date.now() >= deadline` checked at every item/stage/page boundary, and a `break` that commits progress rather than a throw. Never bound a job by item count alone — per-item cost varies, so a count can't predict runtime. Remember a per-tick cap is also a per-*day* ceiling once you slow the cadence down.
- **Never persist a provider cursor across ticks.** Cursors expire in less time than the interval between runs; one app spent 19 days failing on the same dead cursor. Use a `[watermark, watermark + window]` date range, and only advance the watermark when the window fully drained.
- **Serve reads from your own tables.** A page must not wait on a connector for data a job could have materialized. Pair a scheduled write path with a read path that self-heals a cold/stale snapshot, both calling the same fetch+persist helpers so they can't disagree.
- **`load*` may write; `peek*` never does.** MCP handlers get a read-only `ctx.db` and must not trigger an expensive rebuild — serve what's cached and report its age.
- **Never blank good data.** Zero rows from an upstream is not a reason to overwrite a good snapshot: throw in the job (so the admin page shows `error`), degrade to stale in the read path.
- **Delete exactly what you refetched.** Scope a cache-replacing `delete()` to the window you pulled, or a shallow scheduled sync will erase a deep backfill.

## Verify before reporting done

1. `npx tsx scripts/generate-project-registry.ts` — confirm the app and its widgets appear.
2. `npm run typecheck`.
3. If `"database": true` or migrations changed: `npm run migrate:apps`.
4. If the app declares `schedules`: `npx tsx scripts/run-scheduled-jobs.ts` (a single manual tick) and confirm the job appears at `/admin/scheduled-jobs` with a fresh `ok` run (or a deliberate skip). Each `schedules[].name` must have a handler at `jobs/<name>.ts`.
5. **Prove the job is incremental.** If the job syncs or caches upstream data, run the tick a **second** time. Both runs must be `ok` with a duration well under 240s, and the second must do materially less work than the first — a smaller window, fewer pages, or fewer items in the log line. A second run that costs the same as the first is a full refresh wearing a scheduler's clothes; fix it per the [data-freshness discipline above](#data-freshness-discipline-jobs--cached-read-paths). Then load the page and confirm the read path still renders from the snapshot with the upstream connector unconfigured.
6. For UI changes, load `/apps/<slug>` in the dev server and exercise the golden path plus one edge case. Don't claim "done" on a UI change you haven't opened in a browser.
7. **Smoke-test the routes.** Activate the app in Admin > Apps and grant it to the user you test as in Admin > Users (a `global` app needs no grant). Then run `SMOKE_EMAIL=<email> SMOKE_PASSWORD=<password> npx tsx scripts/smoke-test-app.ts <slug>` against the running server. It sends GET and HEAD to every route that user can reach, with a fake value in each path param, and never sends POST, PUT, PATCH or DELETE. Add `--base-url <url>` for a server that isn't on localhost:3000, or pass an existing session as `SMOKE_COOKIE` instead (see the script header). It must exit 0. For an app installed from the Registry, `npm run register -- app/<slug> --smoke` does all of this after Register: it runs the app's migrations, activates it, grants it to the user you sign in as, and runs the script. It works only when the checkout's database is on your machine, and it never rolls back. A pull request that changes an app runs the script again in CI. Then check two things:
   - **Unconfigured connectors:** a route whose connector isn't configured fails with a 503 that names the connector. Don't edit code: **pause and ask the user to add credentials at `/admin/connectors`**, then re-run.
   - **Live data path:** for each connector that *is* configured, at least one route returns data of the shape the widget consumes. Read the widget file to confirm the field names match: the script doesn't check shapes. A route on a user-scoped connector answers `{ connected: false }` until the user you test as connects their own account at `/account/connections`. Don't ship an app whose live data path you haven't seen work end-to-end.
8. **Connector-call review** (any new/changed connector-backed widget or route). Re-read the route against the [discipline above](#connector-call-discipline-widgets--routes): does it fetch anything the widget doesn't render? Does it enrich before filtering? Does `resolveConfig` hit a lightweight endpoint with a timeout fallback? Trim what isn't needed before claiming done.
9. **Exercise the MCP tools.** If `app.json` declares `mcp`, run `npx @modelcontextprotocol/inspector` against `http://localhost:3000/api/mcp`, complete the OAuth flow (register → consent → token), then call each tool with real arguments. Two checks, both by reading the output rather than running a script:
   - **Is it answerable?** Read the result as if you were the model. Could you answer the question the tool exists for, without a follow-up call? Is anything in there presentation noise (hex colors, RAG enums, embed URLs) that should be dropped?
   - **Is it read-only?** Re-read the handler and every helper it calls. `ctx.db` blocks writes, but a mutating *connector* call is invisible to the platform — check each one, and watch for side effects hiding in a shared builder (a tool must skip the hook-firing a sibling API route does).

## When the smoke test fails

Each request gets a result (`pass`, `fail`, `blocked` or `skipped`) and a note when there's more to say. Each app gets a status, and the last line is a JSON verdict. Triage, then re-run after every fix or user-provided change. Don't claim done until it exits 0.

- **`fail`, 503 naming a connector** — the connector isn't configured, or its credentials were refused. Do **not** edit code. Ask the user, e.g. *"The `<connector>` route answered `<note>`. Can you confirm the credentials in `/admin/connectors` are valid and include the scope(s) `<...>`?"*
- **`fail`, any other 5xx** — a bug in the route. The note carries the error code, and the server log has the stack. Fix in the route and re-run. If the cause isn't clear, show the user the note and ask one specific question. Never silently bypass.
- **`fail`, network error or no answer** — the server isn't reachable at the base URL, or the route ran past its `budget.ms`. Check the server is up, then look for a slow or unbounded call in the handler.
- **`inactive`** — every route answered 404. Activate the app in Admin > Apps. The script never does this for you.
- **`not-granted`** — the routes that need a grant answered 403. Grant the app to the user you test as in Admin > Users.
- **`signed-out`, or `blocked` with 401** — the session expired, or was revoked. Sign in again and re-run.
- **`blocked` with 429** — rate limited after three tries. Wait, then re-run once.
- **`blocked` with 405** — the server runs a different build from your checkout. Restart it, or run `npm run registry`.
- **`pass` with a note** — read it. `empty body` may be valid (no rows yet) or a shape bug: if the widget expects `{ deals: [...], totalArr: number }` and the route returns `{}`, fix the code. `403: needs role …` means the user lacks that role, which is expected. `404 with no params` is worth a look: should the route answer not-found with no input?
- **`unconfirmed`** — every route takes params and answered 404, so the run can't tell an active app from an inactive one. Check Admin > Apps.
- **`skipped`** — POST, PUT, PATCH and DELETE are never sent. Exercise them in the browser.
- **`skipped`, `not tested: 503 …`** — only in CI, which has no connector credentials, so a route that answers 503 UNAVAILABLE isn't counted as a failure there (`--skip-unavailable`). Test it in a checkout with the connector configured.
- **Data shape mismatch** (a route passes but the widget renders empty or errors, found by reading the widget file, not by the script): ask the user a targeted question, e.g. *"`<connector>` returned data but field `<X>` is missing from the response. Is the upstream object expected to expose `<X>`, or should the widget consume `<Y>` instead?"*

## Review mode (design & UX audit)

Triggered by `/mixos app review <app-slug> [notes]`. The goal is to find where an existing app
falls short of the design system and say so precisely — **not** to redesign it. Report first,
fix second, and only fix what the user picks.

### 1. Read the standard before reading the app

[`docs/apps/ux.md`](docs/apps/ux.md) and [`docs/apps/app-shell.md`](docs/apps/app-shell.md), in
full. Auditing from memory produces confident, wrong findings — the tokens and components have
changed.

### 2. Inventory the surfaces

List every page under `pages/`, every widget, every modal component, and any public/password
surface from `app.json`'s `pageVisibility` / `apiVisibility`. Audit each. An app is only as good
as its worst screen, and the worst screen is usually the one nobody demos.

### 3. Audit against this checklist

Work through it per surface. For each finding, record `file:line`, what's wrong, and the concrete
fix.

**States**
- Every fetch has a loading state, and it mirrors the final layout — not `Loading…`, not a bare spinner.
- A user-triggered refetch names what it's loading (`PendingState`), rather than flashing an anonymous skeleton.
- Empty states name their cause. If one generic blank box covers filter-empty *and* no-match, that's a finding.
- A `no-filter` empty state offers a way out.
- Error states are calm and human, and never render a raw `error.message`.
- An unconfigured connector surfaces a calm error state, not a blank panel. For a tenant-scoped connector, `configured: false` means an admin has not entered credentials, or has turned the connector off.
- A **user-scoped** connector (`"userScoped": true` in its `connector.json`) is absent from `context.connectors` until the person connects their own account, and again if the provider stops renewing their grant. That is a state, not an error: the route returns `{ connected: false }` rather than a 503, and the UI offers a Connect prompt linking to `/account/connections`. An app can't use one from `schedules` or `sync` (a job has no user), and the build rejects an app that declares both. See [User-scoped connectors](docs/apps/connectors.md#user-scoped-per-user-connectors).

**Colour & contrast**
- No raw palette classes, no hex, no opaque `bg-white` / `bg-gray-*`, no `dark:` variants. Run `npx eslint apps/<slug>` — but don't stop there: the rule can't see runtime-assembled class names, so grep for template-literal colour construction too.
- **Compute the ratio for any off-token colour you find** and put the number in the finding. "Looks low contrast" is not actionable; "3.19:1, needs 4.5:1" is.
- Status is never colour-only — `StatusDot` / `StatusPill` with a label, or an icon plus text.

**Information architecture** (see [`app-shell.md`](docs/apps/app-shell.md))
- Settings surface matches scope: app-wide → Configure page with sub-nav; per-record → modal. A settings page needing a record ID in its URL is the tell for getting this backwards.
- Header carries only repeat actions; at most one primary. Everything else is in an overflow menu.
- Tabs are peer views of one record, filtered rather than disabled.
- Filter state lives in the URL, and an absent param is distinguished from an explicit "all".
- `localStorage` prefs go through `useSyncExternalStore`, not a `useState` initializer.

**Permissions**
- The capability context fails closed (defaults `false` until `/me` answers).
- Read-only users see controls **omitted**, not disabled.
- Every mutating route enforces the role server-side regardless of what the UI does — check this even though it's not a design finding; a UI-only gate is a security bug.
- Anything cached from a user-scoped connector has the user in its cache key. A shared key serves one person's data to another ([credentials.md](docs/connectors/credentials.md#caching-a-user-scoped-response)).

**Accessibility floor**
- Keyboard reachable, focus visible, focus rings not styled away.
- Icon-only buttons have `aria-label`; decorative icons inside labelled buttons are `aria-hidden`.
- Inputs have labels; images have meaningful `alt`.

**Interaction**
- Buttons that do work disable and show progress; no double-submit.
- No layout shift between skeleton and loaded content.
- Motion is ~150–300ms and honours `prefers-reduced-motion`.

### 4. Report, then ask

Output a table — `file:line` · severity · finding · fix — ordered worst-first. Severity:

- **High** — fails WCAG AA, leaks a raw error, misleads about state, or breaks keyboard access.
- **Medium** — a designed state is missing, or IA contradicts the guide.
- **Low** — inconsistency, spacing, polish.

Then **stop and ask which to fix.** Do not start editing. A design audit that silently rewrites
the app is indistinguishable from a redesign nobody asked for, and the user may well disagree
with a finding — especially the Lows.

### 5. After fixing

Re-run `npm run typecheck`, `npx eslint apps/<slug>`, and **open the app in a browser** — exercise
each surface you touched, including one read-only user if the app declares roles. A colour swap
can be green in lint and still look wrong. Per [`apps/AGENTS.md`](apps/AGENTS.md), a UI change
isn't done until you've seen it.

---

## User request

The arguments the dispatcher passed — everything after `app` in the invocation.
