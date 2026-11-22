# Connector loaders: one explicit import per connector

**Status:** built on 22 November 2026, on branch `fix/connector-loaders`. All of these pass:
`npm test` (2053 tests against a throwaway Postgres 17, none skipped), `npm run typecheck`,
`npm run lint`, and the live check under Verification.

**Scope:** platform. The registry generator (`scripts/generate-project-registry.ts`, plus a new
`scripts/connector-loaders.ts`), a new generated file `src/generated/connector-loaders.ts`, a new
loader (`src/lib/connectors/loader.ts`, with its key rule in
`src/lib/connectors/connector-modules.ts`), its three callers, the `turbopack.ignoreIssue` rule in
`next.config.ts`, and the fixtures of four database-backed suites.

## Context

[`20261116_0020-route-loaders.md`](20261116_0020-route-loaders.md) and
[`20261116_0722-extension-loaders.md`](20261116_0722-extension-loaders.md) replaced the
template-literal imports that loaded app code with generated maps of explicit imports. A template
import is resolved by Turbopack against the files on disk when the importing module compiles, and
is not always resolved again when a file is added under `next dev`.

Connectors were left out of that work, and they are the last template imports:

| Caller | What it does with the connector |
|---|---|
| `buildAppContext` in `src/lib/apps/context.ts` | Hands an app its declared connectors |
| `runConnectorTest` in `src/lib/connectors/test-connection.ts` | Verify connection, in the admin's Configure wizard |
| `POST` in `src/app/api/webhooks/[name]/route.ts` | Runs a connector's webhook handler |

Each does the same three lines: ``import(`@connectors/${name}/index`)``, take the default export
or else the first exported function, and construct it. Each does it inside a larger `try` with its
own error handling.

They are also the only reason `next.config.ts` keeps its `ignoreIssue` rule. A checkout with no
connectors, which is most of them, has a template that matches nothing, and Turbopack warns
"Module not found" on every compile.

## Decisions

1. **The same pattern as the app maps.** The generator writes `src/generated/connector-loaders.ts`:
   a `connectorLoaders` map keyed `<name>/index`, one explicit `import("@connectors/<name>/index")`
   each. The key is the import specifier without `@connectors/`, so a log line names the file.
   No extension is given, so `.ts` and `.tsx` both resolve, as before. One map holds every
   connector, as the template's context did: each caller can be handed any of them.
2. **Built from the registered connectors that have an index file.** The generator doesn't
   require `index.ts`, and a literal import of a file that isn't there fails the build, where the
   template only failed at runtime. So a registered connector gets an entry only when
   `index.ts` or `index.tsx` is on disk. One without either gets none, and loading it is
   "missing", as it failed before. Making the generator refuse such a connector is a stricter
   rule than this change needs.
3. **Server only, in its own file.** It isn't in `connector-registry.ts`, which client components
   import. Its one consumer is `src/lib/connectors/loader.ts`.
4. **One loader for the three callers.** `constructConnector(name)` loads through `loadFromMap`
   (`src/lib/apps/module-map.ts`), picks the class exactly as the callers did, and constructs it.
   A key missing from the map, or a module that throws at load, is a `ConnectorLoadError` with
   `reason` `missing` or `failed`. Its message says which: "not in the generated connector map,
   run `npm run registry`", or "failed to load" with the module's error as its `cause`. A module
   with nothing to construct throws as it did, a `TypeError`.
5. **Each caller answers as before, with one exception.** Each keeps its `try`, so a load error
   lands where an import error did:
   - `buildAppContext` leaves the connector out and logs `failed to load` with the error, as
     today. The error now says which of the two it was.
   - The webhook route releases the delivery's claim and answers 500, so the provider retries,
     as today. It logs the load error as such, not as "handler threw".
   - **Verify connection is the exception.** Today a load failure goes through
     `connectorErrorEnvelope`, which shows the admin "Something went wrong" and logs only
     `internal_error`. A connector missing from the map now gets the answer the function already
     gives a connector missing from the registry: `unsupported`, with "Regenerate the registry
     (npm run registry) and reload." A module that throws at load keeps today's answer, and both
     are logged with the error.
6. **The `ignoreIssue` rule goes.** With no template import left under `@apps/` or
   `@connectors/`, nothing in `src/` should warn "Module not found" for a `<dynamic>` request.
   If one comes back, the warning is right.

## Structure

- `src/lib/connectors/connector-modules.ts` (new, pure): `connectorLoaderKey(name)`, for the
  generator and the loader.
- `scripts/connector-loaders.ts` (new, pure): `connectorLoadersSource(names)` returns the
  generated file's text.
- `scripts/generate-project-registry.ts`: writes `CONNECTOR_LOADERS_FILE` after the connector
  registry, from the registered connectors with an index file.
- `src/lib/connectors/loader.ts` (new): `constructConnector` and `ConnectorLoadError`.
- The three callers: replace the import and the construction with `constructConnector`.
- `src/lib/apps/module-map.ts`: its comment names connectors too.
- `next.config.ts`: drop `ignoreIssue` and the comment that explains it.
- `switch.integration.test.ts`, `writable.integration.test.ts`,
  `webhook-limits.integration.test.ts` and `webhook-maintenance.integration.test.ts` add their
  fixture connectors (`_template`, `_template-oauth`) to `connectorLoaders`. Templates aren't
  registered, so the generator gives them no entry, as it gives them no registry entry.

## Tests

- `scripts/connector-loaders.test.ts`:
  - The generated text has one literal `import("@connectors/<name>/index")` per name, under
    `connectorLoaderKey`'s key, with no template literal. No names is an empty map, still
    exported. The header says server only and names the consumer.
  - Through `scanConnectors` on fixture connectors, the generator's selection covers exactly the
    registered connectors with an index file: `.ts`, `.tsx`, and none for one without.
  - The generated file, written out and imported with `@connectors/` pointed at the fixtures,
    loads each connector's own module.
- `src/lib/connectors/loader.test.ts`, with no database:
  - `constructConnector`: missing and failed are `ConnectorLoadError`s with their reason, message
    and cause. A default export and a named class are both constructed. A module with nothing to
    construct still throws.
  - `runConnectorTest`, with the switch, the config and the user grant stubbed: missing is
    `unsupported` with the registry hint, failed is today's `internal_error`, and both are logged
    with the error.

## Verification

- `npm test` against a throwaway Postgres 17 (`MIXOS_TEST_DATABASE_URL`), so the
  database-backed suites run every caller end to end through the map. Also `npm run typecheck`
  and `npm run lint`.
- `npm run registry` on this checkout, which has no connectors, writes an empty map, and the dev
  server compiles the three callers without a "Module not found" warning.

What the checks found:

- The first full run had one failure, in a suite the plan hadn't listed.
  `writable.integration.test.ts` builds an app context with `_template` and relied on the
  template import to reach it. It now files `_template` in `connectorLoaders` as the other three
  suites do.
- On the Docker dev server (port 3000) with no connectors, `npm run registry` wrote an empty
  map. Three requests compiled the callers, and the log had no "Module not found" or
  `Can't resolve` line:
  - `POST /api/webhooks/<unknown>` answered 404, which compiles the webhook route.
  - Admin > Connectors rendered.
  - The dashboard rendered Wall·E's widget through the app context.

## Follow-ups

- Whether the generator should refuse a registered connector with no `index.ts` (decision 2).
