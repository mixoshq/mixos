# API Routes

## A route is a declaration

An app API route is not a function. It is a **declaration** that happens to
contain one:

```ts
// apps/my-app/api/items/route.ts
import { z } from "zod";
import { defineRoute, AppError } from "@/lib/apps/route";

const Item = z.object({ id: z.string(), name: z.string(), total: z.number() });

export const GET = defineRoute({
  summary: "Items visible to the signed-in user.",
  auth: ["session"],
  roles: ["viewer", "editor"],
  input: z.object({
    limit: z.number().int().min(1).max(200).default(50),
    scope: z.enum(["mine", "all"]).default("all"),
  }),
  output: z.object({ items: z.array(Item), truncated: z.boolean() }),
  budget: { connectorCalls: 20, ms: 8_000 },
  handler: async (context, input) => {
    const rows = await loadItems(context, input.scope);
    return { items: rows.slice(0, input.limit), truncated: rows.length > input.limit };
  },
});
```

`export async function GET(...)` **fails the build.** That is not pedantry:
everything above `handler` has to be readable by something other than the
handler.

| Who reads it | What they do with it |
| --- | --- |
| The registry generator | Rejects a role your app never declared; rejects a route with no `output` |
| The gateway | Enforces the auth set and the roles *before* your code runs |
| The proxy | Derives which paths are reachable without a session |
| The generated client | Types your widget's call from your schemas |
| The admin page | Shows a human what this app exposes |

A bare function can be none of those things.

## What the platform does for you

Ordered as the pipeline runs them.

1. **Auth.** The gateway resolves the strongest auth the caller actually
   presents from the set you declared, and builds the matching context.
2. **Roles.** Checked before the handler runs. Default-deny — you cannot forget.
3. **Input.** Query strings, JSON body, and dynamic path segments are merged into
   one object, coerced to your declared field types, and validated. A failure is
   a 400 carrying the Zod issues; your handler never sees it.
4. **Budget.** `ctx.connectors` is wrapped in a counter. Blow the cap and the
   route fails loudly instead of quietly fanning out 400 upstream calls.
5. **Your handler**, under a wall-clock ceiling.
6. **Output.** Validated against your schema on the way out.
7. **Serialization.** Status code, JSON body, payload cap, error mapping.

## Returning data, and returning failures

**The handler returns a plain object.** No `NextResponse`, no status code, no
`JSON.stringify`. This deletes a whole bug class this codebase has a history
with: a raw `error.message` reaching the browser, a forgotten status, a handler
that returns `undefined` and 200s.

Failures are thrown, not constructed:

```ts
import { AppError } from "@/lib/apps/route";

if (!row) throw AppError.notFound("No such item.");
if (!context.user.hasRole(["editor"])) throw AppError.forbidden();
if (!monday?.configured) {
  throw AppError.unavailable("monday.com is not configured. Ask an admin to set it up.");
}
```

| Constructor | Status |
| --- | --- |
| `AppError.notFound()` | 404 |
| `AppError.unauthenticated()` | 401 |
| `AppError.forbidden()` | 403 |
| `AppError.invalidInput()` | 400 |
| `AppError.conflict()` | 409 |
| `AppError.unavailable()` | 503 |

Anything *else* your handler throws becomes a 500, with the message passed
through `safeErrorMessage()` so a driver error naming a column never reaches the
browser. You no longer write `safeErrorMessage` yourself — the pipeline does.

The one exception is a failed connector call. Let the `ConnectorError`
propagate: the response is that connector's envelope with its own status (503
for a connector nobody has finished setting up, 429 with `Retry-After` for a
throttle), which `AsyncView` renders as "Not connected" or as an error with
Retry. See [Failure handling](../connectors/failure-handling.md).

## `input`: declared or unavailable

An omitted `input` schema does not mean "unvalidated". It means **unavailable**:
the handler receives `{}` and anything the caller sent is discarded.

That is deliberate. An agent that forgets the schema gets a handler that cannot
read its own parameters, which fails in the first test rather than quietly
accepting whatever arrives.

Where the values come from:

| Method | Source |
| --- | --- |
| `GET`, `DELETE` | Query string, plus dynamic path segments |
| `POST`, `PUT`, `PATCH` | JSON body, plus dynamic path segments |

Path segments win over body and query keys of the same name — the URL is the
more specific statement.

**Query strings are coerced from your schema.** `?limit=20` arrives as the number
`20` because you declared `z.number()`; `?active=false` arrives as `false`;
`?ids=3&ids=4` arrives as `[3, 4]`. You do not need `z.coerce`. A value that
cannot be coerced is passed through unchanged so Zod reports the failure against
what the caller actually sent.

## `auth`: a set, not a fallback chain

```ts
auth: ["session", "public"]
```

The gateway resolves the strongest auth the caller actually presents and hands
the handler a context whose `user` is non-null only when the resolved auth
carries an identity. Declaring an anonymous auth **widens `context.user` to
nullable**, so the compiler is what makes you handle the signed-out branch — and
`context.auth` names the tier that won, so you can branch on the fact rather than
inferring it:

```ts
handler: async (context) => {
  // context.user is `AppContextUser | null` here — TypeScript enforces the check.
  if (context.auth === "session") {
    return { greeting: `Welcome back, ${context.user.displayName}` };
  }
  return { greeting: "Welcome" };
},
```

"Strongest wins" is literal. A signed-in user who holds a grant gets the
`session` context on a `["session", "public"]` route; the same user *without* a
grant gets the `public` one rather than a 403, because the route said a stranger
may read it. A stranger gets `public` too.

| Auth | Requires | `context.user` | Served at |
| --- | --- | --- | --- |
| `session` (default) | Signed in **and** granted this app | populated | `/api/apps/<slug>/…` |
| `signed-in` | Signed in; no grant needed | populated | `/api/apps/<slug>/…` |
| `password` | The app's unlock cookie | `null` | `/api/p/<slug>/…` only |
| `key` | A scoped API key | `null` | `/api/p/<slug>/…` only |
| `public` | Nothing | `null` | `/api/p/<slug>/…` |

A route accepting `public` or `password` is **derived** into the `/api/p/` mount.
You do not declare it in two places; if you also set `apiVisibility` in
`app.json`, the build requires the two to agree.

**Which mount serves which tier** is a property of the transport, not a policy:

- `/api/apps/<slug>/…` serves `session`, `signed-in`, and `public`. It serves
  `public` because a widget calling its own app always arrives here via
  `createAppClient`, including when the route it wants is deliberately public.
- `/api/p/<slug>/…` serves `password` and `public`. A session-only route is a
  **404** here, never a 401, so probing this surface cannot distinguish "exists
  but forbidden" from "no such route".
- `password` and `key` are not reachable on `/api/apps/…` at all. The unlock
  cookies are path-scoped to `/p/` and `/api/p/`, so a browser would never send
  one there; and `/api/apps` sits behind the proxy's cookie check, which
  redirects a machine-to-machine caller to `/login` before any of this runs.

### Machine-to-machine: scoped API keys

An admin mints a key per app with an explicit scope list, an optional expiry, and
a label. It is shown **once** — only an HMAC digest is stored, so a database leak
alone yields nothing replayable.

```
curl -H "Authorization: Bearer mosk_…" https://mos.example.com/api/p/my-app/items
```

Three properties worth knowing:

- **A key is bound to one app.** Presenting a valid key for app A on app B's
  route does not authenticate, or a key would become a platform-wide credential.
- **Scopes are per route.** `["GET /items"]` opens exactly that; a key minted for
  one endpoint never becomes a key for the whole app. `["*"]` covers everything
  the app declares.
- **Revocation and expiry are live**, checked on every request rather than cached
  on the key — one indexed lookup, and a revoked key stops working immediately.

The key travels in `Authorization: Bearer` or `X-API-Key`, never a query string,
which would end up in access logs, browser history and referrer headers.

## `roles`

Enforced by the platform **before your handler runs** — you do not write the
check. It is cross-checked at build time against your app's declared `roles`, so
naming a role your app never declared fails the build rather than 403ing forever.

```ts
roles: ["editor", "approver"],   // any one of these satisfies the route
```

Two things to know:

- **A platform admin does not bypass an app role.** `isAdmin` says nothing about
  what your app's "approver" means, and silently granting every platform admin
  every app route would be a larger surprise than the occasional lockout. If
  admins should reach it, grant them the role.
- **An anonymous tier can never satisfy a role.** A route that declares both
  `roles` and an anonymous auth will 403 the anonymous caller. That combination
  is almost always a mistake — decide whether the route is public or gated.

Use `context.user.hasRole()` inside the handler for finer branching (which
*fields* to include), not for the gate itself.

## `budget`

```ts
budget: { connectorCalls: 20, ms: 8_000 }
```

- **`connectorCalls`** caps method calls across all of `context.connectors`.
  Default **100**. Exceeding it is a 429 naming the connector and method that
  went over. This is the guardrail against the N+1 described below — a route that
  loops per-record over a full book trips it.
- **`ms`** caps how long the caller waits. Default **30 000**. Note this bounds
  *latency*, not spend: the handler keeps running after the 504. Work that must
  actually stop takes `context.signal`, which aborts when the budget runs out or
  the caller goes away. Pass it to the connector methods that accept one, and
  to `context.http.fetch`.

## `raw: true`

A route that owns its own Response — a file stream, a redirect, a non-JSON body:

```ts
export const GET = defineRoute({
  raw: true,
  auth: ["password"],
  input: z.object({ id: z.string() }),
  handler: async (context, input) => context.services!.request<Response>(/* … */),
});
```

Output validation and the payload cap are both skipped, and the timeout only
covers producing the Response, not consuming its body. So the exception has to
be on the record: `app.json` must declare
`"escapes": [{ "rule": "raw-response", "reason": "…" }]`, or the build leaves the
whole app out of the registry. An admin sees the declaration, and your reason,
in the app's details. Auth, roles, CSRF and the rate limit apply as usual.

**A raw route parses its own body.** Its `input` schema covers the query string
and path params only — the pipeline deliberately does not read the body, because
reading it would drain the stream and hand your handler an already-consumed
`Request`, which is the one thing a raw route exists to read.

## Using connectors

```ts
handler: async (context) => {
  const monday = context.connectors.monday;
  if (!monday?.configured) {
    throw AppError.unavailable("monday.com is not configured. Ask an admin to set it up.");
  }
  return { contacts: await monday.getContacts({ limit: 20 }) };
},
```

Always check `configured` — a connector can be registered but not yet set up by
an admin. For a **user-scoped** connector the pattern is different: return
`{ connected: false }` rather than failing, so the widget can render a Connect
prompt. See [Connectors](./connectors.md#required-ux-pattern).

### Calling connectors efficiently

Connector calls dominate a route's latency, and the `connectorCalls` budget
exists because getting this wrong is the most common way a route becomes slow.

**Scope before you enrich.** Fetch the minimal set of primary records, narrow it,
*then* do the expensive per-record enrichment only on the survivors.

```ts
// ✅ filter first, enrich the survivors
let deals = await searchDeals(quarter);          // 1 cheap paged search
if (scope === "mine") deals = deals.filter(isMine);
const companies = await enrichCompanies(deals);   // loop runs over the small set

// ❌ enrich everything, then filter — pays for rows you discard
const companies = await enrichCompanies(allDeals);
const visible = allDeals.filter(isMine);
```

**Let callers request only what they render.** When one route backs several
widgets that each show a different slice, take an `include` / `scope` field in
your `input` and skip the enrichment a caller didn't ask for.

**Avoid N+1 association loops.** Prefer a batch endpoint over one call per
record. Where the upstream only offers per-record lookups, chunk them, run each
chunk with `Promise.all`, and `sleep()` between chunks.

**Push filters upstream only when the property semantics are safe.** A
server-side search filter beats fetching everything — but verify the field first.
Multi-valued or id-vs-userId properties can make an `EQ` filter silently miss
rows; when unsure, fetch and filter in memory, and note the cost.

**Don't make config modals pay data-route prices.** A widget's `resolveConfig`
runs against these routes and *blocks the config modal*. Give it a dedicated
lightweight route — see [widgets.md → resolveConfig](./widgets.md#dynamic-config-with-resolveconfig).

## Using the scoped DB

When your app sets `"database": true`, `context.db` is pinned to your app's
tables. You cannot read or write another app's data — the boundary is enforced
when the context is built.

```ts
handler: async (context, input) => {
  if (!context.db) throw AppError.unavailable("This app has no database.");
  const row = await context.db
    .table("items")
    .insert({ name: input.name, owner: context.user.id });
  return { row };
},
```

Note that a declared `output` schema also catches the single most expensive
surprise in this layer: `numeric` and `decimal` columns come back as **strings**.
A route declaring `total: z.number()` fails immediately in development rather
than shipping a `.toFixed is not a function` to production. See
[Database](./database.md#numeric-and-decimal-come-back-as-strings).

## File layout

```
apps/my-app/
  api/
    hello/route.ts        → /api/apps/my-app/hello
    items/route.ts        → /api/apps/my-app/items
    items/[id]/route.ts   → /api/apps/my-app/items/<id>
    index/route.ts        → /api/apps/my-app        (the root route; key "")
```

Export one `defineRoute` per HTTP method. The gateway dispatches `GET`, `POST`,
`PUT`, `PATCH`, and `DELETE`; an unexported method returns 405, and a path with
no route returns 404.

Dynamic segments arrive in your `input` under their bracket name — `items/[id]`
gives you `input.id`, provided you declared `id` in the schema.

## Calling from a widget or client page

```tsx
"use client";
import { createAppClient } from "@/lib/apps/sdk";

const client = createAppClient<"my-app">(appSlug);
const { items } = await client.call("GET /items", { limit: 20 });
//      ^ inferred from the route's `output` schema — not asserted
```

Three things are checked at compile time: the spec must be a route your app
declares, the input must match that route's schema, and the result is typed from
its `output`. A typo in any of them is a build error rather than a runtime
surprise.

**Why the `<"my-app">` type argument.** `appSlug` arrives from `WidgetProps` as a
plain `string`, which TypeScript cannot narrow to a literal, so it can't be used
to look your routes up. Naming the app once gives you the checked client; the
runtime argument stays the prop. Omit it and `call()` still works, untyped.

**Defaults stay optional.** A route declaring `limit: z.number().default(50)`
gives its *handler* a guaranteed number, but its *caller* may omit it — the
client types come from the schema's input side, the handler's from its output
side.

The SDK throws `AppClientError` with the HTTP status and the response body on a
non-2xx. The body carries `{ error, code }`, so a client can branch on the code
rather than string-matching the message. After a connector failure `error` is the
connector's envelope rather than a string, and `connectorErrorOf(err)` returns it.

Requests always go to `/api/apps/<your-slug>/…`; you cannot call another app's
routes. For that, use [App Services](./app-services.md).

> `client.get<T>()` still works and is **deprecated**. `T` there was an assertion
> with nothing behind it — the exact bug class `call()` removes.

## Server components

A server page does **not** import `lib/server`, a connector, or the database.
All three are lint errors, because reaching them skips the gateway entirely — no
auth-tier resolution, no role gate, no validation, no budget, no telemetry. A
page gets its data through its own declared route:

```tsx
// apps/my-app/pages/Main.tsx
import { callAppRoute } from "@/lib/apps/call";

export default async function Page() {
  const { items } = await callAppRoute<Result>("my-app", "GET /items", { limit: 20 });
  return <ItemsTable rows={items} />;
}
```

Identical pipeline to the wire — the same auth tier resolved against the page's
own session, the same roles, the same input and output validation, the same
connector budget, the same telemetry row — minus the network hop and the JSON
round trip. It deliberately skips the rate limiters: the page render is already
bounded by the request that triggered it, and charging a user's API budget twice
for one page view would make a dashboard throttle itself.

`callAppRoute` **throws** `AppError` rather than returning a Response. A page
that would rather degrade than fail should catch it and render an
[`EmptyState`](./ux.md#empty-error--not-connected-states) — see
[`apps/_template/pages/Main.tsx`](../../apps/_template/pages/Main.tsx).

A `raw: true` route can only be called over HTTP; there is no Response to hand
back in-process.

## Anti-patterns

- Exporting a bare `async function GET`. The build rejects it.
- Omitting `input` and then trying to read query params — they were discarded.
- Constructing a `NextResponse` in a handler that isn't `raw: true`.
- Calling `safeErrorMessage()` yourself; the pipeline already does.
- Hand-writing a status code for a case `AppError` already covers.
- Declaring a route's auth in both `defineRoute` and `apiVisibility`. Keep the
  one next to the handler.
- Reading `context.user` without a null check on a route that accepts an
  anonymous auth. The compiler stops you; don't cast around it.
- Raising `budget.connectorCalls` to make a failing route pass. The budget is
  usually telling you the truth about an N+1.
- Accepting a state-changing request on `GET`. `SameSite=Lax` permits a
  cross-site `GET`, so a mutating `GET` handler is reachable cross-site.
- Echoing visitor input back into HTML on a route that accepts `public`.
