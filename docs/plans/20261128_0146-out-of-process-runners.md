# Registry apps and connectors out of process (design only)

**Status:** approved, 28 November 2026, with the recommended answer to each
decision (below). Being built, in the order at the end. It is Items 5b and 7b of
[`20261127_1649-runtime-isolation-hardening.md`](20261127_1649-runtime-isolation-hardening.md),
with T3b and T3c of
[`20261128_0128-secrets-out-of-process.md`](20261128_0128-secrets-out-of-process.md),
which share the same parts (§10 of the hardening plan).

**Scope:** platform. Where third-party code runs on Docker, Render and Railway.
Vercel and `next dev` stay in-process, and say so.

## Context

Every app and connector runs in the platform's Node process today. Items 0–4
made each in-process route out narrower: a frozen `context`, connector facades,
queries as the app's own role, secrets out of `process.env`, `Function` locked
against reflection. All of them hold only while the code can't reach around
them, and code written to evade the build's checks can: the platform's keys,
its database pool and every connector's credentials are in the same address
space (`docs/threat-model.md`, first row).

§10 settled the direction:

- the threat is a malicious third-party app or connector from mixos.org;
- the strong tier is for Docker, Render and Railway, and Vercel says it doesn't
  have it;
- connectors are isolated from each other and the platform, not only from apps
  (option c);
- extra latency is acceptable, a second billed service is not, and neither are
  new limits for developers, unless the design shows one is unavoidable.

## What was checked for this design

- **Node's permission model** (Node 26.3, `--permission`) refuses, with no
  allow flag, `fs` reads (`ERR_ACCESS_DENIED`), `child_process`, and the
  network (`fetch` fails). It does not touch `process.env`, so a runner must be
  started with an empty environment.
- **Node 24**, the Docker image's base (`node:24-bookworm-slim`), has
  `--permission` but no network permission. Denying a runner the network needs
  Node 25 or later in the image.
- **App code on the server** is loaded through generated maps of literal
  `import()`s (`src/generated/app-*-loaders.ts`) into the Next server bundle:
  routes, jobs, syncs, services, MCP tools, search handlers, `hooks.ts`, and
  pages. Pages are **server components by default** (`docs/apps/pages.md`),
  rendered inside Next's own render, and a server page's only data path is
  `callAppRoute`, which runs the gateway in-process.
- **Connector code** is loaded the same way (`src/generated/connector-loaders.ts`)
  and constructed per context build with decrypted credentials.

## The shape

```
            ┌───────────────────────────── one container / service ─────────────────────────────┐
browser ──▶ │  platform  (Next server, has the keys and DATABASE_URL, loads no third-party code)  │
            │     │  ▲   Unix socket, one per runner, frames of JSON                                │
            │     ▼  │                                                                             │
            │  app runner: app A   app runner: app B   connector runner: crm   connector runner: … │
            │  (--permission, empty env, no fs beyond its own folder, no network, no child procs)  │
            └─────────────────────────────────────────────────────────────────────────────────────┘
```

- **A supervisor** (the image's new entry point, replacing `CMD ["node",
  "server.js"]`) starts the platform and, on demand, one runner per **Registry
  app** and one per **connector**. Local apps stay in the platform process:
  they are the code you wrote. A runner that exits is restarted with backoff;
  one that can't start leaves its app or connector unavailable. It never falls
  back to running the code in-process (fail closed).
- **Each runner** is `node --permission --allow-fs-read=<its own folder>` with an
  empty environment, a Unix socket path and a random runner key, and nothing
  else. No network, no `child_process`, no workers, no addons. Under Compose,
  a runner can instead be its own container on an internal network, for those
  who want the stronger boundary; the protocol is the same.
- **The platform is the only enforcement point.** Everything a runner does for
  its code is a call back to the platform: a query (through Item 2's
  `mixos_run`, as the app's role), a connector method (through the same rules
  as the facade), `context.http` (the platform's egress check), `context.env`,
  notifications, services, telemetry. The runner holds nothing it could misuse
  on its own.

### The protocol

- **Frames:** length-prefixed JSON over the socket, one request and one
  response each, with an id, so calls interleave.
- **Platform → runner:** `run { kind, name, input, capability }`, where `kind`
  is route, job, sync, service, mcp, search, hook or page.
- **Runner → platform:** `call { capability, op, args }`, for `db.query`,
  `connector.call`, `http.fetch`, `env.read`, `notify.send`, `services.request`,
  `telemetry.track`.
- **The capability** is minted per run: an HMAC, under the runner key, over
  `{ app, run id, user id or null, read-only, expiry }`. The platform checks it
  on every `call`, so a runner can act only inside a run the platform started,
  as that run's user, read-only when the run is (MCP, search), and only until
  it ends. A runner can't make calls for another app: it has no other app's key.
- **Values** are JSON, plus a tagged form for `Date`, `Uint8Array` and a
  `ConnectorError` (category, user message, admin hint, retry-after). A route's
  `Response` from a `raw: true` route crosses as status, headers and a body
  stream on a second socket.

### App runners (5b)

- **Routes, jobs, syncs, services, MCP tools and search handlers** are already
  `(input, context) → output` functions behind the platform's pipeline. They run
  in the runner with an RPC `context`; the platform keeps every check it makes
  today (sign-in, roles, CSRF, schemas, budgets) before and after.
- **`hooks.ts`** runs in the runner too: each filter or action registered there
  becomes a `run { kind: "hook" }` with the budget it has today (brand filters
  share one second per request). A brand filter's result is cached for the
  request.
- **Widgets and client pages** already run in the browser, against routes. No
  change.
- **Server pages are the open question, and the answer is a limit.** A server
  component is rendered inside Next's own render of the page, with the shell
  around it. Rendering it in a runner would need the runner to produce an RSC
  payload that matches the platform's client manifest, and the shell's data
  (the session, the menu, the theme) through RPC: a second Next server, in
  effect, which is the second billed service §10 ruled out, or a second build
  of the whole app. So on the isolated tier, **a Registry app's pages must be
  client pages** (`"use client"`), getting their data from the app's routes,
  which do run isolated. A server page in a Registry app is refused there,
  with a message saying why; local apps keep server pages.
  This is the one new limit, it applies to Registry apps only, and the build
  can say so to a developer before they publish (a warning in
  `npm run check` for an app that has server pages).

### Connector runners (7b)

- **One runner per connector**, holding only its own code. Credentials are
  handed in with each call, decrypted by the platform, which keeps the keys;
  refreshed tokens come back in the response and the platform stores them,
  under the existing advisory locks (and an app's own row, from 3b).
- **Network:** a connector runner has none of its own. `HttpConnector`'s
  `fetch` is the platform's relay, which allows only the hosts its manifest
  names (`http.baseUrl`, `auth.tokenUrl`, `auth.authorizeUrl`, and an admin's
  `baseUrl` credential), then makes the request. So a connector reaches what it
  declared and nothing else, and its retries and budgets stay where they are,
  in `HttpConnector`, unchanged.
- **Webhooks:** the platform verifies the signature, as today, and forwards the
  verified event to the runner's `handleWebhook`.
- **Verify connection and OAuth callbacks** run there too.
- This is T3b's gateway, in the shape §10 allows: a second process, not a
  second service.

## What it stops, and what it doesn't

| On the isolated tier | Today |
|---|---|
| A Registry app's code can't read the keys, `DATABASE_URL`, `readSecret()`, the pool or another app's anything: none of it is in its process | reachable by code that evades the scan |
| A connector can't read another connector's credentials, or the platform's | reachable |
| A runner reaches the network only through the platform's egress checks | an app through `context.http` only by declaration; a connector unrestricted |
| A runner can't read the file system beyond its own folder, or start processes | not restricted |

What it leaves:

- **Local apps** run in the platform, as today. They are the code you wrote.
- **Server pages** of Registry apps aren't available on this tier (the limit
  above).
- **A V8 or Node bug** that breaks the permission model. The Compose option, a
  container per runner, is the answer for those who want it.
- **Vercel and `next dev`**: in-process, unchanged. The admin pages say which
  tier the host has (Item 9).

## Cost

- **Latency:** a Unix-socket round trip is about 0.05–0.2 ms. A route that makes
  ten context calls adds about 1–2 ms, beside Item 2's per-query cost. A cold
  runner adds its start (about 100–200 ms) to the first request after idle;
  runners stay warm while used and stop after a quiet period.
- **Memory:** about 40–60 MB per Node runner. Ten Registry apps and five
  connectors is about 0.6–0.9 GB on top of the platform. The supervisor can cap
  the number warm at once.
- **Build:** Registry app and connector code is built into a separate output
  that runners load, and left out of the server bundle on the isolated tier.

## Decisions (28 November 2026)

Each was taken as recommended:

- **1 (a):** a Registry app's pages must be client pages on the isolated tier.
- **2:** Node's permission model, with an empty environment. The image moves
  to Node 26, the current LTS.
- **3:** one runner per Registry app and one per connector.
- **4:** on by default where the tier exists, with `MIXOS_ISOLATION=off` for an
  operator who must, audited and shown on the admin pages.

The options, as they were put:

1. **Server pages in Registry apps:** (a) refused on the isolated tier, client
   pages only (recommended); (b) allowed, running in-process and labelled
   "not isolated" on the app's Reach page; (c) rendered in the runner, which
   means a second Next server per runner (not recommended: memory and
   complexity).
2. **Isolation mechanism in one container:** Node's permission model with an
   empty environment (recommended; needs the image on Node 25 or later for the
   network permission), or separate OS users (needs a root supervisor, which
   the image avoids today).
3. **Granularity:** one runner per Registry app and per connector
   (recommended), or one shared runner for all third-party code (less memory,
   no isolation between them).
4. **Default:** on by default in the Docker image, Render and Railway, with
   `MIXOS_ISOLATION=off` for an operator who must, audited and shown on the
   admin pages (recommended), or opt-in.

## Implementation order, once decided

1. The supervisor, the socket protocol and the capability, with an echo runner
   and the latency benchmark beside Item 2's.
2. Connector runners (7b): the smaller surface, and the relay for `fetch`.
3. App runners (5b): handlers, then `hooks.ts`, then the server-page limit and
   its build warning.
4. The escape suite (Item 9) gains a hostile connector and a hostile app, each
   contained on this tier and pinned as a known limit on Vercel.

**Effort:** L–XL, 15–25 days for 5b and 7b together, after the decisions.

## As built

### Step 1: the supervisor, the protocol and the capability (28 November 2026)

- `src/lib/runners/supervisor.ts` (`Runner`, `RunnerConnection`),
  `runner/bootstrap.mjs` and `runner/frames.mjs`.
- The echo bundle, `tests/fixtures/runners/echo/bundle.mjs`, and
  `npm run bench:runner`.
- `docs/security-architecture.md` §33. Nothing runs in a runner yet.

Where it departs from the design above, and why:

- **A pipe, not a Unix socket.** Under `--permission`, Node 26 refuses a
  runner a Unix socket too. Allowing one takes `--allow-net`, which allows the
  whole network. So the platform hands each runner one pipe, on fd 3. The
  runner reads and writes it through `fs` on the descriptor, which the
  permission model doesn't check. Node 26.13 refuses `net.Socket({ fd: 3 })`
  as network access, though 26.3 allowed it. The frames are as designed.
- **The capability is a token the platform keeps, not an HMAC under the
  runner key.** A runner holding the key could mint its own capability, for
  any user and any expiry. Instead, each run gets a random 256-bit token,
  kept in the platform, in that runner's connection. The pipe already says
  which runner a call came from, so a token from another runner names
  nothing.
- **The supervisor is a module in the platform, not the image's entry
  point.** It spawns each runner as a child with an empty environment and
  only fds 0 to 3. A separate supervisor process would be another process
  running as the same user, with no boundary added. The image's `CMD` is
  unchanged.
- **Signals, which the design missed.** The permission model doesn't cover
  `process.kill`, so a runner could signal the platform. SIGUSR1 would open
  Node's inspector on it, and so would `process._debugProcess`. Nor does it
  cover `os.setPriority`. The bootstrap replaces all of these before the
  bundle loads. The image sets `NODE_OPTIONS=--disable-sigusr1`, which also
  holds against any other process in the container.
- **The image is on Node 26**, the current LTS, for the network permission.
  So are `.nvmrc`, CI and `Dockerfile.dev`.
- **The cost, measured** with `npm run bench:runner` on an Apple M-series
  laptop. The figures are medians, on macOS with Node 26.3, then in a Linux
  container with Node 26.13:
  - a cold start to the first answer: 75 ms and 22 ms, against the 100–200 ms
    estimated;
  - a run: 0.06 ms and 0.15 ms;
  - a run that makes one call: 0.10 ms and 0.28 ms;
  - a run that makes ten at once: 0.20 ms and 0.47 ms.

### Step 2: connector runners (7b) (28 November 2026)

- Built:
  - `src/lib/runners/remote-connector.ts` (`RemoteConnector`,
    `connectorIsolation`);
  - `connector-host.ts`, the runner side;
  - `connector-relay.ts`, the fetch relay;
  - `isolation-audit.ts`;
  - `scripts/build-runner-bundles.ts`, run by `npm run prebuild`.
- `docs/security-architecture.md` §33.1, and a threat-model row of its own.

Where it departs from the design above, and why:

- **No connector code is loaded in the platform at all.** `constructConnector`
  returns a `RemoteConnector`, and HttpConnector's platform-only statics reach
  it through a symbol (`src/lib/connectors/remote-hooks.ts`). So the context
  build, the facade, the telemetry, Verify connection and webhooks needed no
  change.
- **One connector object per platform-side instance, kept in the runner while
  used**, not one per call. A client-credentials token is minted once per
  request, as in process.
- **The relay refuses private addresses** for every host the manifest names.
  Only the base URL an admin entered reaches the private network. In process
  a connector reached anything.
- **A new, optional manifest field, `http.hosts`**, for a connector whose
  requests reach a host its other URLs don't name. It is additive, so no
  schema version changes.
- **On by default is "a production build on a host with runners"**: the
  image. `next dev` and Vercel run connectors in process. `MIXOS_ISOLATION=off`
  is audited by the cron tick, on each change, since the operator sets it
  outside the app.
- **Limits for connector authors on this tier**, in `connectors/AGENTS.md`:
  - methods return data;
  - every host is declared;
  - no database;
  - `configured` comes from the manifest.

  The design had hoped for none. These are what crossing a process boundary
  costs, and no connector in this repository breaks any of them.

