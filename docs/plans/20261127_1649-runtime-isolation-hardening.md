# Runtime isolation hardening: Phase 1 plan

- **Status:** Approved 2026-11-27 (decisions in §16). Item 0 shipped in #137,
  Item 1 in #138; Item 2 is in review. The rest follow §15's order.
- **Date:** 2026-11-27
- **Base:** `main` at `51ace2c`
- **Read in full first:** `docs/security-architecture.md`, `AGENTS.md`, `CLAUDE.md`,
  `apps/AGENTS.md`, `connectors/AGENTS.md`, `SECURITY.md`, `docs/apps/database.md`,
  `docs/connectors/credentials.md`

> This file was kept out of git until Item 0 shipped: §2's F1, F2 and F9 were
> vulnerabilities by `SECURITY.md`'s own scope, and #137 fixed them before this
> was committed.

---

## 0. Summary

- **The brief is mostly right about the shape.** Apps share the server process
  with every key and with a database role that can reach every table. Code that
  evades the build-time scan can reach all of it.
- **Where it is wrong:** there *are* runtime checks: the dispatcher, the app gate,
  connector narrowing, read-only proxies, the services broker and `context.http`'s
  SSRF guard. They are JavaScript in the same process, though, so they hold only
  while app code can't reach around them.
- **Two of them can be undone today with no evasion at all**, by an ordinary
  property access that no scan refuses (§2, F1 and F2):
  - an app can widen its own egress allowlist, connector list and `global` flag at
    runtime;
  - it can read any declared connector's decrypted credentials.

  Neither is in the brief. I recommend fixing both first, as **Item 0**.
- **The ceiling.** In-process, every item below raises the cost of an attack, and
  some (Item 2, Item 4's cheap tier) remove whole classes of mistakes. None of them
  contains code that is *trying* to escape: a raw database handle can `RESET ROLE`,
  and code that obtains `process` can read `/proc/self/environ` after the keys are
  scrubbed from `process.env`. "Contained by the runtime" for hostile code means
  running it out of process (Item 4's strong tier and Item 5b). The plan and the
  docs say so plainly, so neither claims more.

---

## 1. Where the brief is wrong or imprecise

| Brief says | What the code says | Evidence |
|---|---|---|
| "Every runtime boundary rests on build-time checks" | **Partly.** These run per request: auth tiers, grants, roles, CSRF, rate limits, the app gate, connector narrowing plus the two-key write rule, the read-only proxies, notification recipient filtering, the services broker's checks, and `context.http`'s DNS-pinned SSRF guard. All of them are in-process JS, so they assume app code can't reach around them. That assumption is the build-time scan. Two of them fail even without evasion (F1, F2). | `src/lib/apps/dispatch.ts`, `src/lib/apps/connector-reach.ts:47-77`, `src/lib/apps/scoped-db.ts:61-96`, `src/lib/apps/http.ts:345-396` |
| "Apps share one Node process" | **True** for server code on every host: one `node server.js` (Docker, Render, Railway), or one function instance running every app (Vercel). Widgets and client pages run in the browser. App route modules **also run at build time**: the generator `import()`s every `route.ts`. On Vercel the build environment holds the project's secrets, and needs `DATABASE_URL` for the release step. | `scripts/generate-project-registry.ts:584-600`, `package.json:16,19`, `Dockerfile:205` |
| "Every encryption key is in that process" | **True**, in `process.env`, and re-read on every use rather than cached (`platformKey()`). The database password also sits inside the postgres.js pool, and that pool is cached on `globalThis.__pg` **in production too**, not only for dev HMR as the comment implies. | `src/lib/env/keys.ts:109-130`, `src/lib/db/client.ts:10-23` |
| "All queries run as a role that owns every table" | **Effectively true.** The role owns every `public` table. Each app's tables belong to `mixos_app_<slug>`, and the platform role is a member of that role (`with inherit true, set true` on PG16+), so it holds owner rights there. One exception: `_sync_state` in each app schema is owned by the platform role. | `scripts/app-migrations.ts:189-212, 220-254, 352-376` |
| "App roles exist for migrations, and the platform role is a member of each" | **Correct.** Migrations run through a `SECURITY DEFINER` function owned by the app role. | `scripts/app-migrations.ts:294-337` |
| Item 2: "SET LOCAL ROLE, so Postgres refuses access even if ScopedClient is bypassed" | **Only for some bypasses.** `RESET ROLE` / `SET ROLE NONE` is allowed for any user, so any raw SQL path on the platform's login undoes it. It stops a builder bug, a wrong-schema bug, or SQL the platform composes. It does not stop app code holding the pool. The acceptance test needs restating (Item 2). | Postgres `SET ROLE` semantics |
| Item 2: run "hooks" as the right role | **Hooks have no DB handle.** Listeners get a registrar, not a context. Two paths the brief leaves out *do* query: **search handlers** (read-only client) and **`runSync`**, which writes the platform-owned `_sync_state` through the app's own `context.db`. | `src/lib/hooks/loader.ts:85-96`, `src/lib/search/broker.ts:118`, `src/lib/apps/sync.ts:121-143` |
| Item 2: the app role needs a grant on "the platform's updated_at trigger function" | **It doesn't.** Postgres checks EXECUTE when a trigger is created, not when it fires. The function is `security invoker`, `search_path = pg_catalog`, and uses only `now()` and `jsonb_populate_record`. A test must still prove it under `SET ROLE`. `_sync_state` is the one table that needs a decision (Item 2, step 3). | `supabase/migrations/0001_platform_schema.sql:678-694` |
| Item 3: "which methods each [app] declares" | **Apps don't declare methods.** An app declares a connector, a version and `access`. It can call every read the connector declares, plus every `mutates` method when it has `access: "write"` **and** the admin has allowed changes. The panel should show that *reachable* set, and the *observed* set from telemetry. | `src/lib/apps/connector-reach.ts:99-124`, `src/lib/connectors/requirements.ts:42-50` |
| Item 3: "the scopes the stored grant holds" | **Answerable only for authorization-code connectors.** The scope snapshot is taken at the OAuth callback and not refreshed afterwards. Client-credentials tokens record no granted scopes (the mint drops `scope`). API keys have no scopes MixOS can see. | `src/lib/connectors/oauth-flow.ts:207-217`, `src/lib/connectors/http-connector.ts:810-824` |
| Item 3: "connector_configs is keyed by connector_name" | **Correct** (PK `connector_name`). `connector_scope_status` and `user_connector_oauth` are keyed by name too (the latter plus `user_id`). The refresh lock is keyed by name. | `0001_platform_schema.sql:214-264`, `src/lib/connectors/config.ts:177-216` |
| Item 4: "confirm the containment scan blocks process.env and globalThis access" | **It blocks the spellings:** `process`, `globalThis.process`, computed indexing of the global object, and aliasing it. **It does not block reflection:** `(()=>{}).constructor.constructor("return process")()` reaches `Function` without naming it. The doc already says the scan "is not a sandbox", so this is not a false claim. It is the one-line evasion, though, and worth closing where it's cheap. | `scripts/app-containment.ts:101-109, 214-240` |
| Item 5: "Registry apps run with the same in-process trust as local ones" | **True at runtime:** no execution path reads provenance. But there is already more gating than the brief implies: every new app arrives **inactive** (local or Registry); a Registry app waits in pending until **Review and register**; and a different extension under a slug arrives off and needs its slug typed. The real gaps are listed in Item 5. | `scripts/sync-app-registry.ts:218-231`, `src/lib/repository/review.ts`, `src/lib/apps/access.ts:203-248` |
| Item 6: "using existing telemetry, the audit log and method declarations" | **Partly there.** Connector calls are recorded per app (`caller_app_slug`, method, outcome). But `mutates` isn't recorded (it can be derived), **refused calls are never recorded**, and **egress is not recorded anywhere**. Only `route` rows are ever pruned (30 days). Connector, service, MCP and app rows are kept forever today. | `src/lib/apps/telemetry.ts:64-86, 196-219, 237-308`, `src/lib/apps/http.ts` |
| "README Security section" | Exists (`README.md:386-391`). | |

---

## 2. Findings outside the brief

| # | Finding | Severity | Evidence |
|---|---|---|---|
| **F1** | **`context.manifest` is the live, shared `appRegistry` object, and the platform reads it again later.** App code can write `context.manifest.egress.push("anywhere.example")` (the HTTP client checks that array by reference on every call), `context.manifest.connectors.push({...})` (the next context build loads and initializes that connector with its credentials), or `context.manifest.global = true` (`hasAppGrant` then admits every user). The scan refuses writes only through *imported* bindings, and `context` is a parameter. This undoes the egress allowlist, the connector declaration and the grant model with one ordinary line. | **High** | `src/lib/apps/context.ts:60-68, 74, 196-199`; `src/lib/apps/http.ts:366`; `src/lib/apps/access.ts:12-16`; `src/lib/apps/import-policy.mjs:884-886, 1061` |
| **F2** | **The connector proxy passes every non-function property through, including `credentials`.** `BaseConnector` keeps the decrypted credential set in a `protected credentials` field, which is protected only to the compiler. So `context.connectors[x].credentials`, `JSON.stringify(context.connectors)`, `Object.entries(...)` and `getOwnPropertyDescriptor` all return the API key, client secret or refresh token. Together with F1 (or any declared egress host), an app can use the credential outside its declared methods. That contradicts §16.1 ("the manifest is the whole of what an app can do with a connector") and §2.3. | **High** | `src/lib/apps/connector-reach.ts:61-63`; `src/lib/connectors/http-connector.ts:158, 206-207` |
| F3 | `Function` is reachable by reflection (`x.constructor.constructor`), and from there `process`. This is a known class ("not a sandbox"), but it is the cheapest evasion. | Medium | `scripts/app-containment.ts:101-109` |
| F4 | The full-privilege pool lives on `globalThis.__pg` in production, so anything that reaches the global object (F3) gets the platform database role without importing anything. | Medium | `src/lib/db/client.ts:10-23` |
| F5 | App migrations run at the release step **whether or not the app is active or reviewed**. The SQL policy and the app role bound what they can do. | Low | `scripts/app-migrations.ts:545-584, 660` |
| F6 | An in-place **update** of a Registry app keeps its activation. New code runs at the next deploy with no fresh admin act. | Medium (Item 5) | `scripts/sync-app-registry.ts:271-275`; `src/lib/repository/pending-admin.ts:302-303` |
| F7 | Only `route` telemetry is pruned. Connector, service, MCP and app rows grow without bound. | Low | `src/lib/apps/telemetry.ts:196-219` |
| **F9** | *(found while implementing Item 0)* **`context.user` was the very object the services broker reads to say who is asking.** A consumer could set `context.user.id` to another person's id, or `isAdmin = true`, then call `context.services.request(...)`, and the provider's `audience: "user"` service ran as that person. Confirmed by `context-reach.integration.test.ts` against the old code. | **High** | `src/lib/apps/context.ts:94-101`, `src/lib/apps/services.ts:101-107, 186-198` |
| F10 | *(found in Item 2's spike)* **Behind Supavisor older than 2.10, four or more concurrent queries on one pool hang.** MixOS's pool is `max: 3` with postgres.js's default `max_pipeline: 100` and no `query_timeout`. When all three connections are busy, a fourth query is pipelined onto one of them, and Supavisor before 2.10 never answers it (postgres.js's README says the same). Reproduced against the Supavisor 2.9.12 the Supabase CLI 2.117 runs locally, with today's code paths (plain queries, with and without parameters). `max_pipeline: 1` fixes it. Supabase's 6543 pooler is MixOS's documented production setup; the hosted Supavisor version is not visible from SQL, so whether production is exposed is unverified. Not a security property. A small separate fix: `query_timeout`, so a hang becomes an error, plus `max_pipeline: 1` or a documented minimum. | Medium (availability) | `src/lib/db/client.ts:14-22`; `node_modules/postgres/README.md` ("Connection poolers") |
| F8 | `docs/security-architecture.md` currently overclaims in §2.3, §13 ("the only door") and §16.1, because of F1 and F2. The rule "the doc must never describe a guarantee the code doesn't enforce" is broken today. Item 0 fixes the code and the doc together. | | |

### Item 0 (proposed, before Item 1): close the gaps that need no evasion

**Change**

- **Manifest.** `context.manifest` becomes a deep-frozen copy. The generated
  `appRegistry` entries are deep-frozen at module load too, so a write throws in
  strict mode (app modules are ESM, so strict). `createHttpClient` keeps its own
  frozen copy of `egress`. Platform code that mutates a manifest object, if any
  exists, surfaces as a failing test.
- **Connectors.** Apps get a **facade**, not a `Proxy` over the instance. The
  facade is a fresh null-prototype object holding:
  - the bound declared methods (reads, plus writes when allowed);
  - getters for `name` and `configured`;
  - nothing else: no own keys that lead to the target, no prototype.

  The same facade serves the MCP and services paths (`read-only.ts` reuses
  `narrowConnector`). Connector classes don't change.
- **User.** `context.user` (and its `roles`) is deep-frozen too (F9), and so is
  the role-stripped copy the `signed-in` tier hands over (`dispatch.ts`,
  `call.ts`).
- **Pool: moved to Item 4.** Reaching `globalThis` already needs evasion, so
  this isn't a no-evasion gap. Next may compile the proxy and the routes into
  separate bundles, so dropping the `globalThis` cache could double the
  connection pools. That needs checking against a production build, alongside
  T1.
- **Docs.** Correct §2.3, §13, §16.1 and §24 ("what it does not stop") in the same
  PR.

**Risk.** Something in the platform may rely on writing to a manifest object (a
test will find it), or on reading a connector property through the proxy (for
example `displayName`). Both get an explicit allowlist.

**Upgrade impact.** None for manifests or connectors. Behaviour changes only for
code that was doing something it shouldn't.

**Tests** (fixtures under a test-only apps dir, run through the real context
builders):

- `context.manifest.egress.push` throws, and `context.http` still refuses the host.
- `connectors.push` and `global = true` throw.
- Through each of `connector.credentials`, `JSON.stringify`, `Reflect.ownKeys`,
  `Object.getOwnPropertyDescriptor`, `Object.getPrototypeOf(c).request.call(c, …)`
  and `c.constructor`, no secret is reachable.
- Read-only and services facades behave as before.
- A "context reachability census" walks every property and prototype reachable
  from a built context, to depth 6. It asserts that none is the pool, a `DbClient`,
  `appRegistry`, `process`, a connector instance, or a string equal to a stored
  secret.

**Effort:** S–M, 2–3 days.

**Disclosure.** Consider landing it through a GitHub security advisory's private
fork, then publishing the advisory with the release, as `SECURITY.md` describes.

---

## 3. What in-process hardening can and cannot buy

| Attacker capability | Item 0 | Item 2 | Item 4 cheap | Item 4 strong / 5b |
|---|---|---|---|---|
| Naive or careless app code (property writes, logging `context`) | **Stops** | n/a | Stops env reads | Stops |
| A builder bug or wrong-schema bug that names an object outside the app's schema | | **Stops** (Postgres refuses) | | Stops |
| Injected SQL text written to escape, reaching the executor (setting the role back, another app's role, DDL that leaves code behind) | | **Stops** (the runner: a role change is refused inside a `SECURITY DEFINER` function, and DDL can't run through it) | | Stops |
| App code that evades the scan (reflection, `Function`) and obtains `process` or the pool | | Does **not** stop (`RESET ROLE`) | Raises cost, doesn't stop (`/proc/self/environ`, platform functions) | **Stops** (the secrets aren't in that process) |
| A malicious platform dependency | | | | Partly (only if it isn't loaded in the platform process) |

The threat model (Item 1) uses this table's language.

---

## 4. Item 1: Threat model (`docs/threat-model.md`)

**Current state.** `SECURITY.md:318-335` says what an installed extension can do.
`docs/security-architecture.md` is 3,950 lines for auditors. `README.md:386-391`
links both. There is no one-screen threat model.

**Change.** Add `docs/threat-model.md`, about 60 lines, plain language:

- the trust model: "MixOS runs apps you wrote or have read";
- a table with the seven rows below, each giving today's mitigation and what is
  still exposed;
- "What MixOS does not protect against": a malicious admin, a malicious app *by
  design*, the host itself, a breach at a provider.

Link it from `README.md` Security and from `SECURITY.md`. Each later item's PR
updates its rows. Draft rows (final wording in the PR):

| Threat | What MixOS does today | Still exposed |
|---|---|---|
| Compromised app code | The build refuses code that reads the environment, reaches the network directly, or imports platform internals. At runtime an app gets only what its manifest declares, and an admin can switch it off from the next request. | The checks read the code's text; they are not a sandbox. Code written to get around them can reach every key, the database and every connector credential. Only run apps you wrote or have read. |
| Malicious dependency | Apps can't add packages. The platform's are locked, install scripts are allowlisted, and CI blocks high advisories. | A compromised platform package runs with the server's full power. |
| Exploited route | Sign-in, grant, roles, CSRF, input and output validation, rate limits and budgets are checked around every handler. An app reaches only its own tables (Postgres-enforced after Item 2) and the connector methods it may call. | Everything that app can reach. A bug that runs code counts as "compromised app code". |
| Stolen session | HttpOnly, SameSite cookies; per-person "sign out everywhere"; admin rights re-read on every request. | The thief is that person until revoked. An admin session can configure connectors, activate apps and mint keys. There is no second factor. |
| Leaked DB credential | Credentials, tokens and app secrets are encrypted with keys that are not in the database; passwords are bcrypt; tokens and API keys are stored as HMACs. | All other data is readable and writable, and the attacker can make themselves admin. |
| Leaked encryption key | Each key protects one thing; alone, a key is useless without the database. | Key plus database exposes that key's secrets. Rotating means re-entering them (only the GitHub App key has a re-encrypt command). |
| Compromised shared connector token | One token per connector, shared. MixOS limits which apps call which methods, and writes need the app to ask and an admin to allow. | The token can do everything its scopes allow at the provider. Disable doesn't revoke it: revoke at the provider. Item 3b gives one app its own narrower token. |

**Risks.** Overclaiming or underclaiming. Every row is checked against the code at
the commit it lands on. Because of F1 and F2, Item 1 should land **after Item 0**,
or omit those two until then.

**Upgrade impact.** None.

**Tests.** Link check. Each row cites the section of `security-architecture.md`
that backs it.

**Effort:** S, half a day plus one update per later item.

---

## 5. Item 2: Postgres-enforced app isolation

### Current state

- Every app DB handle comes from one factory, `createScopedClient(slug)`
  (`src/lib/apps/scoped-db.ts:20-27`). It is the shared `DbClient` over the one
  pool with `.schema(app_<slug>)`. The pool connects as the platform role; the
  builder keeps the pool in `#private` fields (`src/lib/db/query.ts:637-647,
  762-770, 842-848`).
- Paths that reach it, all through `createScopedClient` /
  `createReadOnlyScopedClient`:

  | Path | Where |
  |---|---|
  | API routes | `buildAppContext` / `buildPublicAppContext`, `context.ts:104, 153`; dispatcher `dispatch.ts:416-423` |
  | `callAppRoute` | `call.ts:169, 182` (same builders) |
  | Scheduled jobs | `buildSystemAppContext`, `context.ts:406`; `scheduler.ts:341` |
  | Syncs | `runSync` uses the job's `ctx.db` and writes `_sync_state` through it (`sync.ts:121-143, 154`) |
  | App Services | provider context `services.ts:193, 201`; read-only from MCP `services.ts:216` |
  | MCP tools | `read-only-context.ts:47`; `mcp/broker.ts:239` |
  | Search | `search/broker.ts:118` (read-only) |
  | `createSwrCache` | takes `ctx.db`; table in the app's schema (`swr-cache.ts:111-344`) |
  | Hooks | no DB handle |

- Pool: postgres.js 4.1.1, `max: 3`, `prepare: false` (Supabase transaction
  pooler), `src/lib/db/client.ts:14-22`, `pg-options.ts:137-143`.

### Change

1. **Run every statement through the app's runner** *(revised twice: after the
   spike, and after review; see "Design history" below)*. The release step
   creates, in each app's schema, `mixos_run(stmt text, params json,
   read_only boolean) returns setof json`: plpgsql, `SECURITY DEFINER`, owned by
   the app's role, `search_path = pg_catalog, pg_temp`, executable by that role
   alone. `createScopedClient(slug)` confines the builder to it
   (`DbClient.confined`): each statement goes out as `select r from
   app_<slug>.mixos_run($1, $2, $3)`, its values packed into one JSON array
   (`$1->0` as JSON, `$1->>0` as text), and each statement returns one JSON
   value per row, shaped like today's rows, so no caller changes.
   - **Why it holds against SQL written to escape.** Postgres refuses `SET
     ROLE`, `set_config('role', …)` and `SET SESSION AUTHORIZATION` inside a
     `SECURITY DEFINER` function ("cannot set parameter role within
     security-definer function"), so the statement can't get back to the
     platform's login or to another app's role. The migration runner already
     relies on the same rule. `RETURN QUERY EXECUTE` runs only a statement that
     returns rows, and one statement only, so DDL can't run through it, and
     nothing can be left in the app's schema for the platform to run later.
   - **Covered:** the count, the data statement, the upsert's primary-key
     lookup, and `.single()`'s write path, which already runs in `sql.begin`;
     there the runner call runs inside that transaction. A write that returns
     nothing returns `null::json` per row, since the runner returns rows.
   - **Fails closed.** A missing runner (`42883`), or a login that may not call
     it (`42501`), fails the statement and runs nothing.
   - **One statement:** no round trip over today, and nothing a pooler can
     split.
   - **Per query, not per request.** A request-long transaction would hold one of
     three pool slots, and a pooler backend, across connector calls that take
     seconds. It would also make every write in a request atomic, which changes
     what apps see.
2. **Read-only clients** (MCP, search, services-from-MCP) pass `read_only`, and
   the runner sets `transaction_read_only` before it runs the statement. Postgres
   refuses writes (`25006`) beneath the existing Proxy, and refuses a switch back
   to read-write once the transaction has run a query (`25001`).
3. **`_sync_state`.** `runSync` reads and writes it through a platform-side handle
   passed in by the scheduler (`createPlatformScopedClient`). *(Changed while
   building it.)* The app's role gets **no** privilege on it, not the `SELECT`
   first proposed: the table has RLS on with no policies and isn't the app
   role's, so a `SELECT` grant alone would have read zero rows, silently. No
   app in the repo and no doc reads it, and the app can no longer write its
   own watermark either.
4. **Least privilege, checked rather than assumed.** An integration "privilege
   census" runs as each app role and enumerates `has_table_privilege`,
   `has_function_privilege`, `has_schema_privilege` and `has_sequence_privilege`
   across every schema. It asserts:
   - only its own schema's objects are reachable, plus `pg_catalog` /
     `information_schema` reads;
   - no `EXECUTE` on any `public` function: the three platform functions already
     revoke `PUBLIC` (`0001:690-711`), and the census makes a new one that forgets
     to fail CI;
   - no `CREATE` on `public`.

   On PG13/14, `PUBLIC` holds `CREATE` on `public`. Platform migration 0004
   revokes it where the connecting role owns the schema (or is a member of its
   owner), and the release step warns on every run where it can't. *(Changed
   while building it: the readiness probe answers only "can this pod serve",
   so a warning belongs in the release log instead.)* A new database's `public`
   on PG13/14 belongs to the bootstrap superuser, so on a hosted PG13/14 the
   warning is the likely outcome.
5. **Release-step runner and probe.** For every database app, after its
   migrations, the release step replaces the runner, owner and grants included
   (`ensureAppRunner`), then checks it (`probeAppRunner`): in the catalog
   (security definer, owned by the app's role, its search path, its body, no
   other grantee), then by calling it read-write and read-only and asking who
   it ran as. A runner made `SECURITY INVOKER`, given another owner, granted to
   `PUBLIC` or given another search path fails the release; the next release
   puts it back. This fails closed; no kill switch is proposed.
6. **Docs.** Rewrite the parts that say "at runtime the boundary is held in
   application code": §3.2, §4 (Per-app schemas row), §8 (Where authorization
   happens), and `docs/apps/database.md`'s note and "Why so strict" paragraph.
   Defaults, checks and views now run as the app role on queries the app issues,
   and still as the platform role when the platform itself touches app tables.
   State the limit precisely: the platform's login, which the server process
   holds, still reaches every app's tables and calls every app's runner, so
   app code that gets around the build's checks to the pool isn't held.

   **Design history.** The spike's design sent each statement in one
   postgres.js `sql.batch` behind `select set_config('role', '<role>', true)`.
   It cost nothing measurable, but SQL text written to escape got out in one
   statement (`set_config('role', 'none', true)` plus `query_to_xml(...)`),
   because the login is a member of every app's role. Asked whether
   `context.db` could be the only way to an app's tables, we replaced it with
   the runner before merging (2026-11-27), which closes that escape with the
   same one login.

### Pooling (Supabase transaction mode and others)

- **`SET LOCAL` inside an explicit transaction is safe** under transaction pooling
  (Supavisor on 6543, PgBouncer transaction mode). The pooler pins one backend for
  the transaction, and `SET LOCAL` ends at `COMMIT`/`ROLLBACK`, including the
  implicit rollback when a client drops mid-transaction.
- **Session-level `SET ROLE` would be unsafe.** It sticks to whichever backend ran
  it, and the pooler hands that backend to the next client. So no code path may
  use it. A test runs a few hundred role-bound queries interleaved with platform
  queries on the pool and asserts `current_user` is the platform role every time
  outside the executor.
- **Session mode and direct connections** are safe too.
- **Verified in the spike (2026-11-27), for the batch design the runner replaced**
  (the runner is one ordinary statement, so it needs none of this), through PgBouncer 1.26.1 in transaction
  mode and Supavisor 2.9.12 in transaction mode (the Supabase CLI 2.117's local
  pooler), against PG17. Neon's pooler is PgBouncer; not tested on Neon itself.
  On each:
  - the batch runs as the app role and is refused `42501` on a platform table;
  - the role is gone at the next query;
  - a batch that fails mid-way rolls back and leaves the connection clean;
  - 4,800 concurrent queries, with 1,200 failing batches mixed in and
    role-bound and platform queries interleaved on one `max: 3` pool, came
    back with zero wrong roles on all three paths.
- **Supavisor before 2.10 hangs on pipelining**, but that is F10, a
  pre-existing problem with today's plain queries too. A batch behaves exactly
  like a plain query there: one works, and four concurrent ones hang until
  `max_pipeline: 1`.

### Performance

- **Today:** one round trip per builder query (two with `count`).
- **With `sql.begin`:** BEGIN, then SET plus the statement pipelined, then COMMIT:
  about three round trips. That is +1–4 ms per query against a same-region pooler,
  but **+100 ms or more cross-region**.
- **With `reserve()` and full pipelining:** about one round trip, plus
  microseconds of server work.
- **Pool slots:** each query holds its slot slightly longer.
- **Spike results (2026-11-27), for the batch design.** These are through the real `DbClient`, with
  the executor swapped and a delay proxy in front of the server. The rows are
  a select by id (`.eq().maybeSingle()`), an insert, and an
  `.insert().select().single()`. Each cell is p50 / p95 in ms; n=1,000 on
  loopback, 300 at 2 ms, 60 at 40 ms.

  | Path, RTT | Variant | select | insert | insert + `.single()` |
  |---|---|---|---|---|
  | PG17 direct, loopback | today | 0.97 / 2.01 | 0.90 / 2.32 | 1.61 / 3.19 |
  | | `sql.begin` + `SET` | 1.94 / 4.26 | 1.54 / 3.27 | 1.95 / 4.34 |
  | | batch, role as a parameter | 1.41 / 2.97 | 1.18 / 2.28 | 1.94 / 3.67 |
  | | **batch, role as a literal** | **1.01 / 2.00** | **0.85 / 1.61** | **1.64 / 3.42** |
  | PG17 direct, 40 ms | today | 97 / 107 | 99 / 111 | 198 / 215 |
  | | `sql.begin` + `SET` | 194 / 242 | 195 / 212 | 239 / 253 |
  | | batch, role as a parameter | 144 / 155 | 144 / 159 | 243 / 259 |
  | | **batch, role as a literal** | **97 / 142** | **99 / 144** | **198 / 344** |
  | PgBouncer txn, 40 ms | today | 98 / 109 | 95 / 107 | 195 / 210 |
  | | **batch, role as a literal** | **96 / 106** | **97 / 109** | **193 / 210** |
  | Supavisor 2.9.12 txn, 40 ms (`max_pipeline: 1`) | today | 99 / 110 | 98 / 108 | 196 / 210 |
  | | **batch, role as a literal** | **98 / 116** | **99 / 109** | **196 / 210** |

  - **Round trips.** At 40 ms, a builder query today is 2 round trips, because
    `prepare: false` describes before it runs. The literal batch is still 2,
    a parameter adds 1, and `sql.begin` adds 2.
  - **Throughput** (24 workers on one `max: 3` pool): **−3%** at 2 ms RTT
    (6,198 → 6,027 q/s). On loopback it's 25–33% lower (27.6k → 20.4k q/s
    direct, 29.4k → 19.7k through PgBouncer), because the server runs two
    statements per query; real hosts are network-bound.
  - **Postgres versions.** The batch semantics (role applied, ended at Sync,
    rolled back on error, refusals, no warnings with `set_config`) were
    checked on 13.23, 14.25, 15.2, 16.14 and 17.11. On 13 and 14, `PUBLIC`
    still has `CREATE` on `public`, as step 4 expects.
  - **The 2 ms results** follow the same pattern and are in the PR.
  - **Hosted pooler:** not tested. No hosted database was used.

- **The runner, measured the same way (2026-11-27).** p50 / p95 in ms through
  the real `DbClient`:

  | Path, RTT | Variant | select | insert | insert + `.single()` |
  |---|---|---|---|---|
  | PG17 direct, loopback | today | 1.49 / 2.45 | 0.80 / 1.41 | 1.37 / 3.20 |
  | | runner | 1.72 / 3.98 | 0.83 / 2.87 | 1.63 / 4.23 |
  | | runner, read-only | 1.62 / 3.21 | | |
  | PG17 direct, 40 ms | today | 101 / 138 | 102 / 118 | 199 / 209 |
  | | runner | 101 / 112 | 100 / 115 | 198 / 257 |
  | PgBouncer txn, 40 ms | today | 104 / 119 | 99 / 110 | 200 / 218 |
  | | runner | 103 / 113 | 100 / 110 | 200 / 216 |
  | Supavisor 2.9.12 txn, 40 ms (`max_pipeline: 1`) | today | 102 / 115 | 101 / 109 | 198 / 213 |
  | | runner | 101 / 108 | 100 / 107 | 198 / 215 |

  The same round trips as today everywhere; up to a quarter of a millisecond of
  server work on loopback. Throughput with 24 workers on one `max: 3` pool:
  −7% on loopback (2,343 → 2,185 q/s), −1% at 2 ms RTT (683 → 678 q/s).

### Risks

- Pipelining behind a pooler (above).
- A query that worked only because of platform privileges now fails. Candidates:
  `_sync_state` (handled) and an app view over something it doesn't own, which the
  SQL policy already prevents. The census and the existing app integration tests
  should surface any others.
- More pool pressure under load.
- **The boundary doesn't cover a raw handle**, so the doc must say so.

### Upgrade impact

- No manifest change.
- The release step runs the probe. `_sync_state` gets no grant (step 3).
- PG16+ installs already have membership `with set true` (`joinAppRole`
  re-grants if not).
- A superuser connection (local Docker) works.
- Supabase's `postgres` (not a superuser) works through the membership the release
  step grants.

### Tests (acceptance restated)

1. **Simulated bypass through the executor.** A test-only seam
   (`runThrough`) runs SQL text through app A's runner, as a builder bug or an
   injection would. Each of these is refused with `42501` (or `25006` on the
   read-only client, `42601` for anything that isn't a query):
   - `select` from `public.users`, `public.connector_configs`, `app_b.t`;
   - `insert into public.admin_audit_log`;
   - `select public.get_app_schema(…)`;
   - `create table public.x`;
   - an `insert` through the read-only client.

   `select` and `insert` on `app_a.t` succeed.
2. **Census** per app role (above).
3. **Behaviour:**
   - an `updated_at` trigger fires under the app role;
   - identity columns and sequences work;
   - `createSwrCache` works;
   - `runSync` advances its watermark;
   - App Services runs as the provider's role;
   - MCP and search refuse writes at the database.
4. **Pooling:** the interleaving test (above).
5. **Escapes refused:** through app A's runner, `set_config('role', 'none',
   true)` with `query_to_xml(...)`, `set_config('role', 'mixos_app_b', true)`,
   `set_config('session_authorization', …)`, `SET ROLE`, `RESET ROLE`, `CREATE
   TABLE` and `CREATE FUNCTION` in its own schema and in `public`, and a second
   statement; and nothing is left behind. Read-only stays read-only against
   `set_config('transaction_read_only', 'off', true)`, a writable CTE and
   `nextval()`.
6. **The limit, pinned**, so the doc can't claim otherwise: the platform's own
   pool reads every app's tables.

**Effort:** M, 4–5 days including the spike.

**Possible later step (not proposed now): a separate login for app queries.**
Give app queries their own login, `mixos_apps`, with no privileges on `public` and
membership in the app roles, so `RESET ROLE` lands somewhere harmless.

- It needs a second database URL and pool, and hosts must allow creating roles.
- It doesn't stop app A from `SET ROLE mixos_app_b`.
- The runner closed the SQL-text escape without one. What remains is the
  platform's login in the same process as app code; only running an app in a
  process without it (5b/7b) closes that, and there a login, or a broker, per
  app is the natural shape.

---

## 6. Item 3: Connector blast radius, then per-app credentials

### 3a: Blast radius panel

**Current state**

- Admin > Connectors (`src/app/(main)/admin/connectors/page.tsx:129-215`) already
  has:
  - a Details tab with "Apps using this connector", built from manifests by
    `getConnectorDependents` (`src/lib/connectors/dependents.ts:27-46`). It returns
    display *names*, not slugs, and is shown only once credentials are saved
    (`connector-configure-dialog.tsx:1417`);
  - a Methods tab with each method's scopes against the grant snapshot
    (`:374-496`);
  - a Usage Logs tab with the last 100 calls (`src/lib/connectors/access.ts:63-104`).
- Missing:
  - whether each app is **active** (`getAppActiveMap`, `src/lib/apps/access.ts:251-259`,
    is used only on Admin > Apps);
  - each app's **reachable methods**;
  - whether it **can write now** (`access: "write"` and
    `connector.writable.<name>`);
  - what it was **observed** calling.

**Change.** A server function, `connectorBlastRadius(name)`, returns, per app that
declares the connector:

- slug, name, active, required or optional, `access`;
- reachable reads and reachable writes (from `connectorRegistry[].telemetry`);
- `canWriteNow`;
- methods called in the last 30 days (from `telemetry_events`, grouped by
  `caller_app_slug` and `event_name`);
- for each reachable method, its scopes and whether the stored grant holds each
  one (authorization-code: `connector_scope_status`; client-credentials: "not
  recorded"; API key: "the provider decides").

It is shown:

- in a new **Reach** section on the Details tab, active apps first, with a
  "Changes data" pill on each write;
- as a tile summary: "Used by 3 active apps · 1 can change data".

It is read-only, and needs `requireAdmin()` like the page.

**Risks.** Low. Telemetry grouping cost: bounded by the existing
`(caller_app_slug)` index and a 30-day window.

**Upgrade impact.** None.

**Tests.**

- Unit tests for the computation: optional vs required, write with and without
  the switch, inactive apps, a connector with no grant.
- A component test of the section.
- A page test that a non-admin can't reach the action.

**Docs.** `docs/connectors/registry-ux.md`; a line in §16.1.

**Effort:** S–M, 2–3 days.

**As built** (2026-11-28). Three departures, each for a reason found in the code:

- **No server action.** Next's guide keeps Server Functions for mutations, and
  the client dispatches them one at a time, so a read on opening the dialog
  would queue Test and Save behind it. What each app may call is computed with
  the page (`connectorReach`, `src/lib/connectors/reach.ts`, from the manifests,
  `readAppActiveMap` and Allow changes). The calls come from one query for every
  connector (`getObservedConnectorCalls`, `src/lib/connectors/observed.ts`),
  passed to the dialog as a promise and read with `use()` under Suspense. So
  there is no new endpoint, and the data leaves the server only inside the
  admin-gated page. The page test for a non-admin falls away with the action.
- **Scopes stay on the Methods tab.** Until 3b, every app shares one grant, so
  a per-app list of scopes would repeat the Methods tab's verdicts for each app.
  The section says that what the provider allows is on Methods and Scopes, and
  warns once when changes are allowed on a grant without the write scopes.
- **The index is `(source_type, source_slug, created_at)`, not
  `(caller_app_slug)`.** The query filters on the connector and the window,
  and groups by app and method.

It replaces the Details tab's "Apps using this connector" list, and is shown
before the credentials are saved too. Unreadable switches count every app as
running; unreadable telemetry reads "Couldn't read", never "no calls".

### 3b: Per-app credential override (design here; implement if approved)

**Schema.** Additive, so no existing row changes:

```sql
create table public.connector_app_configs (
  connector_name        text not null,
  app_slug              text not null references public.apps(slug) on delete cascade,
  encrypted_credentials text not null,          -- CONNECTOR_ENCRYPTION_KEY, as connector_configs
  configured_by         uuid references public.users(id),
  configured_at         timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  last_verified_at      timestamptz,
  last_verified_detail  text,
  primary key (connector_name, app_slug)
);
-- RLS on, no policies, like every platform table.
alter table public.connector_scope_status add column app_slug text;  -- null = shared grant
-- partial unique indexes re-cut to (connector_name, scope) where user_id is null and app_slug is null,
-- and (connector_name, app_slug, scope) where app_slug is not null.
```

Why a new table rather than an `app_slug` column on `connector_configs`: every
existing reader and writer, and the rename, delete and identity code, keeps its
meaning unchanged, and an install with no overrides is byte-for-byte today's.

**Resolution.** In `loadTenantConnectors` (`context.ts:280-286`, where both
`manifest.slug` and the connector name are in scope), an override row for
`(connector, app)` wins over the shared row.

- **Fail closed:** an override that exists but can't be decrypted or initialized
  leaves that app with an unconfigured connector. It never falls back to the
  shared, broader token.
- User-scoped connectors are out of scope for v1, since each person already has
  their own grant.

**OAuth (authorization-code)**

- Connect for an override carries the app slug inside the encrypted flow cookie,
  never in `state`. The redirect URI is unchanged.
- The callback writes the override row and its scope snapshot.
- Refresh write-back targets the override row, under an advisory lock keyed on
  `connector:app`. The hook already exists: `HttpConnector.bindUserGrant` binds a
  refresher (`http-connector.ts:169-186`). A sibling `bindCredentialSource`
  carries the override.
- Client-credentials and API-key overrides just hold their own values.

**Everything else**

- **Webhooks:** stay on the shared row.
- **Verify connection:** per override.
- **Write switch:** stays per connector.

**Lifecycle** (each one fails closed)

- **Rename:** add the table to `scripts/sync-renames.ts`, both the connector
  tables and the app tables.
- **Delete data:** a connector's deletes all its overrides; an app's deletes its
  own (`delete-data.ts`).
- **A different extension under the app's slug:** the release step deletes that
  app's overrides, as it revokes its API keys (`sync-app-registry.ts:277-314`). A
  credential given to one extension must not pass to another.
- **A replaced connector:** overrides are kept, like shared credentials, since the
  connector stays disabled until its name is typed.

**UI.** In the 3a Reach list, each app gets "Give this app its own credentials…",
which reuses the credential fields and the Connect step. The app's Reach tab shows
"Own credentials". Audited as `connector.configure` / `connector.connect` /
`connector.test`, with `app` in `details`.

**Manifest.** No change.

**Risks**

- A second credential path in the most sensitive code: refresh races and the lock
  key.
- UI confusion over which token an app is using, so it must be shown everywhere.
- An override doesn't stop a compromised app from reading *its own* token
  (bounded by Item 0, contained only by Item 4's strong tier). It bounds the blast
  radius to that token's scopes.

**Upgrade impact.** An additive migration. No override means unchanged behaviour.

**Tests** (in `npm run verify:connectors`, plus integration):

- precedence;
- fail-closed on a bad override;
- a refresh of an override doesn't touch the shared row, and vice versa;
- concurrent refresh produces one refresh;
- rename, delete and identity-change handling;
- audit rows;
- the flow cookie binds the app slug.

**Effort:** L, 6–9 days.

**As built** (2026-11-28). As designed, with these settled in the code:

- **A whole credential set.** An app's row holds the client id and secret
  too, not only a grant, so it never reads the shared row for anything.
- **Unreadable fails closed twice:** a row that can't be decrypted, or a table
  that can't be read, leaves the app's tenant connectors unconfigured, and
  bound to a renewal that refuses. The activation gate throws in the second
  case, as it does for an unreadable switch.
- **Write scopes:** an app's own consent asks for them only if changes are
  allowed *and* the app's entry asks for `"write"`, a narrowing the design
  didn't spell out.
- **The UI is inline in the Reach row**, not a second dialog, so there is one
  focus trap. Removing is audited as `connector.configure` with
  `removed: true`.
- **An admin's save starts over a row that can't be decrypted**, so "enter them
  again" works; a token write over one still fails.
- **The app's Reach tab** in the design is Item 9's page, so "Own credentials"
  shows on the connector's Reach rows for now.

---

## 7. Item 4: Keep secrets out of reach of app code

### Where each key is read today

All reads go through `platformKey()` / `optionalPlatformKey()`
(`src/lib/env/keys.ts:42-44, 109-130`), which read `process.env` **on every call**.
Nothing caches.

| Key | Read at | When |
|---|---|---|
| `CONNECTOR_ENCRYPTION_KEY` | `src/lib/connectors/config.ts:26, 156, 228, 239`; `src/lib/connectors/oauth.ts:130, 139` | each decrypt or save; each OAuth flow cookie |
| `USER_OAUTH_ENCRYPTION_KEY` | `src/lib/connectors/user-config.ts:51, 86, 97, 279` | each per-user grant read or write |
| `MCP_TOKEN_KEY` | `src/lib/mcp/oauth.ts:51` | each token or code digest |
| `APP_API_KEY_SECRET` | `src/lib/apps/api-keys.ts:41` | each key mint or check |
| `APP_SETTINGS_ENCRYPTION_KEY` | `src/lib/apps/env.ts:58, 81` | each `context.env` build with a password setting; each save |
| `APP_UNLOCK_SECRET` | `src/lib/apps/unlock-secret.ts:20` | each unlock cookie sign or verify |
| `GITHUB_APP_ENCRYPTION_KEY` (optional) | `src/lib/github/store.ts:263` | each GitHub App operation |
| `AUTH_SECRET` | Auth.js reads `process.env` itself (`node_modules/@auth/core/lib/utils/env.js:30`), because `src/lib/auth/config.ts` passes no `secret`; also `src/lib/apps/csrf.ts:94` | each session resolution; each CSRF check |
| `CRON_SECRET` | `src/app/api/cron/route.ts:48` | each tick |
| `VAPID_PRIVATE_KEY` | `src/lib/push/vapid.ts:32, 61` | each push send |
| `DATABASE_URL` / `POSTGRES_URL` / `PG*` | `src/lib/db/pg-options.ts:49-85` | first pool creation; the password then lives in the pool object on `globalThis.__pg` |

Also reachable:

- **Decrypted connector credentials**, on each connector instance (F2).
- **Every secret during `next build`** on Vercel: route modules run in the
  generator with the build's environment (§1).

Scripts (`release`, `migrate`, `keys:*`) run as separate processes and are out of
scope.

### Options, cheap to strong

| Tier | What | Stops | Doesn't stop | Vercel | Render | Railway | Compose |
|---|---|---|---|---|---|---|---|
| **T0** = Item 0 | Frozen manifest, connector facade, pool off `globalThis` | Every no-evasion route to secrets and privileges | Evasion | ✓ | ✓ | ✓ | ✓ |
| **T1** Scrub | `src/lib/env/secrets.ts` reads every secret once, from `src/instrumentation.ts` `register()`, into module-private state, then `delete`s it from `process.env`. `platformKey()`, `csrf.ts`, cron, VAPID and pg-options read from it. Auth.js gets `secret` explicitly. An ESLint rule (`no-restricted-properties`) plus a test refuse `process.env.<SECRET>` anywhere else. | `process.env` reads, env dumps in error reporters, leaks into child processes | Code that obtains `process` can read `/proc/self/environ` on Linux (deleting doesn't change the initial environment block), call platform functions, or inspect the heap | ✓ (per instance, at cold start) | ✓ | ✓ | ✓ |
| **T2** Runtime flags (spike) | `--disallow-code-generation-from-strings` blocks `eval`/`Function` process-wide, which closes F3's reflection route at runtime. Optionally Node's permission model (`--permission`, fs-read limited to the app, no `child_process`/`worker`) blocks `/proc/self/environ`. | F3; with permissions, fs and process escapes | Logic inside allowed capabilities; V8 bugs | **Verify** that `NODE_OPTIONS` is honoured for this flag | ✓ (CMD or `NODE_OPTIONS`) | ✓ | ✓ |
| **T3a** Key service | A sidecar holds the encryption keys and decrypts on request, bound to purpose and audited. | Bulk key theft for offline use | A live attacker asking the oracle; plaintext credentials used in-process | ✗ no sidecar; only a separate HTTPS deployment | ✓ private service (+cost) | ✓ private networking | ✓ container |
| **T3b** Connector gateway | Connectors run in a separate service holding credentials; apps get RPC stubs for their declared methods. | **Credentials never in the app process**, so "the manifest is the whole of what an app can do with a connector" becomes true | `DATABASE_URL` and other keys still in-process | ✗ realistically | ✓ | ✓ | ✓ |
| **T3c** Apps out of process | = Item 5b. The platform process never runs app code. | Everything above, for apps moved | Platform dependencies | partial | ✓ | ✓ | ✓ |

**Proposal.** Implement **T0** (Item 0) and **T1** after approval, and run **T2**
as a one-day spike. Ship the flag only if Next.js, Auth.js, zod (which detects
`eval` and falls back) and the rest of the server run clean under it. T3 stays a
design doc (`docs/plans/<date>-secrets-out-of-process.md`) until you decide.

**Close the scan gaps that are cheap.** Refuse `.constructor` / `["constructor"]`
member reads, `__proto__`, and `Object.getPrototypeOf` / `Reflect.getPrototypeOf`
in app code. These are rare in apps, and each refusal names the reason. Say in
§24 that computed property access on ordinary objects can't be refused, so the
scan stays "not a sandbox", and T2 is the runtime answer.

**Risks**

- `next dev` HMR re-evaluates modules after the scrub. Keep a dev-only stash
  (non-enumerable `Symbol` on `globalThis`), or skip the scrub in dev with a log
  line.
- A missed reader fails loudly at the first use, so the lint rule and test catch
  it first.
- Auth.js may read other `AUTH_*` values. Non-secret, untouched.
- T2 may break a dependency at runtime. That is why it is a spike.

**Upgrade impact.** None for operators. T2, if shipped, adds a flag to `Dockerfile`
`CMD` and the hosting docs.

**Tests**

- After `register()`, no secret name is in `process.env`.
- Sign-in, CSRF, cron, push, the MCP token flow, app API keys, unlock cookies and
  connector decryption all still work (existing integration suites, plus a
  `next start` smoke test).
- The lint rule fires on a fixture.
- Scan fixtures for `x.constructor.constructor(...)` and `Object.getPrototypeOf(fn)`.

**Docs.** §5 (where keys live, scrubbing, what it doesn't stop), §24.

**Effort:**

- T1: M, 2–4 days.
- T2 spike: S, 1 day.
- Scan additions: S, 1 day.
- T3 design doc: S–M, 1–2 days.

**As built** (2026-11-28).

- **T1** as planned: `src/lib/env/secrets.ts`, called first in `register()`.
  The stash is a frozen object under `Symbol.for("mixos.secrets")`,
  non-enumerable, not module state: Next bundles `instrumentation.ts`, the
  proxy and the routes as separate entries, which may each hold a copy of the
  module. It also deletes, without keeping, host secrets MixOS never reads
  (the rest of the Neon and Supabase integration variables, `NEXTAUTH_SECRET`,
  `INITIAL_ADMIN_PASSWORD`). A lint fence plus a tree test refuse
  `process.env.<secret>` in `src/`.
- **T2 spike: the flag fails.** `next start` doesn't boot under
  `--disallow-code-generation-from-strings`: Next's bundled
  `@edge-runtime/primitives` call `new Function` at startup, and the
  standalone server fails the same way in `depd` (through `send`). Instead,
  `register()` points `constructor` on the four function prototypes at a
  refusal (`src/lib/platform/reflection-lock.ts`). Checked: `next start` and
  `next dev` sign in, render the admin pages and run the cron tick under it,
  and the full suite passes with it preloaded (the one failure was the
  release check's known timing flake, which passed in four reruns with and
  without the lock).
- **Scan additions** as planned, plus destructured names and object-literal
  keys. The route reader's "options set their prototype" deferral can't be
  reached by app code now; its test says so.
- **F4 stays open, by decision.** Moving the pool off `globalThis` in
  production risks one pool per bundled entry, each `max: 3`. The route F4
  names, reaching the global object by reflection (F3), is now refused by the
  scan and by the lock; what remains is recorded in §24.

---

## 8. Item 5: Trust tiers for Registry apps

### Current state

- **Provenance at runtime.** `src/generated/registry-installs.ts` (`registryInstalls`,
  with `modified`) comes from each app's `.registry.json`
  (`src/lib/repository/install-record.ts:142-188`). Identity is in
  `src/lib/repository/identity.ts`.
- **Activation.** Every app, local or Registry, arrives **inactive**
  (`scripts/sync-app-registry.ts:218-231`; the column's own default is `true`,
  `0001:75`). A different extension under the slug is switched off, and Activate
  then needs the slug typed (`access.ts:203-248`).
- **Review.** "Review and register" (`src/lib/repository/review.ts:361-441`) runs
  **in a checkout**. It writes `app.register` to the *checkout's* database
  (`src/lib/repository/register.ts:351-382`), so the production database normally
  has **no record that anyone reviewed the release it runs**.
- **Gaps**
  - Activation isn't tied to a release.
  - An update keeps activation (F6).
  - Migrations run before activation (F5).
  - The tile shows no provenance (`src/components/admin/provenance.tsx:44-55`).
    It appears only in notices (`registry-notices.tsx`) and Browse
    (`src/lib/repository/provenance.ts:62-71`).

### 5a: Label, and review before activation (implement after approval)

**Label.** Two pills on the app tile and the Details dialog:

- **"Third-party"**: from `<host> · <owner>/<repo> · <version>`, with
  "modified locally" when it applies;
- **"Unreviewed"**: until an admin *on this instance* records a review of the
  exact code running.

Local apps are unchanged (the "apps you write" tier).

**Review record.** A table, `app_reviews (app_slug, code_hash, version,
commit_sha, source, reviewed_by, reviewed_at)`, with PK `(app_slug, code_hash)`.

- It is keyed on `apps.code_hash`, which the release step computes over what is
  actually deployed, local edits included (`scripts/app-code-hash.ts`).
- The review dialog works **on a built deployment** too, because `apps/**` is
  traced into the standalone build (`next.config.ts:44-49`). It reuses
  `review.ts`'s "what will run" and declarations, plus the GitHub link at the
  verified commit.
- Audited as `app.review`.

**Gate.** `setAppActive` refuses to activate a Registry app unless a review row
matches its current `code_hash`. The check is server-side; the button is
convenience.

**Updates.** The release step compares a Registry app's new `code_hash` with its
latest review. If they differ:

- it deactivates the app;
- it sets `review_needed_since` (a new column on `apps`);
- it audits `app.update.unreviewed`;
- the tile then says "Updated, needs review".

This is the behaviour change that closes F6.

**Upgrade path.** On the first release with this feature, each currently
**active** Registry app gets a review row for its current `code_hash`:

- `reviewed_by = null`, audited `app.review.grandfathered`;
- an admin notice lists them, so nothing working switches off on upgrade.

Inactive ones start unreviewed. **Decision for you:** grandfather (recommended, no
breakage) or fail closed (every active Registry app needs a review after the
upgrade).

**Migrations before review (F5).** Options:

- **(i)** Leave as is, and show "its migrations already ran" in the review.
- **(ii)** The release step skips SQL for unreviewed Registry apps. The app then
  shows "being updated" after Activate until the next release step, which on
  Vercel means a redeploy.

I recommend (i) now, with (ii) as a later option.

**Manifest and `.registry.json`.** No change.

**Risks**

- More friction for admins, which is the point.
- `code_hash` and `filesHash` semantics differ (`.registry.json` excluded, symlinks
  followed). Keying on `code_hash` is deliberate and tested.
- Reviews on a shared database across preview and production builds: the row is
  keyed by hash, so a preview reviewing a different build's code doesn't count for
  another.

**Upgrade impact.** A platform migration (new table and column), plus the backfill
above.

**Tests**

- Activate is refused without a matching review, and allowed with one.
- An update deactivates and flags; local apps are unaffected.
- A modified Registry app needs a review of its modified hash.
- The grandfather backfill.
- Audit rows.
- The review dialog on a standalone build (fixture).

**Docs.** §31 (a new subsection on trust tiers), §3.1, `docs/hosting/after-you-install`,
the threat model's "compromised app code" row.

**Effort:** M–L, 4–6 days.

**As built** (2026-11-28), with the decisions: no grandfathering,
deactivation on an unreviewed update, and migrations option (i).

- **The current code hash is read live** from the app's folder, which every
  host carries, falling back to `apps.code_hash`, so a local edit in a dev
  server needs a review before Activate, not only after the next release step.
- **Third-party is read from the build's install records and the recorded
  identity**, so a dev server that hasn't reloaded its generated files since a
  Register still gates the app; an unreadable identity counts as third-party.
- **Register records a review** (`via: "register"`) in the checkout's database,
  since it is one: Register refuses anything but the files the admin
  confirmed. Without it, "Activate in this checkout" would always be refused.
- **Two audit actions:** `app.update.unreviewed` (earlier code was reviewed)
  and `app.review.required` (none was, as after the upgrade).
- **The review dialog** lists the manifest's declarations itself, rather than
  reusing `review.ts`, which reads a pending package; it runs on any built
  deployment because it reads only the manifest, the install record and the
  folder's hash.
- **Not built:** a standalone-build fixture test of the dialog. The hash path
  it depends on, the folder on disk, is the API router's too.

### 5b: Running Registry apps out of process (design doc only)

**Constraint.** App code is compiled into the Next server bundle through the
`@apps` alias. Every loader is a literal `import()` (`src/generated/app-route-loaders.ts`,
`next.config.ts:61-71`), and server pages and `hooks.ts` run inside Next's render.
So any out-of-process tier must:

- build Registry apps into a separate artifact;
- give them an RPC `context` whose every capability is executed by the platform:
  db as the app's role (Item 2), connectors (T3b), egress, env;
- and, at least at first, **refuse server pages and `hooks.ts`** for that tier.
  Widgets and client pages already run in the browser.

| Option | Isolation | Covers | Vercel | Render / Railway / Compose | Cost |
|---|---|---|---|---|---|
| `node:vm` | **None.** Node documents it as not a security mechanism | | | | reject |
| `worker_threads` | Separate heap, same process. Full Node API, env copy, `/proc` | | | | reject |
| `isolated-vm` | V8 isolate, no Node APIs; same OS process (a V8 bug escapes) | handlers only | possible (native addon, build-image specific) | ✓ | low run cost; native-addon upkeep, project in maintenance mode |
| `workerd` sidecar | Separate process plus V8 isolates, capability bindings | handlers only | ✗ | ✓ (extra container or service) | one extra service; a new runtime to learn |
| **Separate Node "app runner" service** | OS process and container; no platform secrets in its env; network-restricted | handlers (routes, jobs, services, MCP, search) | ✗ realistically (each context call would be an internet round trip) | ✓ (Render private service, Railway service, Compose container) | +1 instance; an RPC hop per context call; a second build output |

The design doc would recommend the app-runner service as the target, with
`isolated-vm` as a possible single-process fallback where a second service isn't
available, and state that Vercel installs stay in-process.

**Effort:** S–M, 2 days for the doc.

---

## 9. Item 6: Per-app detection

### Current state

- `telemetry_events` (`0001:450-478`) records:
  - connector calls: `source_slug` = connector, `caller_app_slug` = app,
    `event_name` = method, `outcome`, `error_category`
    (`src/lib/apps/telemetry.ts:64-86`);
  - service calls and MCP calls (written before the handler runs);
  - routes;
  - declared app events.
- Gaps:
  - no `mutates` on the row (derivable from `connectorRegistry`);
  - no duration;
  - refused calls (undeclared, unauthorized write, over budget, disabled) are
    never recorded (`connector-reach.ts:71-74`, `route.ts:554-559`,
    `context.ts:263-269`);
  - egress isn't recorded anywhere (`http.ts`, `http-connector.ts:406-411`).
- `source_type` is CHECK-constrained to five values.
- Cron GC (`src/app/api/cron/route.ts:74-90`) prunes route telemetry at 30 days,
  rate buckets, webhook markers, unlock failures and builds-seen.
- Admin > Apps already has:
  - the pill and strip pattern (`app-tile.tsx:221-299`);
  - a one-click Deactivate notice (`registry-notice-deactivate.tsx:20-57`);
  - a cron, store, notice pipeline to copy (`update-check.ts` into
    `platform_settings`, then `registry-notices.tsx`).

### Change

**Recording**

- **Egress.** One fire-and-forget row per `context.http` hop, including redirects:
  `source_type = 'egress'`, `source_slug` = host, `caller_app_slug` = app,
  `outcome` ok/error/refused, at `http.ts:366` (refusal) and after
  `requestPinned` (`:381`). This needs a platform migration to extend the CHECK
  (`'egress'`) and `outcome` (`'refused'`).
- **Refused connector calls.** The facade (Item 0) and the budget proxy record
  `outcome = 'refused'` with `error_category` = `undeclared` / `write-not-asked` /
  `write-not-allowed` / `budget` / `disabled`.
- **Connector hosts (optional).** `HttpConnector.attempt` records the host it
  contacted, bound to the calling app the way `allowWrites` / `bindUserGrant` are
  bound.

**Baseline**

- `app_activity_seen (app_slug, kind, subject, first_seen_at, last_seen_at)`,
  with PK `(app_slug, kind, subject)`, where `kind` ∈ connector-method / egress-host.
- It is bounded by each app's declared surface. A cap of 500 subjects per app,
  past which a single "too many distinct subjects" anomaly is raised.
- Filled by the detector, not per call.
- Backfilled from existing telemetry on the first run, which records a baseline
  silently instead of flagging everything as new.

**Detector**

- Runs in the cron tick, at most every 15 minutes, gated by a `platform_settings`
  timestamp as the update check is. Its work is bounded by indexes and windows:
  a new partial index `(caller_app_slug, created_at) where source_type in
  ('connector','egress')`.
- It writes `app_anomalies (id, app_slug, kind, subject, detail jsonb,
  first_seen_at, last_seen_at, count, acknowledged_by, acknowledged_at)`, unique
  `(app_slug, kind, subject)`.
- Rules:
  - first-ever call to a `mutates` method;
  - first contact with a host (meaningful for wildcard egress);
  - **any refused egress or refused connector call** (the strongest probing
    signal);
  - volume spike: calls in the last hour > 10× the trailing-7-day hourly mean and
    > 100. The constants live in one file.

**UI**

- An "Unusual activity" danger pill and strip on the tile, listing each anomaly.
- **Deactivate** (the existing `setAppActiveAction`, one click with a confirm,
  audited `app.deactivate`).
- **Mark as expected** (audited `app.anomaly.acknowledge`).
- An admin notice above Admin > Apps when any are open.
- The Details > Reach tab adds "Observed vs declared": methods called and hosts
  contacted in the last 30 days.

**Retention** (bounded, on the existing cron GC)

- `egress` and `connector` rows: 90 days. This keeps the Analytics 90-day range.
- `app_anomalies`: acknowledged ones after 180 days.
- `app_activity_seen`: bounded by the cap.

**Decision for you:** pruning `connector` rows at 90 days changes today's "kept
forever". `app`, `mcp` and `service` rows stay as they are, per the comment at
`telemetry.ts:196-203`.

**Fails open, deliberately.** Recording is best-effort, so a telemetry failure
never fails a call, and the detector never deactivates on its own. This is a
record, not a gate (the same reason as audit rule 2 in §28): false positives
taking apps down would be worse than the delay of an admin's click. Automatic
deactivation for refused-egress on Registry apps could be a later, opt-in policy.

**Risks**

- One more INSERT per `context.http` request (parity with connector calls).
- Detector query cost, bounded by the index and the windows.
- False positives on spikes, which is why "Mark as expected" exists.
- New app-keyed tables must be added to `delete-data.ts` and `sync-renames.ts`.

**Upgrade impact.** A platform migration (CHECK constraints, two tables, an
index) and the backfill. No manifest change.

**Tests**

- Each rule fires on synthetic telemetry and stays quiet on the baseline.
- Refused paths record rows.
- Egress records each redirect hop.
- Caps and retention.
- Deactivate from the strip; acknowledge audited.
- Rename and Delete data cover the new tables.

**Docs.** §26 (telemetry), a new "Detection" subsection, §20 (GC list), the threat
model's "compromised app code" row.

**Effort:** L, 5–8 days.

**As built** (2026-11-28), with the decisions: connector rows kept, and no
automatic deactivation.

- **Recorded refusals:** the facade (`undeclared`, `write-not-asked`,
  `write-not-allowed`), the route's budget (`budget`) and the disabled stand-in
  (`disabled`). The read-only layer for MCP and search doesn't record its
  refusals yet.
- **Egress** records each hop, with the status for an answered one, `dns` and
  `network` errors, and `host`, `scheme` and `address` refusals. The answered
  and redirect paths aren't covered by an integration test, which would need a
  public host; the refusals are.
- **`new-host`** fires only for a host the egress list doesn't name literally,
  as planned ("meaningful for wildcard egress").
- **The detector runs in one transaction**, holding the timestamp row's lock,
  so concurrent ticks serialize instead of double-raising.
- **Mark as expected** marks the anomalies the tile shows, at most three at a
  time, not ones the admin hasn't seen.
- **Observed vs declared** is read when the Reach tab opens, as the schema is.
- **Delete data** now deletes the app's egress rows with its own telemetry.
- **Not built:** connector hosts recorded by `HttpConnector.attempt` (optional
  in the plan).

---

## 10. Direction (answered 2026-11-27)

These answers set what Items 5b and 7–10 aim at, and how the earlier items are
weighed.

| Question | Answer | What it changes |
|---|---|---|
| Who are we protecting against, most? | **A malicious third-party app or connector from mixos.org.** | Process separation (5b, 7b) is the goal, not a stretch. Item 2 matters most as the enforcement point the out-of-process runner calls into: on its own, a raw handle can `RESET ROLE`. |
| Must the strongest tier work on Vercel? | **No.** Strong isolation on Docker, Render and Railway; Vercel is same-process, and says so. | Admin pages and labels (Item 9) state the host's tier. Nothing claims isolation on Vercel. |
| How far should connector isolation go? | **(c):** isolate connectors from each other and from the platform, not only from apps. | Item 7b runs each connector in a process of its own holding only its own credentials. |
| What can it cost? | **Extra latency** is acceptable. | Not a second billed service, and not new limits for developers. So the isolated tier is a second *process* in the same container or service (a separate container under Compose, which costs nothing). Server pages and `hooks.ts` run inside Next's render, so the 5b/7b design has to show whether they can be isolated or need a limit after all. That is the open question that design must answer. |
| How should people know? | **The public threat model** (Item 1), **a per-app "what this app can reach" page** (Item 9), and **security tests in CI that try known escapes against every release** (Item 9). | No audit or bounty planned. |

**Shared infrastructure.** 5b (apps out of process) and 7b (connectors out of
process) need the same pieces:
- a supervisor that starts processes with no platform secrets;
- an RPC channel over a Unix socket;
- a per-request capability token;
- a way to hold each process's network to what it declared.

They get one design doc, written after Item 4.

---

## 11. Item 7: Isolated connectors, and narrowing per app

### Current state

- **Connector code runs in the platform process.** It is third-party code when it
  comes from the Registry, and it is bundled into the server through the
  generated `connector-loaders.ts` map (`src/lib/connectors/loader.ts:57-76`).
- **Construction and credentials.** Connectors are constructed fresh per context
  build (`src/lib/apps/context.ts`, `loadTenantConnectors`) and handed decrypted
  credentials there (`src/lib/connectors/config.ts:14-28`,
  `src/lib/connectors/user-config.ts`). The encryption keys are in that process.
- **Isolation today.** After Item 0, an *app* holds only a facade. A *connector's
  own code* can still read `process.env` (connectors are not scanned the way apps
  are) and reach every other connector's module and the platform's.
- **Webhooks** (`src/app/api/webhooks/[name]/route.ts`), OAuth refresh write-back
  (`config.ts:298-348`) and Test Connection all run connector code in-process.
- **What an app may call** is per connector: the declared methods, plus writes
  when `access: "write"` and the connector-wide `connector.writable.<name>`
  (`src/lib/apps/connector-reach.ts:99-124`). An admin can't narrow one app's
  reach below that.

### 7a: Narrowing per app (every host; implement after approval)

**Storage and enforcement.**
- `connector_app_access (connector_name, app_slug, writes text not null default
  'inherit' check (writes in ('inherit','deny')), methods text[] null, set_by,
  set_at)`, PK `(connector_name, app_slug)`.
- `deny` takes an app's writes away even when its entry asks and changes are
  allowed.
- `methods`, when set, is an allowlist within what the app could reach.
- Enforced in `appReachRules` / the facade: a refused method gets a
  `ConnectorUseError` naming the admin's setting. Fail closed: when the row can't
  be read, the app gets reads only, as the write switch does today.

**UI.** In Item 3a's Reach section: "Can't change data" and "Only these methods…"
per app. Audited as `connector.app.access`.

**Lifecycle.**
- **Rename, Delete data:** add the table to `sync-renames.ts` and
  `delete-data.ts`.
- **A different extension under the app's slug:** its rows are deleted, as its
  API keys are revoked. The restriction was set for the extension before it.

**Effort:** S–M, 2–4 days.

**As built** (2026-11-28).

- **Its own error,** `ConnectorNarrowedError` (`forbidden`), not a
  `ConnectorUseError`: the limit is the admin's, not a bug in the app. MCP and
  search pass its message on. Refusals are recorded as `narrowed` (Item 6).
- **Unreadable fails closed to reads only**, as planned, for every connector of
  that context.
- **The Reach section shows the limit:** a **Limited** pill, the rows' reads
  and writes computed with it, and a "Limits…" panel per row.
- **Only declared methods are kept;** an empty list is refused (deactivate the
  app instead), and every method ticked deletes the row.
- **The activation gate ignores it,** so an admin can run an app with its
  writes taken away.
- **Delete data** counts a connector's limits with its settings.

### 7b: Connectors out of process (Docker, Render, Railway; Vercel stays in-process)

**Design first**, in the doc shared with 5b. The shape to evaluate:

- **A connector runner per connector.** A child process started by a supervisor
  in the same container, under its own OS user, with an empty environment. Under
  Compose it is a separate container on an internal network. It receives only
  its own decrypted credential set, at call time, from the platform, which keeps
  the encryption keys.
- **Calls are RPC.** The facade's declared methods become stubs that send
  `{connector, method, args, app, user?, token}` over a Unix socket. The runner
  checks the method against the connector's own declaration, runs it, and
  returns the result.
  - Results are already plain upstream data (`z.looseObject`).
  - Binary results and `ConnectorError` (category, user message, admin hint) need
    a defined wire form.
- **Token write-back.** Refreshed tokens come back to the platform, which
  encrypts and stores them. The runner never holds a key.
- **Webhooks.** The platform verifies the signature, then forwards the event to
  the runner's `handleWebhook`.
- **Egress.** Each runner is held to the hosts its manifest names (`http.baseUrl`,
  the token endpoint, plus an admin's `baseUrl` credential).
  - Under Compose: an egress proxy on the internal network.
  - In one container: Node's permission model, if its network permission is
    usable by then; otherwise this is the design's other open question.
- **Vercel and `next dev`.** In-process, as today. The admin pages say
  "Connectors run in the server process on this host".

**Risks**
- Serialization edge cases.
- The latency of a hop per call (accepted).
- Memory per runner.
- Cold starts.
- Keeping `HttpConnector`'s retry and budget behaviour identical across the
  boundary.

**Upgrade impact**
- On the Docker image, a launcher replaces `CMD ["node", "server.js"]`.
- The hosting docs gain a line.
- **Fail closed:** where isolation is on and a runner can't start, that connector
  is unavailable. It does not fall back to in-process.

**Tests**
- `npm run verify:connectors` run through the runner.
- Escape fixtures (Item 9):
  - a hostile connector reading `process.env`;
  - reading another connector's credentials;
  - importing a platform module;
  - reaching an undeclared host;
  - each contained on the isolated tier, and pinned as a known in-process limit
    on Vercel.
- A latency benchmark beside Item 2's.

**Effort**
- Design doc: S–M, 2–3 days, shared with 5b.
- Implementation: L–XL, 10–15 days, after you approve the design.

---

## 12. Item 8: Approve capabilities, not just apps

### Current state

- Activation is all-or-nothing per app (`setAppActive`, `src/lib/apps/access.ts:203-248`).
- Nothing records *which* capabilities an admin approved.
- An update keeps its activation (F6). Item 5a deactivates a Registry app whose
  code changed until it is reviewed.
- Two per-capability switches exist already, and are the pattern to extend:
  - "Allow changes" per connector (`platform_settings`, `connector.writable.<name>`);
  - MCP tools per tool (`app_mcp_tool_settings`).

### Change

1. **Record what was approved.**
   - `app_capability_approvals (app_slug, kind, capability, approved_by, approved_at)`,
     PK `(app_slug, kind, capability)`.
   - Kinds: egress host, connector, connector write, consumed service, provided
     service, hook listened to, MCP tool, notifications, database, schedule,
     public route tier (`public` / `password` / `key`), branding hook.
   - Normalized from the manifest by one function, so reordering is no change.
   - Written when an admin activates (the whole current set) and when they approve
     a diff.
2. **Growth means re-approval.** At each release step, an app whose manifest asks
   for a capability not on its approved list:
   - **Registry apps:** switched off and flagged "Asks for more" (a new
     `capabilities_pending_since` column), with only the added capabilities
     listed. Fail closed.
   - **Local apps:** get the flag and a notice, and stay on. They are the
     "apps you write" tier. *(Decision for you: flag only, or also switch off?)*
   - Approving the diff is `app.capabilities.approve`. A capability that is
     removed is simply removed.
   - For a Registry app, 5a's review dialog leads with this diff.
3. **Deny one capability, keep the app.** Admin toggles for the capabilities that
   degrade cleanly:
   - an egress host (`context.http` refuses it);
   - connector writes for this app (7a);
   - an optional connector;
   - a consumed service (`NOT_ALLOWED`);
   - notifications (`context.notifications` is null);
   - MCP tools (exists).

   Everything else is all-or-nothing, as it is now, because an app can't run
   without it. Docs say which are which.
4. **Unused write access expires.**
   - The rule: if an app hasn't made a successful call to a `mutates` method on a
     connector in 90 days, its write toggle for that connector is turned off.
     Connector telemetry is kept forever (decision), so the history is there.
   - Its admins see a notice, and it is audited as `app.capability.expired`.
     Turning it back on is one click.
   - Runs in the cron tick, after Item 6's detector.

### Risks

- A normalized-set bug that reads every build as growth: tests with real
  manifests.
- Apps that don't handle a denied capability gracefully: only clean-degrading
  kinds are toggleable.
- Admin fatigue: only *growth* re-prompts, never a code-only change. For Registry
  apps that is 5a's job.

### Upgrade impact

A platform migration. Backfill:
- every **local** app gets its current set as approved, so nothing switches off;
- Registry apps get none. There are none installed yet, consistent with the
  no-grandfathering decision.

### Tests

- Growth is detected and the app switched off.
- Shrinkage and reordering are no change.
- Approving a diff turns the app back on.
- Each toggle makes its capability absent at runtime.
- Expiry fires at 90 days and not before.
- Audit rows.
- Rename and Delete data cover the table.

**Effort:** M–L, 5–7 days.

---

## 13. Item 9: Trust you can check

### Current state

- The Details dialog's Reach tab lists an app's required connectors (not optional
  ones) and egress hosts (`src/components/admin/app-details-dialog.tsx:479-575`).
- The register review shows the manifest's declarations beside the publisher's
  claims (`src/lib/repository/review.ts`).
- No labels.
- Item 0's `context-reach.integration.test.ts` is the first test that tries an
  escape.

### Change

1. **Labels from enforcement, never from claims.**
   - Each label has a written definition, the enforcement point that makes it
     true, and an escape-suite case that tries to break it. A label with no
     enforcement behind it is not shipped.
   - Starting set:

     | Label | When it is true |
     |---|---|
     | **Stays on this instance** | No egress, no connectors |
     | **Read-only** | No connector writes |
     | **Its own data only** | No `consumes`, and no `listensTo` on other apps |
     | **No public routes** | |
     | **Runs isolated** | The host's tier and the app's |
     | **Runs in the server process** | Shown wherever "Runs isolated" isn't true |

   - Computed from the release's manifest on Browse (before install), in the
     register review, on the tile, and on the Reach page.
2. **The Reach page.** One page per app, in Admin. It shows:
   - everything the app *can* reach: manifest, admin toggles (Items 7a, 8) and
     host tier;
   - beside each, what it *did* in the last 30 days (Item 6);
   - its labels;
   - its approval history (Item 8).

   Built only from the platform's own records.
3. **The escape suite.**
   - Lives in `tests/escapes/`: hostile fixture apps and connectors, each trying
     one known escape:
     - manifest or user writes;
     - connector credential reads;
     - `Function` by reflection;
     - the global object and `process`;
     - the pool on `globalThis`;
     - `Object.prototype` pollution of shared modules;
     - `RESET ROLE` through a builder bypass;
     - DNS rebinding and redirect SSRF;
     - egress to an undeclared host;
     - another app's schema;
     - MCP writes;
     - services impersonation;
     - a connector reading another connector's credentials.
   - Each case names its expected outcome per host tier: refused at build,
     refused at runtime, contained, or **a known limit**, which is an expected
     failure linked to the threat model's row.
   - CI runs it on every pull request and release, so the threat model and the
     suite can't disagree.
   - Every later item adds its cases.

### Risks

- A label read as broader than its definition: each one links to its definition.
- Suite upkeep: cases are small fixtures, one escape each.

### Upgrade impact

None.

**Effort**
- Labels and the Reach page: M, 4–6 days.
- The suite: S–M, 3 days to start, then growing with each item.

---

## 14. Item 10: Verified publishers, and an opt-in kill switch

### Current state

- mixos.org signs each release (Ed25519) over kind, slug, version, tag, commit,
  content hash and floor (`src/lib/repository/release-signature.ts`).
- The install record names the GitHub repository (`install-record.ts:142-158`).
- A publisher's identity is the repository owner: nothing says it was verified.
- The daily update check shows a withdrawn release with its reason and a
  Deactivate button, and never acts on it, by design (`update-check.ts`,
  `updates.ts`). Its answer isn't signed.

### Change

1. **Verified publisher.**
   - **On mixos.org** (another repository): domain or organisation verification,
     and 2FA required to publish.
   - **Here:** the signed release payload gains a `publisher` block (`verified`,
     `name`, `method`) covered by the signature.
   - Browse, the review, the tile and the Reach page show
     "Verified publisher · <name>" only when the signature covers it.
   - This is a change to the signed payload, and `.registry.json` would record
     it: a **versioned schema change**. `.registry.json` v2 adds the field;
     v1 records are still read, and show no badge.
2. **An opt-in kill switch.**
   - The update-check answer gains a **signed** withdrawal with
     `severity: "security"`.
   - An admin setting, off by default, lets the cron tick deactivate an app whose
     installed release has such a withdrawal. It is audited as `app.deactivate`
     with actor `update-check`, and a notice says why.
   - **Fails open**, deliberately: an unreachable or unsigned answer does
     nothing. It is an availability-affecting action taken on a remote party's
     word, which is why it is opt-in and why the answer must be signed.

### Risks

- A dependency on mixos.org shipping its half.
- A compromised mixos.org signing key could switch apps off where the setting is
  on (an availability risk, not an access one).
- Badge confusion: it means "we checked who published this", not "this is safe".
  The label's definition says so.

### Upgrade impact

- `.registry.json` v2, with v1 still read.
- Nothing changes until an admin opts in.

### Tests

- A signed publisher block shows the badge; an unsigned or tampered one doesn't.
- v1 records are read.
- The kill switch acts only with the setting on and a valid signature, and is
  audited.

**Effort:** here, M, 3–5 days. mixos.org's half is separate.

---

## 15. Order, dependencies, and per-PR routine

1. **Item 0.** No-evasion gaps (F1, F2, F9 code fixes, doc corrections; F4 moved
   to Item 4). *Merged, #137.*
2. **Item 1.** Threat model, written against post-Item-0 code. *Merged, #138.*
3. **Item 2.** Postgres-enforced isolation (spike first). *In review.* Then the
   F10 fix, its own small PR (decided 2026-11-27). *In review:* `max_pipeline: 1`
   through `*.pooler.supabase.com:6543` only (turning pipelining off everywhere
   halved throughput under load at 2 ms RTT, 653 → 345 q/s), plus
   `query_timeout: 60` on the request pool.
4. **Item 3a**, then **3b**. *3a in review:* the Reach section, built as below
   with the departures under "As built". *3b in review:* migration 0005
   (`connector_app_configs`, and `app_slug` on `connector_scope_status`), as
   designed, with the departures under its "As built".
5. **Item 4.** T1 plus scan additions; T2 spike; T3 design doc. *In review:*
   T1 and the scan additions as planned; the T2 flag can't be used (Next 16
   doesn't boot under it), so T2 ships as a lock on every function
   prototype's `constructor`; T3 is
   [`20261128_0128-secrets-out-of-process.md`](20261128_0128-secrets-out-of-process.md).
6. **Item 5a.** Then **one design doc for 5b and 7b**, the shared runner
   infrastructure (§10). *5a in review:* migration 0006, with the departures
   under its "As built". *The 5b/7b design is*
   [`20261128_0146-out-of-process-runners.md`](20261128_0146-out-of-process-runners.md),
   *in review, with four decisions for you; it answers the open question:
   server pages of Registry apps need a limit (client pages only) on the
   isolated tier.*
7. **Item 6.** Detection (benefits from Item 0's facade for refused-call
   recording). *In review:* migration 0007, with the departures under its
   "As built".
8. **Item 7a.** Per-app narrowing; builds on 3a's Reach section. *In review:*
   migration 0008, with the departures under its "As built".
9. **Item 8.** Capability approvals; builds on 5a and 7a. Expiry uses Item 6.
10. **Item 9.** Labels, the Reach page and the escape suite. The suite starts
    earlier: Item 2's PR seeds `tests/escapes/` with Item 0's and its own cases,
    and each later item adds to it.
11. **Item 10.** Verified publishers and the kill switch, once mixos.org's half
    is ready.
12. **5b and 7b implementation**, if you approve the design.

Each item gets its own branch and PR, opened with `/mixos deploy`. Before each PR:

- `npm run lint`
- `npm run typecheck`
- `npm test`, with `MIXOS_TEST_DATABASE_URL` pointing at a throwaway Postgres.
  The install lease test is known to be flaky; I'll say so in the PR rather than
  retry it quietly.
- `npm run build`
- `npm run verify:connectors` where connectors are touched.

Each PR:

- updates `docs/security-architecture.md` and `docs/threat-model.md` for what it
  changes;
- states any check that fails open, and why.

**Total:** roughly 30–45 working days for Items 0–6. Items 7a and 8–10 add
roughly 15–25, and 5b and 7b implementation, if approved, another 20–30.

---

## 16. Decisions (answered 2026-11-27)

- **Item 0:** approved, lands first.
- **Item 2:** the restated acceptance test is approved.
- **Item 3b:** the design is approved for implementation.
- **Item 5a:** no grandfathering. There are no Registry apps installed yet, so an
  active Registry app needs a review after the upgrade (fail closed).
- **Item 6:** connector telemetry is **not** pruned, and stays kept forever as
  today. Only what Item 6 adds is bounded: egress rows and anomaly rows.
- **This file:** moves to `docs/plans/` once it is safe to commit, after Item 0
  ships.
- **Direction for 5b and 7–10** (second round): see §10. Items 7–10 are added.
- **Not answered, so the recommendations stand:**
  - 3a shows reachable plus observed methods;
  - Item 4 is T0 + T1 + scan additions, T2 a spike, T3 a doc;
  - 5a deactivates on an unreviewed update, with migrations option (i);
  - Item 6 has no auto-deactivation.

### The questions as originally asked

1. **Item 0.** Approve it as its own PR, landing first. Through a private security
   advisory fork or a normal PR?
2. **Item 2.** Accept the restated acceptance test: a bypass through the executor
   is refused, and the raw-pool limit is pinned and documented. Also the
   per-query transaction and no kill switch.
3. **Item 3a.** Show *reachable* plus *observed* methods per app, since apps don't
   declare methods.
4. **Item 3b.** Approve the new-table design for implementation, or stop at the
   design.
5. **Item 4.** The cheap tier is T0 plus T1 plus the scan additions. T2 is a
   spike. T3 stays a doc.
6. **Item 5a.** Grandfather currently active Registry apps on upgrade, or fail
   closed? Deactivate on an unreviewed update (recommended)? Migrations before
   review: option (i) or (ii)?
7. **Item 6.** Prune `connector` telemetry at 90 days? Keep auto-deactivation off?
8. **This file.** Keep it uncommitted until Item 0 ships, then move it to
   `docs/plans/`?
