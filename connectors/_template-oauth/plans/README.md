# Plans for this connector

Build plans scoped to this connector live here, one file per piece of work:

```
YYYYMMDD_HHMM-<plan-name>.md
```

Write one **before** editing code for anything beyond a trivial tweak. Cover
**Context** (why), **Decisions** (anything locked with the user), **Structure**
(`connector.json`, `index.ts`, auth strategy, methods), and **Verification** (how you'll prove it works).

Keeping plans beside the `connector.json` means the design history travels with the
connector — a clone, a conversion, or a handoff carries both.

A change that touches the platform itself (`src/`, `scripts/`, the build) is a
**platform plan** and belongs in [`docs/plans/`](../../../docs/plans) instead.

Full convention: [`docs/plans/README.md`](../../../docs/plans/README.md). Command: [`/mixos connector`](../../../.claude/skills/mixos/actions/connector.md).
