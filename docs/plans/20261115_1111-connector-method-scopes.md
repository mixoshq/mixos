# Each connector method names the scopes it needs, and a Methods tab shows them

## Context

A connector's dialog says what apps can call on its Details tab: a count, and
behind **Show methods** a list of each method, the provider operation it calls,
and whether it changes data. Its Scopes tab says which of the provider's
documented scopes the connector asks for, and whether the provider granted
each. Nothing joins the two. An admin who sees a refused scope can't tell which
methods it breaks, and one whose app fails a call can't tell which scope it
was missing.

The manifest carries both halves already, `telemetry` (the methods) and
`auth.scopes` (the catalogue, with `requested`), but not the link between them.

## Decisions

1. **Declared in `connector.json`**, on each `telemetry` entry:
   `"scopes": ["https://www.googleapis.com/auth/spreadsheets.readonly"]`. The
   method needs every scope it lists. A provider's reference often says "one of
   the following"; the entry names the one, of those this connector requests,
   that it relies on. Optional: a method without it shows its scopes as not
   declared, and a connector that authenticates with nothing has none.
2. **Connector schema v1 changes in place**, as it did for `registryId`, on the
   understanding that no connector has been published on mixos.org under v1
   since 0.8.0. Its `since` goes back to `"unreleased"` by hand, so the next
   release stamps itself as its first reader. If one has been published, this
   is connector v2 instead.
3. **The build checks the names.** Each listed scope must be in `auth.scopes`,
   listed once, and requested (`true` or `"write"`): a method needing a scope
   the connector never asks for could never be called, and a name not in the
   catalogue is a typo. A connector with `auth.strategy` `"none"` lists none.
4. **A read that needs a scope requested only once changes are allowed is a
   warning, not an error.** It can be the truth: Google Sheets'
   `spreadsheets.getByDataFilter`, `values.batchGetByDataFilter` and both
   `developerMetadata` reads accept only `drive`, `drive.file` or
   `spreadsheets`, never `spreadsheets.readonly`. Refusing the declaration would
   only hide that those reads fail on a read-only install; the warning and the
   Methods tab say so instead.
5. **A Methods tab** in the connector dialog, between Configure and Scopes,
   replaces Show methods. Each row: the method, its operation, its description,
   whether it changes data (and, when it does, that it is off while the
   connector is read-only), and each scope it needs with the Scopes tab's
   verdict for it: granted, refused, or not asked for on this install. The
   Details tab keeps its one-line summary, with a link to the tab.
6. **The contract doesn't change.** `scopes` is not part of what an app calls,
   so `check-connector-contract.ts` compares methods and `mutates` as before,
   and declaring scopes needs no new version.

## Files

- `src/lib/connectors/types.ts`: `scopes?: string[]` on
  `ConnectorTelemetryDefinition`.
- `scripts/manifest-schemas.ts`: the field, and the checks in decision 3.
- `scripts/generate-project-registry.ts`: the warning in decision 4.
- `docs/schemas/connector/v1.json`, `docs/schemas/index.json`: regenerated;
  `since` back to `"unreleased"`. `scripts/json-schemas.ts`: the exception noted.
- `src/components/admin/connector-configure-dialog.tsx`: the Methods tab.
- `connectors/_template-oauth/connector.json`: scopes on its two methods.
- `connectors/AGENTS.md`, `docs/connectors/telemetry.md`, `scopes.md`,
  `registry-ux.md`, `architecture.md`: the field and the tab.
- Tests: the checks, and the warning.

## Verification

- `npm run typecheck`, `npm run lint`, `npm test`, `npx tsx scripts/json-schemas.ts --check`.
- The generator against the templates, and against a checkout whose Gmail and
  Google Sheets connectors declare their scopes: Sheets' four data-filter and
  developer-metadata reads warn.
- The Methods tab on a running dev server, for a connector with scopes
  declared, one without, and one read-only with a read that needs a write scope.
