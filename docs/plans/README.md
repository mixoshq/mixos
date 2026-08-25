# Build plans

Every non-trivial build (a new app, a new connector, or a substantial change to
either) **starts with a plan file in this folder**, written and ideally reviewed
before any code is written.

## File naming

```
docs/plans/YYYYMMDD_HHMM-<plan-name>.md
```

- `YYYYMMDD_HHMM` — the local timestamp when the plan was started (e.g.
  `20260630_0834`). This keeps plans sorted chronologically.
- `<plan-name>` — a short kebab-case slug for the work (e.g. `roadshows-app`).

## What a plan contains

Keep it scannable but executable:

- **Context** — why this change is being made: the problem, what prompted it,
  the intended outcome.
- **Decisions** — anything locked with the user (choices, tradeoffs, constraints).
- **Structure** — the file-level changes: manifest, migrations, API routes,
  pages/widgets (or `connector.json` / `index.ts` for connectors).
  Reference existing utilities to reuse, with paths.
- **Verification** — how the change is proven end-to-end (generate registry,
  typecheck, migrate, run the app, smoke-test connectors).

This convention is referenced by [`/mix-app`](../../.claude/commands/mix-app.md),
[`/mix-connector`](../../.claude/commands/mix-connector.md),
[`apps/AGENTS.md`](../../apps/AGENTS.md), and
[`connectors/AGENTS.md`](../../connectors/AGENTS.md).
