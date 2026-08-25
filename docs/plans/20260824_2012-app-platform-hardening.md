# App platform hardening: one declared contract, enforced

## Context

The app platform exposes 17 surfaces to app authors — manifest, pages, widgets,
API routes, scoped DB, connectors, jobs, App Services, MCP tools, notifications,
telemetry, hooks, assets, roles, data-freshness patterns, the design system, and
the app shell. They were built incrementally and they are not equally hard.

The **MCP surface is the strictest thing in the system**: a tool must export a
Zod `inputSchema`, gets its input validated before the handler runs, receives a
read-only DB client enforced at three layers (type, runtime Proxy, ESLint), is
build-validated for a missing handler or a 6th tool, and is auto-audited on every
call. Meanwhile **API routes — the surface actually exposed to browsers and, when
public, to the open internet — declare nothing.** No input schema, no output
type, no declared authorization. `createAppClient(slug).get<T>()` is an unchecked
assertion. Roles are declared in the manifest but the platform enforces none of
them, so forgetting `hasRole` fails *open*.

That inversion is the core problem. The rest follows from it.

### What is actually true today

- **The gateway is bypassable.** `apps/**/lib/server/**` is allowlisted to import
  connectors ([eslint.config.mjs:83-89](../../eslint.config.mjs#L83-L89)) and
  nothing stops a server page importing it. That page reaches connectors and the
  DB without the rate limiter, without `apiVisibility`, without telemetry.
  [secure-edge-gateway-architecture.md:173](../secure-edge-gateway-architecture.md#L173)
  even documents `buildAppContext()` as callable from a page — while
  [eslint.config.mjs:60](../../eslint.config.mjs#L60) bans that import. The doc
  and the lint contradict each other.
- **The rate limiter does not limit.** It is in-memory
  ([src/lib/rate-limit.ts](../../src/lib/rate-limit.ts)); on Vercel every lambda
  instance holds its own bucket, so the documented "60 burst / 10 per second" is
  per-instance and effectively unbounded.
- **Apps can read any environment variable.** Nothing lints `process.env` in
  `apps/**`. A route handler can read `CONNECTOR_ENCRYPTION_KEY` or
  `SUPABASE_SERVICE_ROLE_KEY`.
- **Apps can fetch any host.** [security-architecture.md §13](../security-architecture.md)
  says there is no SSRF defence and calls it "a gap to close *before* the next
  feature that fetches a URL." App routes can already do it.
- **A route has exactly one visibility.** "Public, but richer when signed in" is
  not expressible. There is no machine-to-machine tier at all.
- **The component library does not exist.** `src/components/ui/` holds ten
  components and **no Button, Input, Select, Table, Form, Badge, Toast, Menu, or
  Pagination**. Every app hand-rolls its buttons and tables, which is exactly
  where the accessibility and contrast failures come from. The evidence is in our
  own docs: 86 hand-rolled card shells, ~215 sub-AA elements green in CI, 135 of
  them the single `bg-muted` + `text-muted-foreground` pair.
- **Data freshness is 400 lines of convention.** Every app re-implements
  watermarks, budgets, window tuning and invalidation. One got it wrong and
  produced 278 consecutive job failures over 19 days.

### The fact that makes this cheap

`apps/` contains only `_template`. **There is nothing to migrate.** Every rule
below can ship as a build error rather than a warning, and the contrast rule can
go straight to `error` instead of waiting out a backlog that no longer exists.

### Intended outcome

One declared contract per route, enforced by the platform in both directions, on
the assumption that an agent wrote the app and nobody read the diff. Flexibility
is preserved by making escapes *declared and visible* rather than by leaving
holes open.

---

## Decisions

Locked with the user before writing this.

| # | Decision |
|---|---|
| 1 | **One contract, two transports.** All data access goes through a declared route contract. Pages cannot import `lib/server`, connectors, or `db`; a server component calls its own route in-process via `context.call()` — identical validation, authz and telemetry, no network hop. SSR survives; the second authorization surface does not. |
| 2 | **Full declaration, gateway-enforced.** Each route declares method, Zod input, Zod output, accepted auths, required roles, and a cost budget. The gateway validates both directions and enforces roles **default-deny**. An undeclared route is a 404. |
| 3 | **Build the component set, then mandate it.** Ship the missing primitives, then lint-ban raw `<button>`/`<input>`/`<table>` and hand-rolled card shells. Async states become structural. Contrast rule to `error`. `disableOsStyles` removed. |
| 4 | **Assume an agent wrote it, unreviewed.** Enforce at runtime where cheap, at build where not. `process.env` and raw `fetch` become declared allowlists. |
| 5 | **A route declares a set of accepted auths** (`["session", "public"]`) and the handler receives a discriminated context — TypeScript forces both branches. |
| 6 | **Per-app scoped API keys** for machine-to-machine access: declared route scopes, expiry, hashed at rest like the MCP tokens, rate-limited per key, revocable, audited. |
| 7 | **Declarations are co-located exports**, hoisted into the registry by the generator. Types flow; the contract cannot drift from the code; `app.json` stays about the app. |
| 8 | **Escapes are explicit, declared and visible** — an app declares each exception in its manifest with a reason string, shown on the admin page. Escaping is possible, never silent. |
| 9 | **One design spec, then build in phases.** This document. |
| 10 | **Data freshness becomes a platform capability.** The app declares a sync and writes only the fetch and the mapper; the platform owns watermarks, budget, window tuning and invalidation. |
| 11 | **Rate limiting is Postgres-backed.** Supabase is already there and already runs the scheduler's atomic claim. No new service, no new secret. |

### Consequences worth stating plainly

- **Handlers stop returning `Response`.** They return a plain object; the platform
  serializes, sets the status, and maps thrown errors. This deletes a whole bug
  class (raw `error.message`, forgotten status codes, missing `NextResponse`) but
  it is the single largest ergonomic change here. A `raw: true` variant stays for
  file streams and the App Services binary passthrough.
- **The output schema fixes the `numeric`-returns-a-string bug for free.**
  [database.md](../apps/database.md) spends 40 lines on it — a `numeric` column
  arriving as `"42.5"` and silently failing a `Number.isFinite` guard. A declared
  output schema catches that on the first request in dev, permanently.
- **Public API URLs change shape.** A route accepting a public auth is *derived*
  into the `/api/p/<slug>/...` mount rather than declared there. There are no
  public routes today, so nothing breaks.
- **`disableOsStyles` is removed outright**, not deprecated. It is a blank-slate
  escape from the entire design system and cannot coexist with decision 3. An app
  that genuinely needs it should say so and we will design a narrower escape.
- **Cross-app hook listening is a hole this plan closes.** Today any app can
  `addAction("other-app:thing", fn)` using the full prefixed name — a cross-app
  channel with none of the two-sided consent App Services requires. It gains the
  same default-deny model.

---

## The model

### 1. The route contract

```ts
// apps/my-app/api/items/route.ts
import { z } from "zod";
import { defineRoute, AppError } from "@/lib/apps/route";

const Item = z.object({ id: z.string(), name: z.string(), total: z.number() });

export const GET = defineRoute({
  auth: ["session"],                       // accepted auths, strongest wins
  roles: ["viewer", "editor"],             // any-of; omitted = any accepted auth
  input: z.object({
    limit: z.number().int().min(1).max(200).default(50),
    scope: z.enum(["mine", "all"]).default("all"),
  }),
  output: z.object({ items: z.array(Item), truncated: z.boolean() }),
  budget: { connectorCalls: 20, ms: 8_000 },
  handler: async (ctx, input) => {
    const rows = await ctx.db.table("items").select("*");
    if (!rows) throw AppError.notFound("No items");
    return { items: rows.slice(0, input.limit), truncated: rows.length > input.limit };
  },
});
```

- **`input`** merges query params (GET/DELETE), JSON body (POST/PUT/PATCH), and
  dynamic path segments into one validated object. Coercion is applied for query
  strings, so `?limit=20` arrives as a number.
- **`output`** is validated on every response by default. A hot path may declare
  `output: { schema, validate: "dev-only" }` — a *declared escape*, so it shows
  up in review rather than being a quiet omission.
- **`handler`** returns plain data. Thrown `AppError`s map to status codes;
  anything else becomes a 500 through `safeErrorMessage()`. The app never writes
  a status code for the common cases and never leaks a driver message.
- **`budget`** caps connector calls and wall-clock for this route. `ctx.connectors`
  is a counting proxy; exceeding the cap throws `BudgetExceeded` rather than
  letting one route fan out 400 upstream requests.
- **`raw: true`** swaps the contract for `(ctx, input) => Response` — file
  downloads, streams, the App Services binary passthrough. `output` is not
  applicable; the escape is declared.

### 2. Auth as a set

```ts
auth: ["session", "public"]
```

The gateway resolves the **strongest available** auth and hands the handler a
discriminated context:

```ts
handler: async (ctx, input) => {
  if (ctx.auth === "session") return { items: personalized(ctx.user.id) };
  return { items: publicSummary() };   // ctx.user is `null` and typed as such
}
```

| Auth | Requires | `ctx.user` | Mounted at |
|---|---|---|---|
| `session` | valid session **and** an app grant | populated, roles resolved | `/api/apps/<slug>/…` |
| `signed-in` | valid session, no grant needed | populated, no app roles | `/api/apps/<slug>/…` |
| `password` | app unlock cookie | `null` | `/api/p/<slug>/…` |
| `key` | scoped API key (decision 6) | `null`, key scopes resolved | `/api/apps/<slug>/…` |
| `public` | nothing | `null` | `/api/p/<slug>/…` |

A route accepting any of `public` / `password` is **derived** into the `/api/p/`
mount by the generator, so "what is internet-reachable" stays greppable in one
generated file and a CDN or WAF rule can target the prefix. The proxy's public
allowlist is generated from the registry rather than hand-maintained.

`roles` is enforced by the gateway before the handler runs, and it is
**default-deny**: a route on an app that declares roles and names none of them
requires nothing, but the generator warns. `ctx.user.hasRole()` remains for
in-handler branching (which fields to include), not for the gate itself.

### 3. `context.call()` — the second transport

```tsx
// apps/my-app/pages/Main.tsx  (server component)
export default async function Page() {
  const { items } = await context.call("GET /items", { limit: 20 });
  return <ItemsTable rows={items} />;
}
```

Same auth resolution against the page's own session, same role check, same input
and output validation, same telemetry row — no HTTP. This is what lets us ban
`lib/server` imports from pages without giving up server rendering, and it means
there is exactly one authorization surface to keep correct.

### 4. The generated typed client

The registry generator emits `src/generated/app-clients.ts` mapping each app's
routes to their input and output types. Widgets and client pages get:

```tsx
const client = createAppClient("my-app");
const res = await client.call("GET /items", { limit: 20 });
//    ^ { items: Item[]; truncated: boolean } — inferred, not asserted
```

`.get<T>()` is removed. The widget and the route can no longer disagree about a
shape, and renaming a route field becomes a compile error in every caller.

### 5. Enforcement tiers

Given "assume an agent wrote it and nobody read the diff," each rule is placed at
the cheapest layer that actually holds:

| Tier | Mechanism | Examples |
|---|---|---|
| **Impossible** | type + runtime Proxy | MCP writes; naming another app's table |
| **Build error** | registry generator | undeclared route; missing schema; unknown escape; role that doesn't exist |
| **Lint error** | ESLint | raw `fetch`; `process.env`; raw `<button>`; palette colours; `dark:` |
| **Runtime reject** | gateway | invalid input; missing role; over budget; rate limit |
| **Declared escape** | manifest `escapes` | the valve — visible in admin, requires a reason |

```jsonc
// app.json — the only way out, and it is on the record
"escapes": [
  { "rule": "raw-html", "reason": "Renders sanitized Markdown from the CMS connector." },
  { "rule": "output-validate-dev-only", "reason": "Book payload is ~4 MB; validation measured at 180ms." }
]
```

### 6. Containment: env and egress

- **`process.env` is lint-banned in `apps/**`.** App configuration comes from
  `ctx.env` — a manifest-declared allowlist of *app-scoped* settings an admin
  fills in at `/admin/apps`, never platform secrets. Declared, typed, encrypted
  at rest with the same AES-256-GCM path connector credentials use.
- **Raw `fetch` is lint-banned in `apps/**`.** Egress goes through a connector
  (fixed, admin-configured hosts) or `ctx.http`, which enforces a manifest
  `egress` host allowlist **and** performs the resolve-then-recheck that
  [security-architecture.md §13](../security-architecture.md) specifies but
  nothing implements. This closes the SSRF gap the doc flags as urgent, before
  the feature that would exploit it exists.

### 7. Rate limiting and budgets

One Postgres table, one atomic upsert per limited call. Axes:

| Axis | Where | Purpose |
|---|---|---|
| per IP | pre-auth, gateway | brute force, anonymous abuse |
| per user + app | post-auth | one user hammering one app |
| per route | post-auth | the expensive endpoint specifically |
| per API key | key auth | one integration starving the rest |

Plus the per-route `budget` on connector calls and wall clock. `src/lib/rate-limit.ts`
keeps its in-memory implementation as a fast pre-filter, with Postgres as the
authority — the memory bucket can only be *more* permissive than the truth, never
less, so a cold instance cannot lock anyone out.

---

## Structure

> **Status: Phases 0 and 1 are built** (2026-08-24).
>
> **Phase 0** — `defineRoute` + `runRoute`, the typed error vocabulary, the
> Postgres-backed limiter, the new manifest fields, and route-contract hoisting.
> `_template` is converted and the build rejects a bare handler. An adversarial
> review raised 27 findings; 14 survived refutation and all 14 are fixed.
>
> **Phase 1** — one dispatcher (`src/lib/apps/dispatch.ts`) behind both HTTP
> mounts, which are now 40-line bindings; auth-tier resolution
> (`src/lib/apps/auth-tier.ts`), strongest-first and narrowed by mount;
> gateway-enforced roles inside `runRoute`; per-user and per-route rate limits;
> and automatic route telemetry keyed on the route pattern. Its adversarial
> review raised 25 findings; 8 were real and fixed during the review (the
> `signed-in` tier being handed the app's `defaultRole` — a default-ALLOW hole in
> the new role gate; role-gated routes combining with tiers that carry no roles;
> catch-all routes being unreachable past one segment; an unguarded auth step;
> the route resolver matching files as directories). Two live bugs also fell out
> and are fixed: the mount authorized against `user_apps` (a dashboard
> install preference) instead of `user_app_grants`, which 403'd every user of
> every global app; and it called `requireServerSession()`, which `redirect()`s,
> so an unauthenticated XHR got a 307 to an HTML login page instead of a 401.
>
> **Deferred deliberately from Phase 1:** the proxy's public-prefix allowlist is
> still the hardcoded `/p` + `/api/p` rather than generated per-slug from the
> registry. Generating it would narrow the surface further (today `/p/<anything>`
> bypasses the proxy), but `src/proxy.ts` is under concurrent edit by the
> connector-abstraction work, and the current list is correct — every public
> surface lives under those two prefixes by construction. `context.env` /
> `context.http` remain Phase 4 as listed.
>
> **Known gap:** route telemetry rows land and `TelemetrySourceType` includes
> `route`, but the admin Analytics page still rejects a `route:<slug>` source, so
> the rows are write-only — the exact fate `queries.ts` warns about for `service`
> rows. The data is being collected correctly and nobody can see it yet.

### Phase 0 — Foundations

| File | Change |
|---|---|
| `src/lib/apps/route.ts` | **new** — `defineRoute`, `AppError`, `RouteDefinition`, budget proxy |
| `src/lib/apps/errors.ts` | **new** — typed error → status mapping, wraps `safeErrorMessage` |
| `src/lib/apps/types.ts` | `escapes`, `env`, `egress`, `sync` on `AppManifest`; `RouteVisibility` → `RouteAuth[]` |
| `scripts/manifest-schemas.ts` | validate the new manifest fields; reject unknown escape rules |
| `scripts/generate-project-registry.ts` | discover `api/**/route.ts`, import each definition, hoist contract into the registry; fail the build on an undeclared export |
| `src/lib/rate-limit.ts` | Postgres-backed limiter; memory tier becomes a pre-filter |
| `supabase/migrations/0002_rate_buckets.sql` | **new** — `public.rate_buckets`, RLS enabled with no policies |

### Phase 1 — The gateway

| File | Change |
|---|---|
| `src/app/api/apps/[...slug]/route.ts` | resolve auth from the declared set; validate input; enforce roles; run budget; validate output; serialize; auto-telemetry |
| `src/app/api/p/[appSlug]/[[...slug]]/route.ts` | becomes a thin derived mount over the same pipeline |
| `src/proxy.ts` | public prefix allowlist generated from the registry |
| `src/lib/apps/context.ts` | discriminated `AppContext<Auth>`; counting connector proxy; `ctx.env`; `ctx.http` |

### Phase 2 — Second transport and typed client

| File | Change |
|---|---|
| `src/lib/apps/call.ts` | **new** — `context.call()`, sharing Phase 1's pipeline |
| `scripts/generate-project-registry.ts` | emit `src/generated/app-clients.ts` |
| `src/lib/apps/sdk.ts` | typed `.call()`; remove `.get<T>()` |
| `eslint.config.mjs` | ban `apps/**/lib/server/**` imports from `pages/**` and `widgets/**` |
| `apps/_template/` | rewritten as the worked example of every pattern here |

### Phase 3 — The component library

New in `src/components/ui/`: `button` (with a built-in `busy` state, so "buttons
that do work show pending" is structural), `input`, `textarea`, `select`,
`combobox`, `checkbox`, `radio-group`, `switch`, `field` (requires a `label`, so
label association cannot be forgotten), `form`, `data-table` (owns its own
skeleton, empty and error rendering), `badge`, `toast`, `menu`, `pagination`.

The async primitive is where the state rules stop being advice:

```tsx
const q = useAppQuery("my-app", "GET /items", { limit: 20 });

<AsyncView
  query={q}
  skeleton={<ItemsSkeleton />}
  empty={{ cause: "no-data", title: "No items yet", body: "Sync a source to populate this." }}
>
  {(data) => <DataTable rows={data.items} columns={COLUMNS} />}
</AsyncView>
```

Loading, error and not-connected are handled by the component. `empty` is
required and carries a `cause` — and `cause: "no-filter"` still requires an
`action`. **You cannot render the data branch without having declared the
others**, which is the difference between a rule and a guarantee.

| File | Change |
|---|---|
| `eslint.config.mjs` | ban raw `<button>`/`<input>`/`<select>`/`<table>` and hand-rolled `rounded-xl border border-border bg-card` shells in `apps/**`; contrast rule `warn` → `error` |
| `src/lib/apps/types.ts` | remove `disableOsStyles` |
| `src/components/ui/*` | the primitives above |

### Phase 4 — Containment

`ctx.env` + `ctx.http` implementation, the admin UI for app settings, the SSRF
resolve-and-recheck, and the lint bans on `process.env` and `fetch`.

### Phase 5 — Declarative sync

```jsonc
"sync": [{
  "name": "calls",
  "schedule": { "everyMinutes": 60 },
  "source": "gong",
  "window": { "coldStartDays": 30, "defaultDays": 7, "minDays": 1 },
  "budgetMs": 200000
}]
```

```ts
// apps/my-app/sync/calls.ts
export default defineSync({
  fetchPage: async (ctx, { from, to, cursor }) => ({ items, nextCursor }),
  upsert:    async (ctx, items) => { /* map and write */ },
});
```

The platform owns the watermark table, the wall-clock budget checked at every
page boundary, window halving and relaxing with the size persisted, the
drained-versus-truncated watermark rule, the empty-result guard, and cache
invalidation on completion. **The cursor lives inside the loop and is never
persisted — the 19-day outage becomes unrepresentable rather than documented.**

### Phase 6 — Remaining surfaces

- **API keys** — `public.app_api_keys`, admin minting UI, HMAC digests reusing
  the MCP token pattern in `src/lib/mcp/store.ts`.
- **Hooks** — two-sided consent. An emitter declares `emits` with a consumer
  allowlist; a listener declares `listensTo`. Same default-deny as App Services.
- **Connectors** — methods declare `mutates: boolean`, which lets the platform
  enforce MCP read-only on connector calls (today "the gap the platform can't
  close", left to a reviewer) and lets the budget proxy price calls.
- **Widgets** — Zod config schemas; platform-enforced `resolveConfig` timeout
  rather than each widget remembering to race one; a platform error boundary so
  one widget cannot blank the dashboard.

### Phase 7 — Documentation

All 17 guides rewritten against the new model, `_template` as the single worked
example, and `apps/AGENTS.md` invariants re-derived — most of the current 24
become "the compiler does this now" and can be deleted rather than restated.

---

## Verification

Per phase, before it is called done:

1. `npx tsx scripts/generate-project-registry.ts` — the generator rejects an
   undeclared route, a missing schema, an unknown escape rule, and a role that
   isn't declared. Each of those gets a fixture that must fail.
2. `npm run typecheck` — `_template` compiles against the generated client; a
   deliberately-wrong field name in a widget must fail.
3. `npm run lint` — the new bans fire on a fixture; the existing 11 errors in
   `src/components/**` are fixed as part of Phase 3 (they gate CI today).
4. `npm run migrate` for Phases 0 and 6.
5. **Negative tests, since these are security controls:** a public route reading
   `ctx.user` must not compile; an over-budget route must 429 rather than fan
   out; a role-gated route must 403 before the handler runs; a `process.env`
   read in an app must fail lint; `ctx.http` against `169.254.169.254` and
   against a DNS-rebinding host must both be refused.
6. Phase 3: `_template` opened in a browser and exercised through every state —
   loading, empty by each cause, error, not-connected, read-only.
7. Phase 5: run the sync twice via `npx tsx scripts/run-scheduled-jobs.ts` and
   confirm the second run does materially less work; kill it mid-window and
   confirm the watermark did not advance.

## Non-goals

- Multi-tenancy beyond the current single-tenant model.
- Shipping dark mode. The token set stays complete and AA-correct so it remains a
  one-file change; nothing in this plan applies `.dark`.
- A third-party app marketplace. Decision 4 assumes an unreviewed *agent*, not a
  hostile author; genuine third-party hosting needs process isolation and
  resource quotas that are out of scope here.
- Replacing Next.js, the Supabase client, or Auth.js.
