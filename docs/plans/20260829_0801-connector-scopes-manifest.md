# Connector scopes in the manifest; grant status in the database

## Context

"What this connector offers" is assembled at render time from three places: the
provider's scope page (scraped at an admin's request, cached in
`connector_scope_docs`), `auth.scopes` in the manifest, and `oauth_scope` on the
live grant. The per-scope verdict — Granted / Refused / Unknown — is computed in
the component and exists only for the length of a render.

Two things are wrong with that shape.

**The catalog is deployment state.** What a connector can do is a property of the
connector, but today it lives in a database row that an admin populated by
pressing a button. It differs between installs, never appears in a diff, and
nobody reviews it. A provider reshaping their HTML degrades it silently.

**The verdict is not recorded anywhere.** The single case the feature exists for
— a manifest that grew a scope while every already-authorized install keeps
running on the older, narrower grant — is visible only if somebody happens to
open the dialog.

So: move the catalog into `connector.json`, where it travels with the code and
shows up in review, and write the verdict to the database at the one moment it
can actually change.

## Decisions

Locked with the user:

| # | Decision | Consequence |
| --- | --- | --- |
| 1 | `auth.scopes` becomes **one array of objects**, each flagged `requested` | Breaking manifest change. `buildAuthorizeUrl` and `mintToken` filter on the flag |
| 2 | Status is a **snapshot written at the OAuth callback** | New table; accurate by construction, since the callback is the only place a grant changes |
| 3 | Refresh is **fully dev-time** | Retires the runtime fetch, the server action, the Refresh button and `connector_scope_docs` |
| 4 | **Scopes** becomes its own tab in the admin dialog; `scopes.md` is registered in the guide | `details \| configure \| scopes \| logs` |

Derived from those, with the evidence:

### 5. `requested` is explicit, never inferred

An entry is `{ scope, description?, access?, requested }`. `requested` is
**required**, not defaulted to true: the array is machine-written by the scopes
refresh and will contain far more entries than a connector asks for, so a
missing flag defaulting to "yes" would silently request the provider's entire
catalogue. A hand-authored template entry writing `"requested": true` costs one
line and removes the question.

### 6. `scope-docs.ts` splits rather than being deleted

The module is two things bolted together. The pure half — `classifyScope`,
`parseScopeDocs`, `fetchScopeDocs`, and the `ScopeAccess` / `DocumentedScope`
types — is exactly what the dev-time refresh needs and is kept. The DB half —
`getScopeDocs`, `refreshScopeDocs`, `coerceScopes` — has no reader once the
catalog lives in the manifest, and goes.

The classification rules keep earning their comments: verbs detected
independently rather than as phrases, and `add(?!-)` so the pattern does not
match inside "add-on". Both bugs were silent over-reports.

### 7. A new migration, not an edit to `0001`

`0001_initial.sql` was squashed and **pushed** on `feat/platform-foundation`.
Rewriting it now would mean rewriting published history, so the table change
lands as `0002_connector_scope_status.sql`, which also drops
`connector_scope_docs`.

### 8. The status table carries `user_id`, nullable

This is the one decision not covered by the four answers, and getting it wrong
would need a second migration to undo.

The platform now supports `userScoped` connectors, where the grant lives in
`user_connector_oauth` **keyed by user** while the client credentials stay
tenant-wide. For such a connector there is no single answer to "was this scope
granted" — each person has their own. A table keyed on `connector_name` alone
literally cannot represent that, and would report one user's refusal as
everybody's.

So the key is `(connector_name, user_id, scope)` with `user_id` **null for a
tenant-wide grant**. Postgres will not put nulls in a primary key, so uniqueness
is enforced with a matched pair of partial unique indexes instead. Tenant-scoped
connectors write one row set with `user_id IS NULL` and read exactly as the user
asked for; user-scoped ones get a row set per person for free.

### 9. `unknown` rows are stored even though they are derivable

`unknown` means "the provider documents it, this connector never asks" — which
follows from the manifest alone. Storing it is redundant, and it is what was
asked for. It also makes a row set a **complete snapshot of what the tab
renders**, so the tab reads one table rather than joining a table against the
manifest and re-deriving the third state.

## Structure

### Schema — `supabase/migrations/0002_connector_scope_status.sql`

```sql
create table public.connector_scope_status (
  connector_name text not null,
  user_id        uuid references auth.users(id) on delete cascade,  -- null = tenant grant
  scope          text not null,
  status         text not null check (status in ('granted','refused','unknown')),
  recorded_at    timestamptz not null default now()
);
-- Null user_id cannot sit in a PK, so uniqueness is a matched pair.
create unique index ... on (connector_name, scope) where user_id is null;
create unique index ... on (connector_name, user_id, scope) where user_id is not null;

drop table if exists public.connector_scope_docs;
```

### Manifest — `scripts/manifest-schemas.ts`, `src/lib/connectors/types.ts`

`auth.scopes` moves from `z.array(z.string())` to an array of
`{ scope, description?, access?, requested }`. `scopesUrl` is unchanged — it is
still where the refresh reads from, just at dev time now.

### Base layer — `src/lib/connectors/`

| File | Change |
| --- | --- |
| `oauth.ts:171` | `buildAuthorizeUrl` filters to `requested` before joining |
| `http-connector.ts:636` | `mintToken` does the same for client-credentials |
| `scope-docs.ts` | Keep the parser/fetcher/classifier; delete `getScopeDocs`, `refreshScopeDocs`, `coerceScopes` |
| `scope-status.ts` **(new)** | `recordScopeStatus()` — diff manifest scopes against a granted set, upsert one row per scope; `getScopeStatus()` for the tab |

### OAuth callback — `src/app/api/connectors/[name]/oauth/callback/route.ts`

After the token exchange writes `oauth_scope`, call `recordScopeStatus()` with
the connector name, the granted set, and the user id when the connector is
`userScoped`. A failure here must **not** fail the callback — the grant is the
thing that matters and it is already stored; the snapshot is reporting.

### Admin UI — `src/components/admin/connector-configure-dialog.tsx`

- `DialogTab` gains `"scopes"`; tab order `details | configure | scopes | logs`.
- The "What this connector offers" section moves wholesale to the new tab,
  keeping its inline Granted / Refused / Unknown key.
- The Refresh button, `refreshError` state, `refreshScopeDocsAction` prop and
  the `read <n> ago` / `last_error` lines all go.
- Verdict now comes from `connector_scope_status`, not from `scopeVerdict()`
  over three in-memory lists.
- The API-key note stays on `details` — not selected for the move.
- `src/app/(main)/admin/connectors/page.tsx` drops `refreshScopeDocsAction` and
  the `getScopeDocs` import; `connector-registry-list.tsx` drops the prop.

### Dev-time refresh — `scripts/check-scopes.ts` + `/mixos connector`

`check-scopes.ts` keeps its read-only report and gains `--write`, which fetches
`auth.scopesUrl`, parses, preserves the `requested` flags already in the
manifest, and rewrites `auth.scopes` in place. `.claude/skills/mixos/actions/connector.md`
gains a **Scopes refresh** section documenting `npx tsx scripts/check-scopes.ts
<connector> --write`, that it is the only way the catalog changes, and that the
diff is the review.

### Docs

- `docs/connectors/scopes.md` — already made provider-agnostic. Still needs its
  "Cache, not source of truth" section rewritten for the manifest model, and the
  authoring paragraph updated to say the refresh writes the manifest.
- `src/components/connectors/connector-guide-tabs.tsx` — register `scopes.md`
  (and `registry-ux.md`, written and committed but never added to `TABS`).
- `connectors/AGENTS.md` — note the new `auth.scopes` shape in the invariants.

### Manifests

`connectors/gmail/connector.json` and `connectors/_template-oauth/connector.json`
are the only two declaring scopes. Both convert to the object form; Gmail's is
then regenerated with `--write` so it carries the real catalogue.

## Verification

1. `npx tsx scripts/generate-project-registry.ts` — both manifests pass the new
   strict schema; a bare-string `scopes` array is rejected with a message
   pointing at the path.
2. `npm run typecheck`, `npm run lint`, `npm run build`.
3. `npm run db:local` applies `0002`; confirm `connector_scope_docs` is gone and
   both partial unique indexes exist.
4. `npm run verify:connectors` — the OAuth strategies still send the right
   `scope` parameter, now filtered on `requested`.
5. `npx tsx scripts/check-scopes.ts gmail` reports; `--write` rewrites
   `auth.scopes` and the diff is reviewable. Run it twice — the second run must
   be a no-op, proving `requested` flags survive a refresh.
6. Registry → a connector row → **Scopes** tab renders the catalogue with the
   three states and no Refresh button.
7. Press Connect and confirm rows appear in `connector_scope_status` with
   `user_id IS NULL`; unticking a permission on the consent screen produces
   `refused` rather than a missing row.
8. `/connectors/guide` shows the Scopes and Registry UX tabs.
