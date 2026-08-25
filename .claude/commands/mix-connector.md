---
description: Create or update a connector under connectors/
argument-hint: <create|update> <connector-name> [notes]
---

You are creating or modifying a connector under `connectors/`.

## Write a plan first (before any code)

For anything beyond a trivial one-line tweak, **write a build plan to `docs/plans/YYYYMMDD_HHMM-<plan-name>.md`** before editing code. Cover: **Context** (why this change), **Decisions** (anything locked with the user), **Structure** (the file-level changes — `connector.json`, `index.ts`), and **Verification** (how you'll prove it works). Get it reviewed when the change is non-trivial. See [`docs/plans/README.md`](../../docs/plans/README.md) for the convention.

## Required reading (do this first, in order)

1. [connectors/AGENTS.md](connectors/AGENTS.md) — hard invariants and the guide index.
2. The four guides it links, in order:
   - [docs/connectors/architecture.md](docs/connectors/architecture.md)
   - [docs/connectors/implementation.md](docs/connectors/implementation.md)
   - [docs/connectors/usage-in-apps.md](docs/connectors/usage-in-apps.md)
   - [docs/connectors/credentials.md](docs/connectors/credentials.md)
   - [docs/connectors/telemetry.md](docs/connectors/telemetry.md) — declaring which connector methods to auto-instrument
3. Authoritative types: [src/lib/connectors/types.ts](src/lib/connectors/types.ts).
4. For reference shape, skim an existing connector such as [connectors/hubspot/](connectors/hubspot/) or [connectors/notion/](connectors/notion/).
5. If updating an existing connector, read its current files before proposing edits.

Do not infer conventions from surrounding code alone, and do not guess based on training data.

## Non-negotiable invariants (from connectors/AGENTS.md)

- Folder name === `name` in `connector.json` (lowercase, hyphens). No leading underscore on shipped connectors.
- Connectors are server-side only. Never import one from client code.
- Credentials flow through `initialize(credentials)` only — no env vars, no hardcoded secrets, no fallbacks. `credentialFields[].key` must match what `initialize()` reads.
- Stateless: no caching across requests.
- `configured` must be `true` only when every required credential is present.
- Never set `lastUpdated` in `connector.json`; never hand-edit `src/generated/connector-registry.ts`.

## Verify before reporting done

1. `npx tsx scripts/generate-project-registry.ts` — confirm the connector appears in the regenerated registry.
2. `npm run typecheck`.
3. Dev server → Administration → Connector Registry. Confirm it renders, save real credentials, and exercise it from a test app API route. Do not claim "done" without actually calling it.

## User request

$ARGUMENTS
