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
| [`20260921_0842-release-versioning.md`](20260921_0842-release-versioning.md) | Version tags and `MIXOS_RELEASE` on Vercel via a release-PR flow; restores `/mixos deploy release` |
| [`20260921_2323-welcome-tour.md`](20260921_2323-welcome-tour.md) | First-run welcome tour: brand takeover, three screens, the lockup-to-menu-bar reveal, and a guide-step framework |
| [`20260922_2234-extension-screenshots.md`](20260922_2234-extension-screenshots.md) | `screenshots/` and a manifest `screenshots` array for apps and themes: build-time verification and measurement, resolved public URLs in the registries |

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
  typecheck, migrate, run the app, smoke-test connectors).

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
