# A connector's scope can include others, so a held scope isn't reported refused

## Context

At the OAuth callback the platform records a verdict on each scope in
`auth.scopes` (`classifyGrant` in `src/lib/connectors/scope-status.ts`, into
`connector_scope_status`). A requested scope is Granted if the provider's grant
names it, and Refused if not. The connector dialog shows that verdict on its
Scopes tab, and the Methods tab marks every method needing a Refused scope
"Scope refused".

Some providers grant a broad scope in place of the narrower ones it covers, and
then name only the broad one. Todoist documents `data:read_write` as including
`task:add` and `data:read`. The Todoist connector requests `data:read` always
and `data:read_write` once an admin allows changes. When both are requested,
Todoist's token response lists `data:read_write`, `data:delete` and
`project:delete`, and not `data:read`. The platform then records `data:read`
Refused: the Scopes tab says "Requested but not granted — calls needing this
will be refused", and the Methods tab would mark every read "Scope refused",
though every read works.

The manifest has no way to say that one scope includes another, so the verdict
can't know.

## Decisions

1. **Declared in `connector.json`, on the broader scope's `auth.scopes` entry**:
   `"includes": ["task:add", "data:read"]`, the scopes the provider documents as
   part of it. Optional. It is a fact about the provider, like `description` and
   `access`, so it sits on the entry whatever the entry's `requested` says. It is
   a hand edit, as `requested` is: no provider's page tabulates it.
2. **Connector schema v1 changes in place**, as it did for `registryId` and for
   `telemetry[].scopes`, on the same understanding: no connector has been
   published on mixos.org under v1. On 16 November 2026 mixos.org's catalogue
   lists no extension at all (`GET /api/v1/search` answers `"total": 0`). The
   field is optional, and an existing v1 file stays valid. Its `since` in
   `docs/schemas/index.json` goes back from `"0.9.0"` to `"unreleased"` by hand,
   because MixOS 0.9 and 0.10 read v1 strictly and refuse a file that uses
   `includes`. The next release then stamps itself as v1's first reader, which
   mixos.org reads as the floor for any connector release naming v1.
   `scripts/json-schemas.ts` records it with the earlier exceptions. If a
   connector has been published by the time this merges, this is connector v2
   instead.
3. **The build checks the names.** Each included scope must be in
   `auth.scopes`, listed once, and not the entry's own scope. Nothing is checked
   about its `requested`: Todoist's `task:add` is in `data:read_write`'s list
   and isn't requested.
4. **A scope is held when the grant names it, or names a scope that includes
   it.** Inclusion is followed through: if A includes B and B includes C, a
   grant of A holds C. The including scope needs only to be in the grant, not
   requested by this connector. One pure function, `heldScopes()` in
   `src/lib/connectors/write-policy.ts`, decides it. `classifyGrant` uses it
   for the verdict, and `grantHoldsWriteScopes` uses it for whether a tenant
   grant holds the scopes changes need, so the two can't disagree.
5. **Recorded as Granted, with no new status.** A scope held through another is
   held, and calls needing it work. `connector_scope_status` keeps its three
   values, so there is no migration. As with every verdict, the record is taken
   at the callback: a grant recorded before the connector declared `includes`
   reads Refused until someone connects again. The Todoist connector's release
   note will say so.
6. **What is asked for doesn't change.** Connect asks for each scope as its
   `requested` says, whether or not another requested scope includes it. A
   read-only install must still ask for `data:read`, and dropping a scope from
   the request is a security decision, not a side effect.
7. **The Scopes tab says it.** A scope that another scope includes gets a
   neutral pill, "Included in data:read_write" (the short id, as the rows show it),
   with a tooltip saying that the provider grants it with that scope and may
   name only that scope in the grant. The Granted entry in the key adds "or a
   scope that includes it". The Methods tab reads the recorded verdict, so it
   needs no change.
8. **The scopes refresh keeps `includes`**, as it keeps `requested`.
   `scripts/check-scopes.ts --write` carries each entry's list over, drops a
   name the refreshed catalogue no longer has, and says which.
9. **Method `scopes` are unchanged.** A method still names a scope the
   connector requests; the Todoist reads name `data:read`, and its verdict is
   now right.

## Files

- `src/lib/connectors/types.ts`: `includes?: string[]` on `ConnectorScope`.
- `scripts/manifest-schemas.ts`: the field, and the checks in decision 3.
- `src/lib/connectors/write-policy.ts`: `heldScopes()`; `grantHoldsWriteScopes`
  uses it.
- `src/lib/connectors/scope-status.ts`: `classifyGrant` uses it.
- `scripts/check-scopes.ts`: `merge()` keeps `includes`; exported, and `main()`
  runs only from the command line, so it can be tested.
- `docs/schemas/connector/v1.json`, `docs/schemas/index.json`: regenerated;
  `since` back to `"unreleased"`. `scripts/json-schemas.ts`: the exception
  noted.
- `src/components/admin/connector-configure-dialog.tsx`: the pill and the key.
- `docs/connectors/scopes.md`, `docs/connectors/registry-ux.md`,
  `connectors/AGENTS.md`, `.claude/skills/mixos/actions/connector.md`: the
  field, the rule, and that it is a hand edit the refresh keeps.
- `WHATS-NEW.md`, `docs/plans/README.md`: a line each.
- Tests: the checks (`scripts/manifest-schemas.test.ts`), `heldScopes` and the
  write gate (`src/lib/connectors/write-policy.test.ts`), the Todoist grant
  through `classifyGrant` (`src/lib/connectors/oauth.test.ts`), and the refresh
  (`scripts/check-scopes.test.ts`).

Updating the Todoist connector to declare `includes` is a separate change in
its own repository, once a release carries this.

## Verification

- `npm run typecheck`, `npm run lint`, `npm test`,
  `npx tsx scripts/json-schemas.ts --check`.
- `classifyGrant` on Todoist's catalogue with `includes` declared and the grant
  `data:read_write data:delete project:delete`, with changes allowed: every
  requested scope Granted, `task:add` and `backups:read` Unknown. Without
  `includes`: `data:read` Refused, as today.
- The generator against the templates, unchanged.
