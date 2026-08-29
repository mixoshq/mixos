# RLS coverage backstop, and rewriting the security docs

## Context

Two problems, found by auditing `docs/security-architecture.md` and
`docs/secure-edge-gateway-architecture.md` against the code.

**1. The RLS rule is enforced by a hand-maintained list, and the list rotted.**

`supabase/migrations/0001_initial.sql` states the rule in its own header: RLS is
enabled on every table with zero policies, because Supabase publishes `public`
through PostgREST to the `anon` role and the anon key is publishable, not secret.
A table with RLS off is world-readable to anyone holding it.

The header even records that `connector_webhook_events` "previously shipped
without it — the one table that missed the rule". The fix at the time was to add
it to a hardcoded `foreach t in array array[...]` list. That list is the defect:
it has to be edited by hand every time a table is added, and three tables have
since been added without it.

| Table | Holds | Where |
| --- | --- | --- |
| `user_connector_oauth` | **per-user encrypted OAuth grants** — live third-party account access | 0001:170 |
| `connector_scope_docs` | fetched scope documentation | 0001:330 |
| `connector_scope_status` | per-connector scope state | 0002:12 |

`user_connector_oauth` is the serious one. It is the table the per-user connector
work introduced, it stores `encrypted_credentials` per `(user_id, connector_name)`,
and it is what a Gmail grant lands in.

**2. App-owned tables never get RLS at all.**

`scripts/migrate.ts` applies `apps/<slug>/migrations/*.sql` with table names
rewritten to the `_app_<slug>_` prefix. It emits `enable row level security` in
exactly one place — line 153, for the platform-owned `__sync_state` table. Tables
created by an app's own migration get none. So `_app_career_profile` and
everything like it is readable through PostgREST today.

The security doc asserts the opposite ("RLS is **enabled on every table**"), which
is how this stayed invisible: the claim was true of the 22 platform tables the
author checked and false of every app table.

**3. Both security docs are substantially out of date.**

Audit result: 193 claims verified correct, ~44 confirmed inaccurate.
`security-architecture.md` is mostly sound with a few stale claims, two of which
invert a security fact (`key` tier "has no implementation"; "no platform-level
SSRF defence"). `secure-edge-gateway-architecture.md` describes the pre-dispatcher
gateway throughout and teaches a route shape that fails the build.

## Decisions

| Decision | Choice |
| --- | --- |
| How RLS is enforced | replace the hardcoded list with a **query-driven sweep** over `public` |
| Recurrence | the sweep is the mechanism, so adding a table cannot miss it |
| Extension tables | excluded via `pg_depend.deptype = 'e'` |
| Already-deployed DBs | no new migration — the platform schema has never been deployed (0001 header), and `migrate.ts` re-sweeps on every run |
| App tables | `migrate.ts` runs the same sweep after applying app migrations |
| Doc A | edit in place — it is structurally sound |
| Doc B | rewrite — the gateway it describes no longer exists |

**Why a sweep rather than adding three names to the list.** Adding the names
fixes today's three tables and leaves the mechanism that produced them. The rule
is "every table in `public`", so the enforcement should be a query for "every
table in `public`", not a transcription of one.

## File-level changes

- `supabase/migrations/0001_initial.sql` — replace the `foreach t in array
  array[...]` block with a catalog-driven `for ... in select ... from pg_class`
  sweep; skip tables that already have `relrowsecurity`, and extension-owned
  tables. Update the header note to describe the sweep.
- `supabase/migrations/0002_connector_scope_status.sql` — add the missing
  `enable row level security` so a fresh install is correct without relying on
  the backstop.
- `scripts/migrate.ts` — add `hardenRowLevelSecurity(sql)`, the same sweep,
  called from `main()` after `migrateApps()`. Covers app-created tables and
  backstops the platform schema in local dev. Logs each table it hardens.
- `docs/security-architecture.md` — correct §1 (gateway diagram, `key` tier),
  §3.1/§3.2/§3.4, §4 table rows, §7, §8, §13, §15; add sections for the surfaces
  neither doc covers.
- `docs/secure-edge-gateway-architecture.md` — rewrite against `dispatch.ts`,
  `auth-tier.ts`, `defineRoute`, and both mounts.

Added after the audit landed, from findings in the same pass:

- `src/lib/apps/csrf.ts` + `dispatch.ts` step 9 — the SDK had always sent
  `X-CSRF-Token` and nothing read it. Verify the Auth.js double-submit cookie
  (hash first, then header), scoped to the authenticated mount and identity
  tiers so API keys and `callAppRoute` are unaffected.
- `supabase/migrations/0003_app_unlock_failures.sql` +
  `src/lib/apps/unlock-rate-limit.ts` — move the app-password lockout off the
  in-process `Map` onto a shared table, keeping the map as a pre-filter. Same
  two-tier shape and fail-open posture as `rate-limit.ts`.
- Stale `key`-tier comments in `dispatch.ts` and the public mount header.

## Verification

1. `grep` every `create table` across `supabase/migrations/*.sql` and diff
   against tables with `relrowsecurity` after a fresh `npm run db:local`.
2. `npx tsx scripts/migrate.ts` twice — second run must report nothing to harden
   (idempotent).
3. Confirm `_app_career_*` tables come back with `relrowsecurity = true`.
4. `npm run typecheck`.


---

## Follow-on: posture hardening (same day)

Six further changes, from the audit's second pass and the review that followed it.

### 1. Six independent cryptographic keys

`CONNECTOR_ENCRYPTION_KEY` was five secrets wearing one name: it encrypted tenant
connector credentials AND per-user OAuth grants AND app settings, and derived the
MCP token HMAC, the app API key HMAC and the unlock cookie key. The PRF
separation was sound; the un-rotatability was not. Split into six env vars
inventoried in `src/lib/env/keys.ts`, each with its blast radius written next to
it, no derivation fallback. `scripts/generate-keys.ts` enumerates the inventory
so it cannot drift. `npm run keys:generate` / `keys:check`, wired into
`/mix-init`.

**A sixth consumer turned up mid-change** — `src/lib/apps/env.ts` encrypts
`password`-typed app settings under the same key — so the split is six, not five.

### 2. swr-cache user-scoping guardrail

`userScoped` is a **required** option, so the decision is made in writing rather
than defaulted into a leak. When true, `userId` is folded into the stored key and
the in-process coalescing key, and omitting it throws. The coalescing map was the
sharper edge: a miss there hands a concurrent caller another person's build with
no row written.

### 3. Nonce-based CSP

`script-src 'self' 'nonce-…' 'strict-dynamic'` from `src/proxy.ts`, replacing the
static `frame-ancestors`-only header (removed from `next.config.ts` — two CSP
headers intersect rather than merge). HSTS added. Cost recorded in §14: every
page is now dynamically rendered.

### 4. Admin audit trail

`public.admin_audit_log` (migration 0004) + `src/lib/apps/admin-audit.ts`.
Separate from `telemetry_events` because that table's `user_id` is
`on delete set null`, and an audit trail that forgets the actor on offboarding is
not one. `actor_email` is denormalised to survive deletion. Nine actions
instrumented.

### 5. Two ESLint holes, found by the audit and verified independently

- `@/lib/apps/scoped-db` was restricted **nowhere**, so any app file could write
  `createScopedClient("other-app").table("secrets")` — the `_app_` prefix bounds
  the table name, never the app. Now restricted by NAME in all three tiers, so
  `import type { ScopedClient }` still works.
- ESLint flat config **replaces** a rule's options rather than merging them, so
  the `pages/**` + `widgets/**` block silently overrode the `apps/**` one and
  omitted `@/lib/apps/context` — making the most client-facing tier the only one
  able to import the server context builder.

### 6. CI lint is blocking

It was `continue-on-error: true` for 10 pre-existing react-hooks errors that have
since been fixed. Every import restriction above was advisory until now; §3.3's
"Build fails on violation" is finally true.

## Verification

Unit/integration suites written and run against throwaway Postgres 16 containers:
17 key-independence, 19 swr-cache, 10 admin-audit, plus the earlier 21+6 unlock
and 18 CSRF. All four migrations apply in order: 26 tables, zero without RLS.
CSP verified live — 36-42 script tags per page, 100% nonce coverage, CSRF flow
intact.


---

## Follow-on 2: the remaining backlog

### 7. Dependency supply chain — the urgent one

Nothing had ever run `npm audit`. First run: **11 advisories, 2 critical and 6
high, both criticals in the auth library**. Upgraded `next-auth` beta.31 →
beta.32, `next` 16.2.3 → 16.3.3, `sharp` 0.34.5 → 0.35.4, plus `npm audit fix`
for transitives. **11 → 1**, and that one is `esbuild` under `tsx` (dev only).

Exposure to the fail-open advisory was limited by luck: MixOS's single `auth()`
call site guards on `session?.user?.id`, a nested field, not the truthiness of
the session object. Nothing required it to be written that way.

`npm audit --audit-level=high` added to CI as a blocking step — the finding was
not that a version was vulnerable but that nobody was looking.

### 8. JWT session revocation

`users.session_version` (migration 0006), minted into the token and compared on
**every** session resolution. Bumped on password change and by
`revokeUserSessionsAction` (audited). The `jwt` callback now re-reads the row per
request, which also makes `is_admin` demotion immediate everywhere rather than
only inside `requireAdmin()`.

Increment is an atomic `security invoker` RPC so concurrent revocations cannot
collapse into one; EXECUTE revoked from `anon`/`authenticated`. Fails closed on a
missing row, open on a query error.

### 9. MCP connector mutation — already done

Found already implemented in the working tree: `telemetry[].mutates` plus
`readOnlyConnectors()` in the MCP broker, and — better than proposed — an
AST-based generator check that fails the build if any public connector method is
undeclared, closing the "an undeclared method is invisible" hole. Verified both
halves; no change needed.

## Notes

- A migration number collision appeared mid-session (`0005_app_schema_columns`
  landed alongside this branch's work). Renumbered to 0006. Nothing guards
  against duplicate prefixes — worth a check in the pre-commit hook.
