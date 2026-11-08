# Local development in Docker

The everyday local setup runs MixOS and its database entirely on your machine.
This is the reference for how the pieces fit;
[Running a development copy](hosting/development.md) has the short version.

```bash
npm run dev:docker              # boot everything, app with hot reload
npm run dev:docker -- --detach  # the same boot, but the command exits when the app is up
npm run dev:docker -- --db-only # the database only, for `npm run dev` on the host
npm run docker:prod             # boot everything, app as the production image
npm run status                  # is it up, where, and what to do if not
npm run docker:down             # stop everything, keep the data
npm run docker:reset            # stop everything and delete the database volume
npm run db:local                # apply pending supabase/migrations/*.sql to the local DB
```

---

## How you know it's up

Every way of starting MixOS ends on the same summary, and the running app
writes it, not the script:

```text
────────────────────────────────────────────────────────────────────────
  ✓ MixOS is up at http://localhost:3000

  ✓ Web server   http://localhost:3000
  ✓ Database     connected, schema up to date
  ✓ Sign-in      http://localhost:3000/login
                 admin@localhost / mixos-local-dev
  ✓ Studio       http://127.0.0.1:54323   browse and edit the database
────────────────────────────────────────────────────────────────────────
```

Each line is a question put to the app over HTTP: does `/api/health/live`
answer, does `/api/health/ready` reach Postgres with the schema this code
expects, does `/login` render. A failure is a ✗ with its fix underneath, such
as `npm run db:local` for a schema that's behind. Each question waits on the
one before it, so a missing database shows up as one ✗, not three. Next's own
`✓ Ready` line isn't the signal. It means a process is listening, and a server
with no database prints it too.

Once everything passes, the browser opens at the app. That only happens for a
person at a terminal, never for an agent, a script or CI. `--no-open` or
`MIXOS_OPEN_BROWSER=false` turns it off.

**`npm run status`** asks the same questions any time, from any terminal. It
finds this checkout's app, in Docker or as a host `npm run dev`, and lists every
other MixOS serving on the machine with its port. It changes nothing, and exits
0 only when every check passed, so a script can use it too. The checks live in
[`scripts/local-stack.ts`](../scripts/local-stack.ts), shared by all three
commands.

---

## Attached by default, `--detach` when something else is driving

`npm run dev:docker` ends in `docker compose up` **in the foreground**. It
therefore does not return: the terminal becomes the log stream for `app-dev`
and `cron`, which is what you want while you are working — a failed migration
or a thrown request handler scrolls past in front of you. The summary prints
into that stream as soon as the app first answers, however long a cold first
compile takes. Ctrl-C is how the
session ends. It reaches the compose process group and stops the app
containers; the Supabase CLI stack is a *separate* orchestrator (see below) and
keeps running, so the next boot skips the slow part. `npm run docker:down`
stops both.

That blocking behaviour is wrong for anything that has to run a command and
then do something else — a setup script, CI, or Claude running `/mixos init` for
you. For those, `--detach`:

```bash
npm run dev:docker -- --detach   # or: npm run docker:prod -- --detach
```

brings the identical stack up in the background, then polls the app's
`/api/health/ready` until it returns 200 before printing the summary and
exiting 0 (and fails with a pointed message if it never does).
Waiting on readiness rather than on `compose up` returning is the whole value:
`/api/health/ready` opens a real connection to Postgres, so a zero exit status
means the app is actually serving requests, not just that containers were
created. With nothing attached, `npm run docker:down` is how you stop the stack
afterwards.

The `--` is npm's, not ours: it separates arguments for the script from
arguments for npm. `npm run dev:docker --detach` is silently swallowed by npm
and boots attached.

---

## What runs where

**Two orchestrators, not one.** This is the single most surprising thing about
the setup, and everything else follows from it.

```
  your terminal / host                Docker
  ────────────────────                ──────────────────────────────────────────
                                      ┌─ supabase CLI (project "mixos") ───────┐
  npm run dev:docker ──┬─ supabase ──►│  supabase_db_mixos      Postgres 17    │
  (scripts/docker-up)  │    start     │  supabase_kong_mixos    gateway :54321 │
                       │              │  supabase_rest_mixos    PostgREST      │
                       │              │  supabase_pg_meta_mixos schema API     │
                       │              │  supabase_studio_mixos  Studio :54323  │
                       │              └────────────────────────────────────────┘
                       │
                       ├─ supabase migration up --local ─┐
                       ├─ npm run migrate:apps           ├─► 127.0.0.1:54322
                       ├─ npm run seed-admin             ┘
                       │
                       └─ docker compose ─►┌─ compose project "mixos" ─────────┐
                                           │  app-dev  (profile: dev)  :3000   │
                                           │  app      (profile: prod) :3000   │
                                           │  cron     (both profiles)         │
                                           └───────────────────────────────────┘
                                                    │
                                                    └─► host.docker.internal:54322
```

The Supabase containers are created by the **Supabase CLI**, not by
`docker-compose.yml`. They are not compose services, they don't appear in
`docker compose ps`, and `docker compose down` does not stop them. That is why
`scripts/docker-down.ts` shuts down both orchestrators.

Why not fold Postgres into compose and have one file? Because the CLI already
owns the parts that are easy to get subtly wrong and painful to debug: the
pinned image versions that match hosted Supabase, Studio, and the migration
ledger the release step shares. Hand-rolling those means keeping them in step
by hand. `scripts/docker-up.ts` exists to make the two orchestrators look like
one command.

**`scripts/docker-up.ts` runs them in dependency order:**

1. Confirm the Docker daemon answers; if not, launch Docker Desktop and poll.
2. `supabase start` — a no-op if the stack is already up.
3. Read `supabase status -o json` and write `.env.docker.local`.
4. `supabase migration up --local` — the platform schema, incrementally.
5. `npm run migrate:apps` — each app's own tables, in its own `app_<slug>` schema.
6. `npm run seed-admin` — idempotent; updates the admin if it already exists.
7. `docker compose --profile dev up` (or `--profile prod`) — attached, unless
   `--detach` was passed, in which case `up -d` plus a readiness poll.

Steps 4–6 run **on the host**, against `127.0.0.1`. Step 7's containers use
`host.docker.internal`. Which brings us to the part that confuses everyone
exactly once.

---

## The two-address split

The same database has two names depending on who is asking:

| Who is connecting | Postgres |
|---|---|
| Your terminal, host `npm run dev`, `psql` | `127.0.0.1:54322` |
| Anything inside a compose container | `host.docker.internal:54322` |

**Why.** The Supabase CLI puts its containers on its own Docker network,
`supabase_network_mixos`, and *publishes* 54321/54322/54323 onto the host. Our
compose services live on a different network, so `127.0.0.1` inside the app
container is the app container itself — nothing is listening there. The
containers instead go **out to the host's published ports and back in**, which
`host.docker.internal` resolves to.

Joining `supabase_network_mixos` from compose and talking to the database
container directly would save that hop, and the aliases do exist. It is
deliberately not done: the CLI creates and destroys that network on
`supabase start` / `stop`, so a compose service attached to it fails to start
whenever the CLI stack is down — a boot ordering dependency between two
orchestrators, traded for one network hop.

**`host.docker.internal` does not resolve on its own.** Every compose service
carries:

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

This is **required**, not a Linux-portability nicety. Measured on Docker Desktop
for macOS: without the mapping the name fails to resolve at all — on the default
bridge, on a user-defined network, in both musl and glibc images. With it,
`/etc/hosts` gets a `192.168.65.254 host.docker.internal` line and everything
works. If you find yourself deleting those lines because "Docker Desktop
provides that name automatically", it doesn't.

Both addresses come from one read of `supabase status -o json` rather than being
duplicated by hand, so they cannot drift apart.

---

## Port map

| Port | Service | Published by |
|---|---|---|
| 3000 | The MixOS app | compose (`app-dev` or `app`) |
| 54321 | Supabase API (Kong and PostgREST). MixOS doesn't use it; Studio does | Supabase CLI |
| 54322 | Postgres | Supabase CLI |
| 54323 | Supabase Studio | Supabase CLI |

The Supabase ports must be free before the stack starts. The app port is
handled for you. When something already holds it, the preflight says what,
whether that's another MixOS instance in Docker, a host `npm run dev` in some
checkout, or an unrelated app, and recommends the next free port:

```text
    warn port 3000 is taken
         MixOS instance `mixos-dev` (in Docker, from ~/mixos-dev) is already on http://localhost:3000.
    Start this one on http://localhost:3001 instead? [Y/n]
```

At a terminal, Enter takes it for this run. With nobody to answer (an agent, CI,
`--check`), the boot stops and prints the command instead:
`MIXOS_PORT=3001 npm run dev:docker -- --detach`. Put `MIXOS_PORT` in
`.env.instance` to keep a checkout on one port. There's one exception: when the
holder is this checkout's own host `npm run dev`, the fix is to stop it. Two
servers for one checkout, on two ports, are the confusing case this check
exists to prevent. Whatever port a run settles on is used everywhere:
compose publishes it, the app's `NEXTAUTH_URL` follows it, and the summary
prints it.

These are the ports of the **default instance**. A checkout can be a different
one — see below — and then the Supabase numbers move with it.

---

## More than one instance on one machine

An instance is a compose project, its named volumes and its Supabase containers,
all named after the instance. It is also exactly one database, and **every
checkout gets an instance of its own**. A second clone or a git worktree never
shares the first one's database, and booting it never replaces the first one's
app.

A second tree is usually for something one instance can't do. Registering an
extension refuses a slug whose directory already exists, so the instance you
*author* an extension in cannot also be the one you *install* it into to check
that a stranger gets what you meant. That needs two instances, running at once.

**It happens on the first boot.** A checkout with no `.env.instance` is `mixos`,
on port 3000 with Supabase on 54321. If another folder already owns `mixos`,
`npm run dev:docker` gives this checkout an instance of its own instead:

```text
[1] Instance
    ~/git/mixos already uses `mixos`, and an instance is one database.
    This checkout gets its own: `mixos-feature`, with Supabase on 54360-54369 and a fresh database.
    Saved to .env.instance.
```

The name comes from the folder. The port block is the next one nothing holds,
running or stopped. The database starts fresh, with every migration and the
seeded admin, and nothing carries over from the other folder. That folder
keeps its name and its data. `--check` shows what it would do, and writes
nothing.

**Who owns what** is recorded in `~/.mixos/instances.json` (`MIXOS_STATE_DIR`
moves it): each instance, its folder and its port block. Booting an instance is
claiming it. The record outlives the containers, which `docker:down` removes,
and that's what keeps a stopped instance's ports from being handed out again.
On a machine that booted MixOS before the record existed, the evidence is
Docker's: the folder compose last ran the instance from keeps it. A claim whose
folder is gone, moved or deleted, no longer counts.

**Nothing acts on another folder's instance.** From a checkout that only shares
the name, these all refuse with the fix:
- `npm run docker:down` and `docker:reset`, which would stop that checkout's
  MixOS or delete its data;
- `npm run supabase`, along with `db:reset`, `db:push` and `db:local`, which go
  through it;
- `npm run dev`, which won't connect to that database;
- `npm run status`, which says this checkout has no database of its own yet.

[`scripts/instance-claims.ts`](../scripts/instance-claims.ts) holds the rule.

**Naming one yourself** still works. Copy `.env.instance.example` to
`.env.instance`:

```bash
MIXOS_INSTANCE=mixos-dev          # compose project, Supabase project id
MIXOS_SUPABASE_PORT_BASE=54340    # Supabase's seven ports, derived from here
MIXOS_INSPECTOR_PORT=8084         # not part of the 5432x block
# MIXOS_PORT=3001                 # optional: pin the app to one port
```

A name you wrote is never renamed for you. If another folder already owns it,
the boot stops and suggests a free name and port block. The app port needs no
setting: whichever instance starts second is offered the next free port (see
the port map above). `npm run docker:down` in a checkout stops only that
checkout's instance, and `npm run status` in any of them lists them all.

Each instance runs its own Supabase stack, about 0.6 GiB of Docker's memory,
plus about 1.5 GiB for a dev app container. The preflight counts the instances
already running and warns when this one would make Docker's memory tight.
Everything still starts. `npm run docker:down` in a checkout you aren't using
frees its share.

A shell value beats the file, which makes a one-off possible without a file at
all:

```bash
MIXOS_INSTANCE=mixos-test MIXOS_PORT=3002 npm run dev:docker
```

`scripts/instance.ts` is where the name and the port offsets are resolved;
`docker-compose.yml` and `supabase/config.toml` read them from the environment.

### Reaching the Supabase CLI directly

Because `config.toml` resolves its project id and ports from `env(...)`,
the CLI has to be started with those variables set. A bare `supabase db reset`
gets an EMPTY project id and looks for containers called `supabase_db_`, which
fails with a message that says nothing about why.

Go through the wrapper, which pins the repo-local CLI and sets the environment:

```bash
npm run supabase -- status
npm run supabase -- db reset
```

`npm run db:push`, `db:reset` and `db:local` already route through it.

---

## Which Supabase services run, and why the rest are off

MixOS uses one piece of the Supabase stack: Postgres. From
[src/lib/db/server.ts](../src/lib/db/server.ts) there are exactly two data
paths — `createServiceClient()` (the query builder in
[src/lib/db/query.ts](../src/lib/db/query.ts)) and `sql` (a raw `postgres.js`
pool) — and both are the same TCP connection to Postgres, configured from
`DATABASE_URL`. The CLI is how this repository gets a local Postgres that
matches hosted Supabase's version and extensions; a deployment needs none of the
rest (see [Requirements](hosting/requirements.md#a-postgres-database)). Everything that would boot for
nothing, `supabase/config.toml` turns off.

| Service | State | Why |
|---|---|---|
| Postgres | **on** | Both data paths end here. |
| PostgREST + Kong | **on, unused** | MixOS doesn't call the Supabase API. They are part of the CLI's core stack, and Studio goes through them. |
| Studio + pg-meta | **on** | Browsing local data at :54323. Pure convenience; harmless to disable. |
| GoTrue (`[auth]`) | **off** | MixOS has no Supabase Auth — NextAuth owns authentication. The boot script reads only the API, database and Studio addresses from `supabase status -o json`, which the CLI reports with it off. |
| Storage | **off** | No `supabase.storage` / `.storage.from(` anywhere in the codebase. |
| Realtime | **off** | No `.channel(` subscriptions anywhere; pages update with a router refresh. |
| Edge Functions (`[edge_runtime]`) | **off** | There is no `supabase/functions/` directory. All server code is Next.js route handlers. |
| Analytics / Logflare | **off** | Log aggregation only. Costs the Studio Logs Explorer, which nothing here uses. |
| Local SMTP (`[local_smtp]`) | **off** | Only used to catch Supabase Auth emails, and there are none. |

Before you edit `config.toml`: **`[api] auto_expose_new_tables` is left unset**,
so new `public` tables get no grants to `anon`, `authenticated` or
`service_role`, which only a client of the Supabase API needs. MixOS connects as
the tables' owner and needs none.

---

## Environment files

Compose loads two files into every service, in this order:

| File | Committed? | Contents |
|---|---|---|
| `.env.docker` | **yes** | `AUTH_SECRET`, `CONNECTOR_ENCRYPTION_KEY`, `APP_UNLOCK_SECRET`, `CRON_SECRET`, `INITIAL_ADMIN_EMAIL`, `INITIAL_ADMIN_PASSWORD`, `NEXTAUTH_URL=http://localhost:3000`, `PGSSLMODE=disable` |
| `.env.docker.local` | no — generated, gitignored | `DATABASE_URL` |

One value is overridden on top of both: `NEXTAUTH_URL`. Compose sets it from
the port the app is published on, `http://localhost:${MIXOS_PORT}`, because it
is the origin OAuth callbacks and absolute links are built from, and an
instance on 3001 must not send them to whatever holds 3000.

**`.env.docker` is committed on purpose.** Every value in it is fixed and
public, which is the whole point: nobody generates a secret by hand, and a fixed
`CONNECTOR_ENCRYPTION_KEY` means connector credentials you saved locally still
decrypt after a restart. The tradeoff is that these values protect nothing —
they must never appear in a Vercel environment variable. Because `.gitignore`
ignores `.env*` wholesale, this file needs an explicit `!.env.docker` negation
to stay tracked.

**`.env.docker.local` is generated, never hand-written.** The database URL is
read fresh from `supabase status -o json` on every boot, because its port
follows the instance and the CLI's defaults; a hardcoded copy that goes stale
fails as a connection error that reads like an application bug rather than a
config problem. The container-facing value is rewritten to
`host.docker.internal` per the two-address split above.

**`PGSSLMODE=disable` is mandatory.**
[src/lib/db/pg-options.ts](../src/lib/db/pg-options.ts) defaults `ssl` to
`"require"` — correct for a hosted database reached over the public internet,
wrong for a container on your laptop that speaks plaintext. Without it every
single query fails.

Two Next.js loading rules that explain otherwise-confusing behaviour:

- `.env.docker` is **not** in Next's automatic `.env*` load order, so nothing
  reads it except the compose CLI on the host. That is exactly why the
  `env_file:` mechanism is used rather than a bind mount.
- Real process environment always beats `.env*` files in Next. A bind-mounted
  `.env.local` therefore **cannot** override a value compose injected — if you
  are editing `.env.local` and the container ignores you, this is why.

---

## The cron sidecar

Scheduled jobs fire locally, on the same path they take in production.

A small `cron` container polls `GET /api/cron` every 5 minutes with
`Authorization: Bearer $CRON_SECRET`, which is byte-for-byte what Vercel Cron
does (see `vercel.json` and
[src/app/api/cron/route.ts](../src/app/api/cron/route.ts), whose bearer check is
the real gate — the route refuses to run when `CRON_SECRET` is unset rather than
defaulting open). It runs in both profiles and waits for the app to report
healthy before its first tick.

```bash
docker compose -p mixos logs -f cron   # watch ticks (-p is the instance name)
curl -i http://localhost:3000/api/cron # expect 401 — no bearer header
```

A timer inside the app process would be less machinery, and isn't used: it is a
code path production never takes, so scheduler bugs would only show up after
deploy.

---

## Dev and prod profiles

Both profiles serve on the instance's app port (3000 by default) and use the
same Supabase stack; only the app container differs.

**`dev` (`npm run dev:docker`)** — `Dockerfile.dev`, your working tree
bind-mounted, `next dev` bound to `0.0.0.0`. Named volumes shadow `node_modules`
and `.next` so the container's copies win over the host's. That is not just a
performance tweak:

- `node_modules` must be the container's, because Next 16 builds with Turbopack
  and needs the Linux/arm64 native binding, not your macOS one.
- `.next` must be the container's, because `next dev` takes an exclusive OS lock
  on `<distDir>/lock`. Share the directory with a host `npm run dev` and the
  second one prints "Another next dev server is already running" and exits 1.

**`prod` (`npm run docker:prod`)** — the multi-stage `Dockerfile`: `npm ci` →
`next build` with `output: "standalone"` → a lean non-root runner that starts
with **`node server.js`**, not `next start` (Next 16 warns against `next start`
under standalone output by name, and the runner has no full `node_modules` to
run it from anyway). No hot reload — rebuild to see a change. Use it to
reproduce something that only misbehaves in a production build.

**One directory has to be inside the production image, and tracing won't find
it on its own.** Next's file tracing is static analysis of `import` / `require`
/ `fs` usage; it cannot see a path assembled at runtime from `process.cwd()`.
[src/lib/apps/api-router.ts](../src/lib/apps/api-router.ts) does exactly that:
it walks `process.cwd()/apps/<slug>/api/**` and checks for a literal `route.ts`
on every app API request — so **`apps/` must ship with its `.ts` sources**.

`next.config.ts` handles this with `outputFileTracingIncludes`, deliberately
rather than a `COPY` in the Dockerfile: the same traces drive the Vercel build,
so one mechanism fixes both, and there is no second place to drift. Don't add a
`COPY` "to be safe" — two mechanisms means one silently masks the other's
breakage.

---

## Running Next.js on the host against the container backend

Supported, and the right fallback if hot reload is slow on your machine, but
not the default: the container is.

Next's own docs do recommend against containerized dev, on the grounds that
Docker's filesystem layer on macOS can push HMR into seconds or minutes. That
was true under the older gRPC-FUSE file sharing. With **VirtioFS**, which Docker
Desktop has defaulted to on macOS for several versions, this repo measures
edit-to-served at roughly **0.2s for an API route and 0.3s for a page
component**. Reach for the host server when you have measured a problem, not on
principle.

Start the database, then Next on the host. Two commands, and no `.env.local`
to write:

```bash
npm run dev:docker -- --db-only   # Supabase and every migration, no app container
npm run dev                       # Next on this computer, against that database
```

`npm run dev` ([`scripts/dev.ts`](../scripts/dev.ts)) finds this instance's
running Supabase stack and hands Next its host-facing address
(`127.0.0.1`, per the two-address split above), `PGSSLMODE=disable`, and the
rest of `.env.docker`. Those are the container's own values, so sessions and
stored connector credentials stay valid across both ways of running. They go
in through the server's environment, never a written file. If the stack isn't
running, `npm run dev` offers to start it.

It stays out of the way of a database you chose. With `DATABASE_URL` (or
`PGHOST`) in the shell, `.env.local` or `.env`, or with any `.env.local` at all,
it adds nothing. That's the rule [`scripts/load-env.ts`](../scripts/load-env.ts)
applies to the same fallback, because `.env.docker`'s `PGSSLMODE=disable` and its
public `AUTH_SECRET` belong to the local database only.

Already booted the whole stack? Run `npm run dev` anyway. It sees this
instance's `app-dev` on the port and offers to stop that container and take
its place. With nobody at the keyboard, it prints the
`docker compose -p <instance> stop app-dev` to run instead. A port held by
anything else gets the next free one, as in the port map above.

One caveat about the scheduler. The `cron` sidecar calls the app by its
`mixos-app` network alias, and when that does not resolve — `app-dev` is
stopped — it falls back to `host.docker.internal` on the instance's own app port. So if you got here via
`stop app-dev` it survives and its ticks land on your host server, which has
`CRON_SECRET` from `.env.docker`. With `--db-only`, or after a Ctrl-C, there is
no cron container and nothing is ticking at all.
Either way, don't infer from a passing tick that the scheduler is exercised the
way it is in production; force one by hand with
`npx tsx scripts/run-scheduled-jobs.ts`.

---

## Troubleshooting

**Start with `npm run status`.** It says whether the app, the database and
Studio answer, prints the fix for whichever doesn't, and lists every MixOS on
the machine with its port. Most of what follows is the detail behind one of its
✗ lines.

**`npm run dev` says "Ready" but pages fail.** Next's `Ready` only means it's
listening. The summary under it says whether it can reach a database. With
none configured and no local stack running, run
`npm run dev:docker -- --db-only` and restart `npm run dev`.

**Connection refused, or the wrong database, after changing instances.**
`.env.docker.local` is stale. Delete it and re-run `npm run dev:docker`, which
regenerates it from `supabase status`.

**TLS / `self-signed certificate` errors on every query.** `PGSSLMODE=disable`
is missing. The local Postgres speaks plaintext;
`src/lib/db/pg-options.ts` defaults to requiring TLS.

**`/api/health/ready` returns 503.** The app can't reach Postgres within its 2s
budget. Check `DATABASE_URL` in `.env.docker.local` uses
`host.docker.internal`, not `127.0.0.1` — a container pointed at `127.0.0.1` is
pointed at itself. Confirm the mapping resolves from inside:
`docker compose -p mixos exec app-dev getent hosts host.docker.internal`.
If the body has a `reason`, the database is reachable but missing a migration:
`schema-behind` wants `npm run db:local`, and `app-migrations-behind` (an app
migration you added since the last boot) wants `npm run migrate:apps`.

**App API routes 404 in the prod image, with `{"error":"Route not found"}`.**
`apps/` didn't make it into the standalone output. Note the failure mode: the
router catches the failed `readdir` and returns **404, not 500**, and an app's
*index* route short-circuits without touching disk — so test a **nested** path
like `/api/apps/<slug>/something` or a broken image will look fine. Verify with
`docker compose -p mixos exec app ls apps`.

**The page loads but is unstyled, and the console is full of 403s on
`/_next/...`.** You opened `http://127.0.0.1:3000`. Next's dev server rejects
`/_next/*` and the hot-reload websocket from origins it doesn't recognize, and
its allowlist is `localhost`-based. Use `http://localhost:3000`.

**Hot reload is slow.** It shouldn't be — expect well under a second, and see
"Running Next.js on the host against the container backend" above for the
measured figures. First check that Docker Desktop is using **VirtioFS** rather
than gRPC-FUSE, under Settings → General; gRPC-FUSE is the configuration Next's
docs have in mind when they warn about HMR taking minutes. Turbopack exposes no
polling fallback the way webpack's `watchOptions.poll` did, so if VirtioFS is
already on and it is still slow, run `npm run dev` on the host against the
containerized backend instead.

**The first request to a page is slow, but editing it afterwards is fast.** Not
a watcher problem — that is Turbopack compiling the route on demand the first
time anything asks for it. The `.next` named volume keeps that work across
container restarts, so it is a once-per-route cost rather than a
once-per-restart one.

**The stack is up but the first request after a break takes many seconds.**
Docker Desktop's Resource Saver pauses the VM after ~5 minutes idle. Turn it off
in Settings → Resources if the 5-minute cron cadence keeps landing on the
boundary.

**Preflight fails on `supabase/migrations`.** Two platform migrations share a
number, usually because a merge brought in someone else's migration with the
number yours took. `npm run dev:docker` stops before starting anything and
names both files and the next free number: rename yours to it and change its
`platform_schema_version` value to match. Running the Supabase CLI directly
(`npm run db:local`, `npm run db:push`) reports the same problem only as
`duplicate key value violates unique constraint "schema_migrations_pkey"`.

**`supabase start` fails or containers are in a weird state.**
`npm run docker:reset`, then `npm run dev:docker`. Reset **deletes the local
database volume** — the seeded admin, connector credentials, and any app data
are gone and rebuilt from migrations. Nothing in a deployment is affected.

**Disk fills up.** Supabase images plus the build cache run to several GB.
`docker system df` shows the breakdown; `docker system prune` reclaims the
dangling layers.
