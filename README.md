# MixOS

Internal operating system for MixOS, built with [Next.js](https://nextjs.org).
Deploys to [Vercel](https://vercel.com), backed by [Supabase](https://supabase.com)
Postgres. **Locally the whole system — app, Postgres, PostgREST, and the
scheduler tick — runs in Docker on your machine**, so nobody needs a cloud
project to get started.

> **New here?** If you're using Claude in VSCode, run the `/mix-init` skill. It
> detects what you're missing, installs it, and boots the stack for you — then
> `/mix-help` to figure out what to build. The manual steps are below.

## Prerequisites

- [Visual Studio Code](https://code.visualstudio.com/) — the editor MixOS is built
  to be worked on in. After installing, add these two extensions (Extensions
  view → search by ID, or run the `code` commands below):
  - **Anthropic.claude-code** — Claude Code, the assistant that drives the
    guided skills (`/mix-init`, `/mix-help`, `/mix-app`, `/mix-connector`,
    `/mix-deploy`).
  - **esbenp.prettier-vscode** — Prettier, for consistent formatting.

  ```bash
  code --install-extension Anthropic.claude-code
  code --install-extension esbenp.prettier-vscode
  ```

  (`code` on the command line requires the
  [VSCode shell command](https://code.visualstudio.com/docs/setup/mac#_launching-from-the-command-line);
  open VSCode and run **Shell Command: Install 'code' command in PATH** from the
  Command Palette if it isn't available. `/mix-init` installs both extensions for
  you automatically.)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) — runs the
  local database and, in the default workflow, the app itself. Install the
  **cask**, not the CLI-only formula:

  ```bash
  brew install --cask docker-desktop
  ```

  A plain `brew install docker` gets you the `docker` client with **no daemon**,
  which fails later with a confusing "Cannot connect to the Docker daemon".
  Licensing: Docker Desktop is free for personal use, education, and small
  companies, but organizations above **250 employees or $10M annual revenue**
  need a paid subscription — [OrbStack](https://orbstack.dev) is a drop-in
  alternative if that applies to you.
- [Node.js](https://nodejs.org) 22+ — the version is pinned in `.nvmrc`, so
  `nvm use` selects it for you. Node runs the boot script and the Supabase CLI
  on the host even when the app itself runs in a container.
- npm

## Setup

**The automated path:** run `/mix-init` in Claude (VSCode). It surveys what's
missing, asks once, installs Homebrew / Node / Docker Desktop / the VSCode
extensions, boots the stack, and hands you a login. Everything below is what it
does by hand.

1. Install Docker Desktop and start it once. The first launch shows a license
   agreement and asks for your password to install a privileged helper — that
   part can't be scripted.

2. Clone and install:

   ```bash
   git clone <repo-url>
   cd mixos
   npm ci
   ```

   `npm ci` rather than `npm install`: it installs exactly what
   `package-lock.json` pins and fails loudly if the lockfile has drifted, which
   is the same install CI and both Dockerfiles run.

3. Boot everything:

   ```bash
   npm run dev:docker
   ```

   That one command starts the Supabase local stack, writes the generated
   connection settings to `.env.docker.local`, applies the platform migrations
   and each app's migrations, seeds an admin, and starts the app container with
   hot reload. **The first run pulls several GB of images and can take 5–15
   minutes** with no visible progress for long stretches — it is not hung.

   It then **stays in the foreground streaming container logs** and does not
   return — that is the point, so a stack trace lands in front of you instead
   of in a log you never look at. Ctrl-C ends the session: it stops the app
   containers and leaves the Supabase stack running, so the next boot skips the
   slow part. `npm run docker:down` stops that too. If you need the command to
   *finish* instead — a script, or Claude booting the stack for you — add
   `--detach`, described under [Running locally](#running-locally).

4. Open [http://localhost:3000](http://localhost:3000) and log in with the
   `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD` values in
   [`.env.docker`](.env.docker). Then configure connectors at
   [/admin/connectors](http://localhost:3000/admin/connectors).

There is no secret to generate and no `.env.local` to fill in. `.env.docker` is
committed on purpose: every value in it is a throwaway that only ever protects a
database on your own laptop. **Never reuse any of them in a deployment.**

## Running locally

```bash
npm run dev:docker              # Supabase + app with hot reload  (the everyday command)
npm run dev:docker -- --detach  # same, but return to the prompt once it answers
npm run docker:prod             # Supabase + the production image, to reproduce a deploy
npm run docker:down             # stop everything, keep the database
npm run docker:reset            # stop everything and DELETE the local database volume
```

The first two differ only in who owns your terminal. Attached (the default) the
command streams container logs until Ctrl-C, which stops the app containers
while the Supabase stack stays up. With `--detach` the stack comes up in the
background, the script waits until `http://localhost:3000/api/health/ready`
answers 200 — so a successful exit means the app really is serving, not merely
that containers were created — prints the same banner, and exits. Nothing is
running in your terminal afterwards, so `npm run docker:down` is how you stop
it. The flag composes with the prod profile: `npm run docker:prod -- --detach`.

Note the bare `--`: it is npm's separator for arguments meant for the script
rather than for npm itself, so `npm run dev:docker --detach` silently does
*not* detach.

Use **`http://localhost:3000`**, not `http://127.0.0.1:3000` — Next.js dev mode
rejects `/_next/*` requests (including the hot-reload websocket) from origins it
doesn't recognize, and `127.0.0.1` isn't on that list, so the page loads broken.

Supabase Studio, for browsing and editing local data, is at
[http://localhost:54323](http://localhost:54323).

When you add a migration while the stack is already up:

```bash
npm run db:local      # platform schema: supabase/migrations/*.sql
npm run migrate:apps  # per-app tables: apps/*/migrations/*.sql
```

Both are incremental and idempotent, and `npm run dev:docker` runs them for you
on every boot.

Prefer to run Next.js on the host? That still works — `npm run dev` against the
containerized backend is supported. See
[docs/local-docker.md](docs/local-docker.md), which also explains what runs
where, the port map, and why containers address the database as
`host.docker.internal` while your terminal uses `127.0.0.1`.

## Alternative: hosted Supabase

The original workflow — Node on the host, database in a Supabase cloud project —
is still supported and is the closest match to production. Use it if you can't
run Docker, or if you need to work against shared data.

You need a [Supabase](https://supabase.com) project (the free tier is enough).
The Supabase CLI ships as a dev dependency, so `npm run db:push` works without a
global install.

1. Configure environment variables:

   ```bash
   cp .env.local.example .env.local
   ```

   Populate `.env.local`. From the Supabase dashboard you need `SUPABASE_URL`
   and `SUPABASE_SERVICE_ROLE_KEY` (Project Settings → API) plus `DATABASE_URL`
   (Project Settings → Database → **Transaction pooler**, port 6543 — not the
   direct 5432 endpoint). `AUTH_SECRET`, `CONNECTOR_ENCRYPTION_KEY`,
   `APP_UNLOCK_SECRET`, and `CRON_SECRET` can be generated with the one-liners
   in the comments. Secrets for a real deployment live in the team's MixOS
   1Password vault — request access from Anthony (amix@gmail.com) if you
   need them.

2. Apply the schema:

   ```bash
   npx supabase link --project-ref <your-project-ref>
   npm run db:push          # applies supabase/migrations/*.sql
   ```

   The platform schema is one file, `supabase/migrations/0001_initial.sql`.
   Schema changes append a new `supabase/migrations/0002_*.sql`.

   Apps that declare their own tables are separate — their migrations live in
   `apps/<slug>/migrations/` and are applied by:

   ```bash
   npm run migrate:apps
   ```

   That runner prefixes every table with `_app_<slug>_` (which is what keeps one
   app out of another's data) and records applied files in `_migrations`, so
   re-running it is a no-op. See [docs/apps/database.md](docs/apps/database.md).

3. Seed the first admin:

   ```bash
   # Set INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD in .env.local first.
   npm run seed-admin
   ```

   After login you can remove `INITIAL_ADMIN_*` from `.env.local`.

4. Run it:

   ```bash
   npm run dev
   ```

Scheduled jobs do **not** fire on this path — there is no cron sidecar in front
of a bare `npm run dev`. Trigger a tick by hand with
`npx tsx scripts/run-scheduled-jobs.ts`.

## Authentication

Uses [NextAuth (Auth.js)](https://authjs.dev) with email + password as
the default sign-in method. An admin can enable generic OIDC SSO at
`/admin/authentication`; when SSO is on the login page hides the
password form and shows only a "Login with SSO" button.

## Connectors

Connectors integrate MixOS with external services (HubSpot, Notion, GitHub, etc.).
Their API keys are **not** environment variables — an admin enters them in the UI
at [/admin/connectors](http://localhost:3000/admin/connectors), and MixOS encrypts
them in the database (`CONNECTOR_ENCRYPTION_KEY`).

The keys themselves live in the team's **MixOS 1Password vault**. To get them,
**request access from Anthony (amix@gmail.com)**. **Never share these keys
with anyone**, even if you've been granted access.

## Connecting Claude (MCP)

MixOS runs an MCP server so Claude can answer questions using data from your apps.
In Claude, add a custom connector pointing at:

```
https://mix.mysite.com/api/mcp        # or http://localhost:3000/api/mcp in dev
```

You'll be sent to MixOS to sign in and tick which apps the connection may read.
Access is **read-only** and never exceeds your own permissions — a connection can
only ever see apps you already have. Review or revoke connections at
[/account/mcp](http://localhost:3000/account/mcp).

Apps opt in by declaring tools; see [`docs/apps/mcp.md`](docs/apps/mcp.md) to add
them to yours.

## Developing

To build on MixOS, work from a feature branch and use the guided skills (Claude in
VSCode):

- **`/mix-help`** — new here or unsure what to build? It explains how apps and
  connectors relate, asks what you're trying to do, and recommends what to build
  and which docs to read.
- **`/mix-app`** — create or update an app under `apps/`. Spec:
  [apps/AGENTS.md](apps/AGENTS.md).
- **`/mix-connector`** — create or update a connector under `connectors/`. Spec:
  [connectors/AGENTS.md](connectors/AGENTS.md).
- **`/mix-deploy`** — create your feature branch and, when you're ready, open the
  Pull Request (with a detailed description) for you.

`/mix-deploy` handles branching and the PR so you never commit to `main` directly;
it stops at opening the PR, since merging is what deploys to production. No GitHub
/ `gh` access? It hands you a ready-to-open PR link and body to paste, or contact
Anthony or another developer to open it for you.

There is no publish step. `.githooks/pre-commit` runs
[`scripts/stamp-updated.ts`](scripts/stamp-updated.ts), which stamps `lastUpdated`
on every app or connector with a file in the commit and re-stages the manifest —
so the date shown in the App Manager and Connector Registry always matches the
last commit that touched it. Preview what would be stamped with
`npx tsx scripts/stamp-updated.ts --dry-run`.

Recent, developer-facing changes are summarized in [WHATS-NEW.md](WHATS-NEW.md);
its newest section is printed automatically after you `git pull`.

### Formatting

Formatting is handled by [Prettier](https://prettier.io) with its default
config. The committed [.vscode/settings.json](.vscode/settings.json) sets
Prettier as the default formatter and turns on format-on-save, so once the
**esbenp.prettier-vscode** extension is installed (see Prerequisites) it just
works.

## Troubleshooting

Deeper Docker-specific symptoms are in
[docs/local-docker.md](docs/local-docker.md#troubleshooting).

- **`Cannot connect to the Docker daemon`** — Docker Desktop isn't running.
  Start it with `open -ga Docker` and wait until `docker info` exits 0. Test
  liveness with **bare `docker info`**, never `docker info --format '...'`: the
  templated form exits 0 and prints nothing when the daemon is down, so it
  reports a dead daemon as healthy.
- **`address already in use` / `port is already allocated`** — something else
  holds 3000 (the app), 54321 (Supabase API), 54322 (Postgres), or 54323
  (Studio). Find it with `lsof -nP -iTCP:3000 -sTCP:LISTEN`, then `kill` the PID
  in the second column of that output and re-run. By far the most common cause
  is a host `npm run dev` you forgot about, still holding 3000.

  Starting *another* `npm run dev` is not a way out of this: it collides on the
  same port, and on the Docker path there is no `.env.local` and no database
  running outside the stack, so a host server has no `SUPABASE_URL`, no
  `SUPABASE_SERVICE_ROLE_KEY` and no `DATABASE_URL` — every request fails with
  `Missing required Supabase env vars`. If you deliberately want the host to own
  port 3000, that is a supported workflow, but it needs the containerized
  backend behind it: boot with `npm run dev:docker -- --detach`, free the port
  with `docker compose -p mixos stop app-dev`, and point a host `.env.local` at
  `127.0.0.1` following
  [docs/local-docker.md](docs/local-docker.md#running-nextjs-on-the-host-against-the-container-backend).
- **The first `npm run dev:docker` looks hung** — the Supabase CLI is pulling
  Postgres, Kong, PostgREST, and Studio images, several GB in total, and prints
  nothing while it does. Give it 5–15 minutes on a first run. `docker images`
  in another terminal shows progress.
- **`self-signed certificate` / TLS or SSL errors from Postgres** — `PGSSLMODE`
  is unset. [src/lib/db/pg-options.ts](src/lib/db/pg-options.ts) deliberately
  defaults to `ssl: "require"` because the production database is a hosted
  service on the public internet, but the local container speaks plaintext.
  `.env.docker` sets `PGSSLMODE=disable` for the Docker path; add it to
  `.env.local` yourself if you point a host process at a local Postgres.
- **`Missing required Supabase env vars`** — `SUPABASE_URL` and
  `SUPABASE_SERVICE_ROLE_KEY` are unset. On the Docker path they're generated
  into `.env.docker.local` by `npm run dev:docker`; if that file is missing or
  stale, re-run it. On the hosted path both are in Project Settings → API.
- **`No Postgres connection configured`** — set `DATABASE_URL` to the Supabase
  pooler string (or the discrete `PG*` fields for a local Postgres).
- **Connection timeouts / "too many clients"** — you are probably on the direct
  port-5432 endpoint of a hosted project. Switch `DATABASE_URL` to the
  **transaction pooler** (port 6543); serverless functions open far more
  connections than a long-lived server does.
- **`public._migrations does not exist`** — the platform schema has not been
  applied. Run `npm run db:local` (Docker) or `npm run db:push` (hosted) before
  `npm run migrate:apps`.
- **Nothing works and you want a clean slate** — `npm run docker:reset` stops
  every container and **deletes the local database volume**, so the next
  `npm run dev:docker` starts from an empty database, re-migrates, and re-seeds
  the admin. Local-only data (connector credentials, app rows) is gone; nothing
  in a deployment is touched.
- **Scheduled jobs** — they *do* fire on the Docker path. A `cron` sidecar calls
  `GET /api/cron` with `Authorization: Bearer $CRON_SECRET` every 5 minutes,
  which is byte-for-byte what Vercel Cron does in production. Watch it with
  `docker compose -p mixos logs -f cron`. On the hosted-Supabase path (bare
  `npm run dev`) there is no ticker; run one manually with
  `npx tsx scripts/run-scheduled-jobs.ts`.

## Deploying

Vercel builds and deploys directly from GitHub: a Preview deployment per pull
request, Production on merge to `main`. Docker is a local development tool only —
no image is built or pushed by CI, and there is no build or deploy step in this
repo's CI. [`.github/workflows/ci.yml`](.github/workflows/ci.yml) only gates PRs
with lint, typecheck, and build, with no database.

One-time setup:

1. Import the repo into Vercel. The framework preset and build command are
   detected automatically.
2. Set the environment variables from `.env.local.example` in the Vercel project
   (Settings → Environment Variables). `NEXTAUTH_URL` should be the production
   domain; `CRON_SECRET` is required or `/api/cron` refuses to run. **Nothing
   from `.env.docker` belongs here** — those values are public.
3. Push the schema to the production Supabase project: `npm run db:push`.
4. Seed the first admin (`npm run seed-admin` against the production
   `DATABASE_URL`), then remove `INITIAL_ADMIN_*`.

`vercel.json` registers the scheduler cron (`/api/cron`, every 5 minutes). Note
that Vercel's Hobby plan only permits **daily** cron schedules — the 5-minute
cadence needs a Pro plan.
