# Build plans

Every non-trivial build **starts with a plan file**, written and ideally reviewed
before any code is written.

Plans live in one of two places, decided by **what the change touches**.

## Where a plan goes

### Co-located — a plan scoped to one app, connector, or theme

```
apps/<slug>/plans/YYYYMMDD_HHMM-<plan-name>.md
connectors/<slug>/plans/YYYYMMDD_HHMM-<plan-name>.md
themes/<slug>/plans/YYYYMMDD_HHMM-<plan-name>.md
```

If the work only changes files under that one folder, its plan belongs inside it.
The plan travels with the code: cloning, converting, or handing off an app carries
its whole design history along with its manifest.

Every app, connector, and theme has a `plans/` directory — including the
`_template` scaffolds, so a newly created one inherits the convention.

### Platform — a plan that changes the OS itself

```
docs/plans/YYYYMMDD_HHMM-<plan-name>.md
```

Anything touching `src/`, `scripts/`, `eslint.config.mjs`, the build, or the
abstractions themselves is a platform plan and stays here — even when it also
ships one app/connector/theme as its worked example.

**The test:** if the change would still be needed with zero apps installed, it is
a platform plan.

Current platform plans:

| Plan | What it changes |
|---|---|
| [`20260824_1935-local-docker-dev.md`](20260824_1935-local-docker-dev.md) | Local Docker dev environment (`docker-compose.yml`, `scripts/`) |
| [`20260824_1959-connector-abstraction.md`](20260824_1959-connector-abstraction.md) | The connector base layer (`src/lib/connectors/`, `connectors/_template/`) |
| [`20260824_2012-app-platform-hardening.md`](20260824_2012-app-platform-hardening.md) | `defineRoute`, the gateway, declared sync, containment |
| [`20260825_2153-theme-abstraction.md`](20260825_2153-theme-abstraction.md) | `themes/` as a first-class abstraction; ships `themes/mixos` as theme one |
| [`20260826_1959-dark-mode-legibility.md`](20260826_1959-dark-mode-legibility.md) | Dark-mode legibility once `data-mode="dark"` became reachable: body ground/ink from tokens, the surface ladder, the palette fence extended to `src/` |
| [`20260826_2041-single-palette-themes.md`](20260826_2041-single-palette-themes.md) | Collapses the theme/mode axes: one palette per theme, `mixos` light by default, `mixos-dark` as a sibling theme |
| [`20260921_0842-release-versioning.md`](20260921_0842-release-versioning.md) | Releases: a release PR, an annotated `vX.Y.Z` tag on `main` and a GitHub Release, through `/mixos deploy release` and `scripts/release-prep.ts`; deployments upgrade by merging the release tag |
| [`20260921_2323-welcome-tour.md`](20260921_2323-welcome-tour.md) | First-run welcome tour: brand takeover, three screens, the lockup-to-menu-bar reveal, and a guide-step framework |
| [`20260922_2234-extension-screenshots.md`](20260922_2234-extension-screenshots.md) | `screenshots/` and a manifest `screenshots` array for apps and themes: build-time verification and measurement, resolved public URLs in the registries |
| [`20260922_2320-extension-dev-instances.md`](20260922_2320-extension-dev-instances.md) | Extensions move to their own repositories, developed inside an installed instance; env-driven compose/Supabase identity so instances can run side by side |
| [`20260923_0041-app-packages.md`](20260923_0041-app-packages.md) | A `packages` manifest field against a platform allowlist, and a closed app import graph enforced by the generator: no per-app `package.json`/`node_modules`, no JS-family source, no relative escapes into `src/`. The import half is superseded by the app import allowlist below |
| [`20260923_0230-app-activation.md`](20260923_0230-app-activation.md) | `apps.is_active` wired up end to end: admin Activate/Deactivate, install-time activation, and the Install / Enable vocabulary |
| [`20261004_2301-login-extensions.md`](20261004_2301-login-extensions.md) | Sign-in extension points: identity providers declared by connectors, veto-only gates, bounded filters and observers for apps, and a hook system able to carry them |
| [`20261005_2150-app-escapes.md`](20261005_2150-app-escapes.md) | `escapes` narrowed to `raw-response` and made load-bearing; app containment (environment, network, HTML sinks, `eval`) enforced by the registry generator; the `Markdown` primitive |
| [`20261005_2201-app-admin-dialog.md`](20261005_2201-app-admin-dialog.md) | The app admin dialog: a Reach tab showing `egress`; per-tool MCP switches, off by default (migration 0014); an Access tab with grants, roles and role filters, the password-gated and public surfaces, and API keys minted, listed and revoked; grants from both pages through shared actions; a role on a global app that is never access (migration 0013); connector readiness by the Connector Registry's rule, the switch included |
| [`20261005_2215-brand-filters.md`](20261005_2215-brand-filters.md) | Brand name, menu-bar logo and login logo as bounded core filters; a declared `hooks.ts` entrypoint; theme `branding` claims that win over apps |
| [`20261005_2209-widget-context-menu.md`](20261005_2209-widget-context-menu.md) | Right-click a dashboard widget for Configure widget and Edit Dashboard, through one shared `ContextMenu` primitive |
| [`20261005_2320-any-postgres-hosting.md`](20261005_2320-any-postgres-hosting.md) | Any Postgres: a query builder in place of supabase-js/PostgREST, a portable migration runner sharing the Supabase CLI's ledger, and hosting on Docker Compose, Render, Railway and Vercel |
| [`20261006_0415-install-flags.md`](20261006_0415-install-flags.md) | `INSTALL_APPS`, `INSTALL_CONNECTORS`, `INSTALL_THEMES`: with one off, that kind's catalogue browse page, button and install actions are gone |
| [`20261007_0153-app-import-allowlist.md`](20261007_0153-app-import-allowlist.md) | App code imports its own files, a published list of platform modules and a few packages, judged by where each import lands and enforced by the registry generator; `callAppRoute` bound to the app's own slug; no writes to shared modules; one policy module read by the build and by ESLint |
| [`20261007_0158-contain-app-migrations.md`](20261007_0158-contain-app-migrations.md) | A schema and a role per app, app migrations checked by Postgres's parser against an allowlist and applied as the app's role, and a platform `updatedAt` trigger in place of app triggers |
| [`20261008_2300-extension-lifecycle.md`](20261008_2300-extension-lifecycle.md) | The extension lifecycle and MixOS's own updates: installs checked without running and held in `.mixos/pending/` until Register, data kept when an app leaves the build, activation and connector switches, update and removal, an update check against mixos.org, a stamped build, releases and their notices, a maintenance response, and a GitHub App that proposes pull requests |
| [`20261015_2343-remix.md`](20261015_2343-remix.md) | Remix (built; phase 3 in mixos.org): `/mixos remix` abstracts a component of an installed app into a card — needs, gives, actions, hidden rules, interactions — asks Same, Different or Remove per action, builds it into another app, and records provenance that mixos.org counts for the source's creator |
| [`20261020_0728-connector-contracts.md`](20261020_0728-connector-contracts.md) | A connector mirrors its provider's API; an admin allows each connector's writes per install, and an app declares `"access": "write"` to use them; a required `version` in `connector.json`, a version an app names on its entry, and a contract that only adds within a major version, checked at build, install, update, commit and publish |
| [`20261025_2116-release-notes.md`](20261025_2116-release-notes.md) | Release notes: `release-notes.json` beside each extension's manifest and at the root for MixOS, checked by the build and at install; a gift icon in the menu bar with the last 14 days' notes for each person's own apps, connectors and theme, seen state per person (migration 0002), and App Manager's Release Notes page |
| [`20261110_0018-slug-ids.md`](20261110_0018-slug-ids.md) | Slug ids and manifest versions: mixos.org mints an 8-character id at the end of every new listing's slug; `npm run rename` and the `extension-renames.json` ledger carry an extension's data to its new slug; Wall·E, `mixos` and `mixos-dark` renamed; a required `$schema` URL in every extension JSON file, published on mixos.org and recorded per release |
| [`20261114_0947-registry-id.md`](20261114_0947-registry-id.md) | `registryId` in `app.json`, `connector.json` and `theme.json`: the install name, minted by `npm run new` when an extension is created, required by schema v1 (changed in place), equal to the folder at build and install; mixos.org reads it instead of minting and keeps it with the repository that first listed it |
| [`20261115_1111-connector-method-scopes.md`](20261115_1111-connector-method-scopes.md) | Each `telemetry` entry in `connector.json` may name the scopes its method needs, checked against `auth.scopes` (connector v1, changed in place); a read needing a write-requested scope warns; a Methods tab in the connector dialog shows each method with its scopes' verdicts |
| [`20261115_2330-welcome-tour-finale.md`](20261115_2330-welcome-tour-finale.md) | The welcome tour's guide steps removed: the takeover's collapse ends the tour, the "is yours" card names apps, connectors and themes, and I'm ready bursts the confetti from the button to spell the brand name across the screen |
| [`20261116_0020-route-loaders.md`](20261116_0020-route-loaders.md) | App API routes load through a generated, server-only map of explicit imports (`src/generated/app-route-loaders.ts`) in place of a template import, so a route added under `next dev` answers once `npm run registry` has run; the gateway and `callAppRoute` share one loader that tells a missing route from one that throws at load |
| [`20261116_0021-scope-includes.md`](20261116_0021-scope-includes.md) | An `auth.scopes` entry may list the scopes it `includes` (connector v1, changed in place); a grant naming it holds them, so the verdict at the OAuth callback and the write gate stop reporting a held scope refused; the Scopes tab says "Included in" |
| [`20261116_0722-extension-loaders.md`](20261116_0722-extension-loaders.md) | App MCP tools, search handlers, syncs, jobs and services load through generated, server-only maps of explicit imports, one per kind (`src/generated/app-{mcp-tool,search,sync,job,service}-loaders.ts`), in place of template imports, as routes do; one shared loader, with routes, keeps a missing handler apart from one that throws at load; the `ignoreIssue` rule narrows to connectors |
| [`20261121_1400-global-search.md`](20261121_1400-global-search.md) | Global search: a `search` manifest field with `search/<name>.ts` handlers run read-only through a broker, one `/api/search` endpoint, the ⌘K modal and menu-bar icon, and a Search page in My Account backed by `user_search_preferences` (migration 0003) |
| [`20261122_1059-connector-loaders.md`](20261122_1059-connector-loaders.md) | A connector's `index` loads through a generated, server-only map of explicit imports (`src/generated/connector-loaders.ts`) in place of a template import, for the app context, Verify connection and webhooks; one loader tells a connector missing from the map from one that throws at load; the `ignoreIssue` rule in `next.config.ts` goes |
| [`20261122_1152-app-tailwind-sources.md`](20261122_1152-app-tailwind-sources.md) | The registry generator names every registered app's folder as a Tailwind source (`src/generated/app-sources.css`, imported by `globals.css`), so a class only an app uses is generated even where git ignores the app, as a core clone's `core-excludes` block does |
| [`20261127_1649-runtime-isolation-hardening.md`](20261127_1649-runtime-isolation-hardening.md) | Runtime isolation between apps, so a malicious or compromised app is contained by the runtime and not only by build checks: frozen `context` and a connector facade, a public threat model, every app query run as the app's Postgres role, connector blast radius and per-app credentials, secrets out of app code's reach, review before a Registry app runs, per-app detection, connectors out of process, capability approvals, an escape-test suite and a Reach page, and verified publishers |
| [`20261128_0128-secrets-out-of-process.md`](20261128_0128-secrets-out-of-process.md) | Secrets out of the app process (proposed, design only): a key service (not recommended), a connector gateway that holds credentials and runs connector methods for apps' stubs, and apps out of process; T3b and T3c to be designed with 5b and 7b |

## File naming

```
YYYYMMDD_HHMM-<plan-name>.md
```

- `YYYYMMDD_HHMM` — the local timestamp when the plan was started (e.g.
  `20260630_0834`). This keeps plans sorted chronologically within their folder.
- `<plan-name>` — a short kebab-case slug for the work (e.g. `roadshows-app`).
  [`/mixos deploy`](../../.claude/skills/mixos/actions/deploy.md) derives the branch name
  from this slug.

## What a plan contains

Keep it scannable but executable:

- **Context** — why this change is being made: the problem, what prompted it,
  the intended outcome.
- **Decisions** — anything locked with the user (choices, tradeoffs, constraints).
- **Structure** — the file-level changes: manifest, migrations, API routes,
  pages/widgets (or `connector.json` / `index.ts` for a connector, `theme.json` /
  `theme.css` / `assets/` for a theme). Reference existing utilities to reuse,
  with paths.
- **Verification** — how the change is proven end-to-end (generate registry,
  typecheck, migrate, run the app, smoke-test its routes).

**Never put a secret value in a plan file** — record only the *name* of a setting
and where it belongs. Plan files are committed.

## A plan for something that does not exist yet

A `plans/` directory may precede its subject — write the plan where the thing will
live, then build it there. A folder holding only `plans/` and no manifest is a
legitimate state: the registry reports it as *planned, not yet built* and skips it
rather than warning. `/mixos convert` relies on this, creating `apps/<slug>/plans/`
in Phase 1 and nothing else until the plan is approved.

## Referenced by

[`/mixos app`](../../.claude/skills/mixos/actions/app.md),
[`/mixos connector`](../../.claude/skills/mixos/actions/connector.md),
[`/mixos theme`](../../.claude/skills/mixos/actions/theme.md),
[`/mixos convert`](../../.claude/skills/mixos/actions/convert.md),
[`/mixos deploy`](../../.claude/skills/mixos/actions/deploy.md),
[`apps/AGENTS.md`](../../apps/AGENTS.md),
[`connectors/AGENTS.md`](../../connectors/AGENTS.md),
[`themes/AGENTS.md`](../../themes/AGENTS.md).
