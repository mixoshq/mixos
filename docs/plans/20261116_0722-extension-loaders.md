# Extension loaders: one explicit import per MCP tool, sync, job and service

**Status:** built on 16 November 2026, on branch `fix/extension-loaders`, which sits on
`fix/route-loaders` (not yet merged) because it reuses that branch's generator wiring. All of
these pass: `npm test` (2006 tests against a throwaway Postgres 17, none skipped),
`npm run typecheck`, `npm run lint` and the live check under Verification. The live check found
that the restart bug this plan set out to fix doesn't reproduce for a job (see Verification).

**Scope:** platform. The registry generator (`scripts/generate-project-registry.ts`, plus a new
`scripts/handler-loaders.ts`), four new generated files under `src/generated/`, a shared loader
(`src/lib/apps/module-map.ts`) that `src/lib/apps/route-loader.ts` also uses, the three callers
(`src/lib/mcp/tools.ts`, `src/lib/apps/scheduler.ts`, `src/lib/apps/services.ts`), the
`turbopack.ignoreIssue` rule and its comment in `next.config.ts`, and the fixtures of three
database-backed suites.

## Context

[`20261116_0020-route-loaders.md`](20261116_0020-route-loaders.md) fixed app API routes that
404'd until a restart when they were added under `next dev`. The cause was a template-literal
import, which Turbopack resolves once, against the files on disk when the importing module
compiles. A file added later isn't in that context, and nothing recompiles the importer.

Four more kinds of app code load the same way:

| Kind | Caller | Import |
|---|---|---|
| MCP tool | `loadTool` in `src/lib/mcp/tools.ts` | ``import(`@apps/${slug}/mcp/${toolName}`)`` |
| Sync | `runClaimed` in `src/lib/apps/scheduler.ts` | ``import(`@apps/${slug}/sync/${syncName}`)`` |
| Job | `runClaimed` in `src/lib/apps/scheduler.ts` | ``import(`@apps/${slug}/jobs/${job}`)`` |
| Service | `loadServiceHandler` in `src/lib/apps/services.ts` | ``import(`@apps/${providerSlug}/services/${serviceName}`)`` |

The expectation was that a tool, sync, job or service added to an app while `next dev` runs fails
to load until a restart, even after `npm run registry` has put it in the registry. For a job,
the live check found it doesn't (Verification). The change is still worth making for the other
reasons listed there. Here, no app in a fresh checkout declares any of the four, so each template
matches nothing and Turbopack warns "Module not found" on every compile. `next.config.ts` is
meant to quiet that warning.

## Decisions

1. **The same pattern as routes, one map per kind.** The generator writes:

   | File | Export | Key | Consumer |
   |---|---|---|---|
   | `src/generated/app-mcp-tool-loaders.ts` | `mcpToolLoaders` | `<slug>/mcp/<name>` | `src/lib/mcp/tools.ts` |
   | `src/generated/app-sync-loaders.ts` | `syncLoaders` | `<slug>/sync/<name>` | `src/lib/apps/scheduler.ts` |
   | `src/generated/app-job-loaders.ts` | `jobLoaders` | `<slug>/jobs/<name>` | `src/lib/apps/scheduler.ts` |
   | `src/generated/app-service-loaders.ts` | `serviceLoaders` | `<slug>/services/<name>` | `src/lib/apps/services.ts` |

   Each entry is one explicit `import("@apps/<key>")`. The key is the import specifier without
   `@apps/`, as for routes, so a log line names the file. No extension is given, so `.ts` and
   `.tsx` both resolve, as they did before.

   There is one file per kind, not one shared file, so each caller's module graph holds only its
   own kind, as the template's context did. One shared map would pull every job, sync and service
   into the MCP route, and every MCP tool into the scheduler.
2. **Built from what the registry vouches for.** Each map comes from the registered manifests'
   `mcp`, `sync`, `schedules` and `provides` names. The generator has already checked that each
   name has a handler file on disk, and it aborts the build if one is missing. A rejected app gets
   no entries, just as it gets no registry entry.
3. **Server only, each in its own file.** Same header and reasons as `routeLoaders`. None of the
   four is imported by `app-registry.ts`, which client components import.
4. **One rule for the key.** `src/lib/apps/handler-modules.ts` is pure, with no generated import,
   so the generator and the callers can both use it. It defines `handlerLoaderKey(slug, kind,
   name)`, where `kind` is the directory: `mcp`, `sync`, `jobs` or `services`.
5. **One loader, shared with routes.** `loadFromMap(loaders, key)` in `src/lib/apps/module-map.ts`
   returns `loaded` with the module, `missing` when the key isn't in the map, or `failed` with the
   error when the module threw while loading. It looks up own keys only (`Object.hasOwn`).
   `loadRouteModule` becomes a thin wrapper over it, with the same results, so there is one copy
   of the rule that keeps "no loader" apart from "threw at load".
6. **Each caller keeps what it does today in each case.** Only the log changes. "Missing" now
   says the handler is declared but not in the generated map, and to run `npm run registry`.

   | Caller | Missing (no loader) | Failed (threw at load) |
   |---|---|---|
   | `loadTool` | `null`, as today. New: a warning to run `npm run registry`. | `null`, logged with the error, as today. |
   | Sync in `runClaimed` | The run is recorded as `error`, as today. `last_error` now says the sync isn't in the generated map and to run `npm run registry`. | The run is recorded as `error`, with the module's own error, as today. |
   | Job in `runClaimed` | The same as a sync. | The same as a sync. |
   | `loadServiceHandler` | `NO_HANDLER`, "has no handler on disk.", as today. New: a warning to run `npm run registry`. | `NO_HANDLER` with the same message, as today. New: logged with the error. It used to be swallowed. |

   What loads and what doesn't stay as before: a tool with no default export or no `inputSchema`
   is still `null`, a sync that isn't a `defineSync()` result still errors, and so on. The app
   gate still runs before any import.
7. **Connectors stay out.** `@connectors/${name}/index` is loaded in three places
   (`src/lib/apps/context.ts`, `src/lib/connectors/test-connection.ts` and
   `src/app/api/webhooks/[name]/route.ts`). Each embeds the import in a larger `try`, with its own
   error handling, and has a different registry behind it. That isn't trivial, so it's listed as a
   follow-up.
8. **The `ignoreIssue` rule narrows to connectors.** After this change, the connector index is
   the only template import left. So the rule matches only
   `Can't resolve '@connectors/' <dynamic>`, and its comment says why the app kinds are gone from
   it. A template import under `@apps/` would warn again, which is right, because there should be
   none.

## Structure

- `src/lib/apps/handler-modules.ts` (new, pure): the `HandlerKind` type
  (`"mcp" | "sync" | "jobs" | "services"`) and `handlerLoaderKey`.
- `src/lib/apps/module-map.ts` (new, pure): `ModuleLoad`, `ModuleLoaders` and `loadFromMap`.
- `src/lib/apps/route-loader.ts`: `loadRouteModule` calls `loadFromMap`. `RouteModuleLoad`
  stays as an alias of `ModuleLoad`.
- `scripts/handler-loaders.ts` (new, pure, no I/O). It has a table of the four kinds, each with
  its file, export name, consumer and manifest field. `handlerLoadersSource(kind, apps)` returns
  one generated file's text.
- `scripts/generate-project-registry.ts`: writes the four files next to the route loaders.
- `src/lib/mcp/tools.ts`, `src/lib/apps/scheduler.ts` and `src/lib/apps/services.ts`: replace
  the template import with `loadFromMap` on the kind's map, and keep the outcomes in the table
  above. The comments say why.
- `next.config.ts`: the narrowed `ignoreIssue` rule and its comment.
- The fixtures in `app-gate.integration.test.ts`, `app-maintenance.integration.test.ts` and
  `src/lib/mcp/tool-switches.integration.test.ts` add their tools, syncs, jobs and services to
  the new maps, as they already do for routes, hooks and pages.

## Tests

- `scripts/handler-loaders.test.ts`:
  - For each kind, the generated text has one explicit `import("@apps/…")` per declared name,
    under `handlerLoaderKey`'s key, with no template literal. An app without that kind adds
    nothing. With no apps, the map is empty and still exported. The header says server only and
    names the consumer.
  - Through `scanApps` on a fixture app that declares a tool, a sync, a job and a service, each
    map has exactly the declared names.
  - Each generated file, written out and imported with `@apps/` pointed at the fixture, loads
    its handler's own module.
- `src/lib/apps/module-map.test.ts`: `loadFromMap` returns `missing`, `failed` (with the error) and
  `loaded`, and doesn't resolve an inherited key.
- `src/lib/apps/handler-loaders.test.ts`, with no database. The app gate, the system context, the
  telemetry write and `@/lib/db/client` are stubbed by a resolve hook, and the loaders are entries
  put into the generated maps for each test. Through each real caller:
  - `loadTool` and `describeTool`: missing is `null` with the warning, failed is `null` with the
    error logged, and loaded is the tool with its schema.
  - `runJobNow` for a job and for a sync: missing records `error` with the "run
    `npm run registry`" message, failed records `error` with the module's own message, and loaded
    runs the job, or reaches the `defineSync` check for a sync.
  - `createServicesClient().request()`: missing and failed are both `NO_HANDLER` with today's
    message, each with its own log line, and loaded returns the handler's result.
- Route loading keeps its own tests in `src/lib/apps/route-loader.test.ts`, which must still pass
  over the shared loader.

## Verification

- `npm test`, `npm run typecheck` and `npm run lint`.
- The database-backed suites against a throwaway Postgres 17 (`MIXOS_TEST_DATABASE_URL`). They
  run jobs, syncs, services and tools end to end through the new maps.
- Live:
  1. Start `npm run dev` against a scratch database, and compile the scheduler with a "Run now"
     or a cron tick.
  2. Add a job to an app (a `schedules` entry and `jobs/<name>.ts`), then run `npm run registry`.
  3. Run it without a restart and see it recorded as `ok`. Do the same for an MCP tool, through
     `tools/list`, if a token is at hand.
  4. Remove the scratch changes afterwards.

What the live check found, on `npm run dev` on port 3017 against a scratch database, with the
scheduler and the gateway compiled before anything was added:

- **Before the change, the job didn't need a restart.** The scheduler still had its template
  imports, and both jobs ran `ok` on the next cron tick after `npm run registry`, with no restart:
  - a job added to Wall·E (a `schedules` entry and a new `jobs/` folder);
  - a job in an app made by `npm run new` while the server ran.

  Turbopack re-resolved the template once the files were there. So for jobs, and likely for
  tools, syncs and services, which load the same way, the restart bug didn't reproduce.
- **A new app's route did need one, on the old gateway.** With the gateway's template import put
  back, that same kind of new app's route was a 404 on every request. The gateway logged nothing,
  so the 404 came before the import, not from it. A route of an app that was there when the
  gateway compiled loaded (401, no session).
- **After the change, on a fresh server:** both kinds of job ran `ok` and the new app's route
  answered 401, all without a restart (one `Ready` in the log). The generated maps listed the new
  job, tool and route. The old code printed a "Module not found: Can't resolve '@apps/' <dynamic>"
  warning for the scheduler's imports on every recompile, despite `ignoreIssue`. The new code
  printed none.
- MCP tools and services weren't checked live. `tools/list` needs an OAuth token, and a service
  needs a consumer to call it. Their loaders are covered by `src/lib/apps/handler-loaders.test.ts`
  and the database-backed suites.

So for these four kinds, the change buys:

- one loading path with routes;
- a log that tells a missing handler from one that throws at load. A service that threw at load
  used to be swallowed;
- no `@apps/` "Module not found" warnings in the dev log;
- not relying on Turbopack re-resolving a template, which it didn't do for the gateway.

## Follow-ups

- Connectors: the same map for `@connectors/<name>/index`, with its three callers. After that,
  the `ignoreIssue` rule could go.
- Why the old gateway 404'd a new app's route before its import while the scheduler, on the same
  server, saw the new app. Possibly a stale `appRegistry` in the gateway's bundle, like the stale
  page registry that the route-loaders plan records. It wasn't instrumented, because editing
  `dispatch.ts` recompiles it and would hide the effect.
