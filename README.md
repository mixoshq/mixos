<p align="center">
  <img src="public/themes/mixos/logo.png" alt="MixOS" width="96" height="92">
</p>

<h1 align="center">MixOS</h1>

<p align="center">
  A self-hostable platform for building small internal apps —
  each one a folder, not a project.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MPL 2.0" src="https://img.shields.io/badge/license-MPL--2.0-brightgreen.svg"></a>
  <img alt="Next.js 16" src="https://img.shields.io/badge/Next.js-16-black.svg">
  <img alt="Node 22+" src="https://img.shields.io/badge/node-22%2B-brightgreen.svg">
</p>

---

MixOS gives a team one place to sign in, one set of roles, one look, and one
set of credentials for the outside world — and then lets each small tool live as
a folder inside it. Drop a directory under `apps/`, declare a manifest, and it
shows up in the launcher with authentication, permissions, its own database
tables, scheduled jobs, notifications, and an MCP surface already wired up.

It is built with [Next.js](https://nextjs.org) and backed by Postgres — any
Postgres 13 or later, from a container on your own server to Supabase, Neon or
RDS. **Locally the whole system — app, Postgres, and the scheduler tick — runs
in Docker on your machine**, so you don't need a cloud project to get started,
and [hosting it](docs/hosting/) is one Compose file, one Render Blueprint, or a
Railway template.

Three extension points, in increasing order of scope:

|                | What it is                                            | Lives in             | Guide                                        |
| -------------- | ----------------------------------------------------- | -------------------- | -------------------------------------------- |
| **Apps**       | A tool people use: pages, API routes, tables, jobs    | `apps/<slug>/`       | [apps/AGENTS.md](apps/AGENTS.md)             |
| **Connectors** | A shared, credentialed link to an external service    | `connectors/<name>/` | [connectors/AGENTS.md](connectors/AGENTS.md) |
| **Themes**     | The colours, type, and logo every app renders through | `themes/<slug>/`     | [themes/AGENTS.md](themes/AGENTS.md)         |

## Quick start

Two steps. Clone the repo:

```bash
git clone <repo-url>
cd mixos
```

Then open it in VSCode and run **`/mixos init`** in Claude Code:

```
/mixos init
```

That skill is the setup. It surveys what your machine is missing, asks once
before changing anything, installs Node / Docker / the VSCode extensions (and
Homebrew on a Mac), boots the whole stack in Docker, applies every migration,
seeds an admin, and hands you a login for
[http://localhost:3000](http://localhost:3000). Budget 5–15 minutes on a first
run — most of it is Docker pulling images.

From there, `/mixos help` explains how apps, connectors, and themes relate and
recommends what to build first.

The guided installer covers **macOS**, **Linux**, and **Windows via WSL 2**. On
Windows, the stack runs inside WSL: clone the repository there, under your Linux
home directory — run `/mixos init` anywhere else on Windows and it walks you
through setting WSL up first. Not using Claude Code, or want to know what the
skill actually does? The same steps by hand are under
[Prerequisites](#prerequisites) and [Manual setup](#manual-setup).

## Contents

- [Quick start](#quick-start)
- [Prerequisites](#prerequisites)
- [Manual setup](#manual-setup)
- [Running locally](#running-locally)
- [Alternative: your own Postgres](#alternative-your-own-postgres)
- [Extending MixOS](#extending-mixos)
- [Authentication](#authentication)
- [Connectors](#connectors)
- [Connecting Claude (MCP)](#connecting-claude-mcp)
- [Developing](#developing)
- [Troubleshooting](#troubleshooting)
- [Hosting MixOS](#hosting-mixos)
- [Releases](#releases)
- [Licence](#licence)

## Prerequisites

| What | Version | Notes |
|---|---|---|
| Operating system | macOS, Linux, or Windows with WSL 2 | On Windows the stack runs inside WSL. Git Bash and PowerShell can't run it. |
| [Node.js](https://nodejs.org) | **24**, pinned in `.nvmrc`. 22 is the minimum | Node 22 reaches end of life on 30 April 2027. Every shell that runs MixOS commands needs it, not only your terminal (see below). |
| npm | Ships with Node | The lockfile is npm's: install with `npm ci`, not pnpm or yarn. |
| Git | Any recent version | |
| Docker | Docker Desktop (macOS, Windows), or Docker Engine with the Compose v2 plugin (Linux) | Give Docker about 4 GiB of memory, and keep several GB of disk free for images. |
| Free ports | 3000, 54321, 54322, 54323 | The app, the Supabase API, Postgres, and Supabase Studio. |
| [VS Code](https://code.visualstudio.com/) | Current | With the Claude Code and Prettier extensions. Claude Code needs a Claude account; only the guided `/mixos` path uses it. |
| [GitHub CLI](https://cli.github.com) | Optional | Lets `/mixos deploy` open pull requests for you. Without it you get a link to paste. |

`/mixos init` checks all of this and installs what's missing. In detail:

- [Visual Studio Code](https://code.visualstudio.com/) — the editor MixOS is built
  to be worked on in. After installing, add these two extensions (Extensions
  view → search by ID, or run the `code` commands below):
  - **Anthropic.claude-code** — Claude Code, the assistant that drives the
    guided `/mixos` command (`/mixos init`, `/mixos help`, `/mixos app`,
    `/mixos connector`, `/mixos theme`, `/mixos deploy`).
  - **esbenp.prettier-vscode** — Prettier, for consistent formatting.

  ```bash
  code --install-extension Anthropic.claude-code
  code --install-extension esbenp.prettier-vscode
  ```

  (`code` on the command line requires the
  [VSCode shell command](https://code.visualstudio.com/docs/setup/mac#_launching-from-the-command-line);
  open VSCode and run **Shell Command: Install 'code' command in PATH** from the
  Command Palette if it isn't available. `/mixos init` installs both extensions for
  you automatically.)

- Docker — runs the local database and, in the default workflow, the app
  itself. [Docker Desktop](https://www.docker.com/products/docker-desktop/) on
  macOS and Windows; on Windows, turn on its WSL integration for the
  distribution this repository lives in. On Linux, Docker Engine with the
  Compose plugin — `curl -fsSL https://get.docker.com | sudo sh`, then
  `sudo usermod -aG docker "$USER"` and sign out and back in (other
  distributions: https://docs.docker.com/engine/install/). On macOS install the
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

- [Node.js](https://nodejs.org) 24 — the version pinned in `.nvmrc`, so
  `nvm use` selects it for you; 22 or newer works. Node runs the boot script and
  the Supabase CLI on the host even when the app itself runs in a container.

  **Every shell has to find it, not only your terminal.** Git hooks, editors and
  Claude Code often start shells that never read `~/.zprofile`, so on a Mac
  where Homebrew is set up there (`brew shellenv`), they can find an older Node
  first — typically one a nodejs.org installer left in `/usr/local/bin`.
  `npm run dev`, `build`, `typecheck` and `dev:docker` check before they start.
  When the Node is too old, they say which newer one is installed but hidden,
  and how to put it first (`node scripts/check-node.mjs` runs the same check on
  its own).
- npm — ships with Node. The lockfile is npm's, so install with `npm ci`, not
  pnpm or yarn.

## Manual setup

This is what [`/mixos init`](#quick-start) does on your behalf. Follow it if you
aren't using Claude Code, or if you'd rather drive the steps yourself.

1. Install Docker and start it once. On macOS and Windows that is Docker
   Desktop, whose first launch shows a license agreement — and on macOS asks
   for your password to install a privileged helper — which can't be scripted.
   On Linux, Docker Engine is a system service the install already started.

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
   _finish_ instead — a script, or Claude booting the stack for you — add
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
_not_ detach.

A second checkout can run at the same time as this one by naming itself in
`.env.instance` (copy `.env.instance.example`) — its own compose project, its
own Supabase stack, its own database and ports. Without that file a checkout is
`mixos` on port 3000, exactly as above. See
[Local development in Docker](docs/local-docker.md#more-than-one-instance-on-one-machine).

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

## Alternative: your own Postgres

Node on the host and a database you choose: a Supabase or Neon project, a
Postgres on your machine, or a shared development database. Use it if you can't
run Docker, or if you need to work against shared data.

1. Configure environment variables:

   ```bash
   cp .env.local.example .env.local
   npm run keys:generate        # prints a fresh value for every key
   ```

   Populate `.env.local`. The database is one variable, `DATABASE_URL` — for a
   hosted project, its pooled connection string (Supabase: the **transaction
   pooler**, port 6543). Add `PGSSLMODE=disable` for a Postgres that speaks
   plaintext, such as one on your own machine. The cryptographic keys —
   `AUTH_SECRET`, `CRON_SECRET`, and the six independent keys inventoried in
   [`src/lib/env/keys.ts`](src/lib/env/keys.ts) — come from
   `npm run keys:generate`; `npm run keys:check` exits non-zero if any is
   missing or malformed. Each key protects exactly one thing, so rotating one has
   a bounded blast radius; see
   [docs/security-architecture.md](docs/security-architecture.md).

2. Apply the schema:

   ```bash
   npm run db:migrate       # applies supabase/migrations/*.sql to DATABASE_URL
   npm run migrate:apps     # per-app tables
   ```

   `db:migrate` records what it applied in the same ledger the Supabase CLI
   keeps, so against a linked Supabase project `npm run db:push` does the same
   job, and the two can be mixed. Schema changes append a new
   `supabase/migrations/NNNN_*.sql` with the next free number. The ledger
   records a migration by its number, so two files with one number are
   refused; see [OS-UPDATES.md](OS-UPDATES.md).

   Apps that declare their own tables are separate — their migrations live in
   `apps/<slug>/migrations/` and are applied by `npm run migrate:apps`. Each app
   gets a schema of its own, `app_<slug>`, and its migrations run there as the
   app's own database role, after every statement has been checked against what
   an app may do (which is what keeps one app out of another's data, and out of
   the platform's). Applied files are recorded in `_migrations`, so re-running
   it is a no-op. See [docs/apps/database.md](docs/apps/database.md).

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

## Extending MixOS

Everything you build lives in one of three top-level folders. Nothing is
registered in a central file: the registry is generated from the folders
themselves (`npm run registry`, which `dev` and `build` run for you), so adding
a directory with a valid manifest is the whole installation step.

**From the Registry.** In a checkout, Admin > Apps, Connectors and Themes can
browse [mixos.org](https://mixos.org) and install from it. An installed app or
connector waits in `.mixos/pending/`, where nothing runs it, until you register
it: with **Review and register** on Admin > Apps or Admin > Connectors, which
first shows what will run, or in a terminal:

```bash
npm run register                        # what is waiting
npm run register -- app/<slug>          # move it into apps/ and run its code
npm run register -- app/<slug> --smoke  # and migrate, activate and smoke-test it here
npm run register -- app/<slug> --discard
npm run register -- --recover           # after one that stopped midway
```

Registering checks the folder is still what was verified, moves it into `apps/`
or `connectors/` and runs the registry generator, which is the first time its
code runs. A theme has no code, so installing it registers it.

Every install writes a record into the extension's folder, `.registry.json`:
where it came from, the release, and the hashes that were verified. To ship an
extension, commit its folder, record included, and deploy. Register hands back
what that takes: the files it added, a prepared commit message and the
commands. `/mixos deploy` does the same and opens the pull request. Check that
`git status` lists every file: a rule in your `.gitignore` can leave one out,
and `npm run register` warns when one does.

Don't edit an installed folder. The registry generator compares it with its
record, and Browse then says "modified locally". A pull request with an
installed folder that no longer matches its record fails the extensions check
(`.github/workflows/extensions.yml`), which also smoke-tests each app a pull
request changes. On Windows,
work in WSL, or set `git config core.autocrlf false` in the repository:
converting line endings changes the files, so every installed folder would
count as modified. Extensions added before installs kept a record count as
local. To give one a record, remove its folder and install it again from the
Registry. The release step then counts it as a different extension under the
same name, once: it switches the app off and revokes its API keys, or
disables the connector, until an admin types its name to turn it back on. See
[docs/security-architecture.md §31](docs/security-architecture.md#31-installing-from-the-repository).

Each guide below is the authoritative spec — file layout, manifest fields, APIs,
and the invariants that are easy to get wrong. Read the relevant one in full
before writing code; don't infer conventions from surrounding code alone.

### Apps → [`apps/AGENTS.md`](apps/AGENTS.md)

An app is a folder under `apps/<slug>/` with an `app.json` manifest. The folder
name _is_ the slug. From the manifest an app can declare pages, API routes,
its own Postgres tables (in a schema of its own, `app_<slug>`), scheduled jobs, web push
notifications, MCP tools, role requirements, and public or password-protected
surfaces. The platform supplies auth, navigation, theming, telemetry, and
per-app data isolation; the app supplies the parts that are actually specific to
it. Start from [`apps/_template/`](apps/_template/).

Deep dives live in [`docs/apps/`](docs/apps/): [architecture](docs/apps/architecture.md),
[pages](docs/apps/pages.md), [API routes](docs/apps/api-routes.md),
[database](docs/apps/database.md), [roles](docs/apps/roles.md),
[scheduled jobs](docs/apps/scheduled-jobs.md), [notifications](docs/apps/notifications.md),
[widgets](docs/apps/widgets.md), [MCP](docs/apps/mcp.md), and [UX](docs/apps/ux.md).

### Connectors → [`connectors/AGENTS.md`](connectors/AGENTS.md)

A connector is a folder under `connectors/<name>/` with a `connector.json`
manifest, wrapping one external service (Gmail, Slack, GitHub, …). It owns the
credential handling, the scopes it may request, retry and failure semantics, and
the typed client apps call — so several apps can share one authenticated link
instead of each rolling its own. Credentials are entered in the admin UI and
encrypted at rest, never committed. Start from [`connectors/_template/`](connectors/_template/)
or [`connectors/_template-oauth/`](connectors/_template-oauth/).

Deep dives live in [`docs/connectors/`](docs/connectors/): [architecture](docs/connectors/architecture.md),
[implementation](docs/connectors/implementation.md), [credentials](docs/connectors/credentials.md),
[scopes](docs/connectors/scopes.md), [webhooks](docs/connectors/webhooks.md),
[failure handling](docs/connectors/failure-handling.md), and
[usage in apps](docs/connectors/usage-in-apps.md).

### Themes → [`themes/AGENTS.md`](themes/AGENTS.md)

A theme is a folder under `themes/<slug>/` holding a `theme.json` of design
tokens plus its own logo, icons, and fonts. Every app renders through the active
theme, so a single switch restyles the whole system — apps never hard-code
colour. Contrast is checked, not assumed. Start from [`themes/_template/`](themes/_template/)
and compare against the shipped [`mixos`](themes/mixos/) and
[`mixos-dark`](themes/mixos-dark/).

Deep dives live in [`docs/themes/`](docs/themes/): [architecture](docs/themes/architecture.md),
[tokens](docs/themes/tokens.md), [authoring](docs/themes/authoring.md),
[assets](docs/themes/assets.md), and [contrast](docs/themes/contrast.md).

### The guided path

If you're working with Claude Code in VSCode, the `/mixos` command scaffolds any
of the three for you and reads the right guide first. Run `/mixos` on its own for
the list of actions; add `-q` to any action to have Claude ask clarifying
questions before it starts.

- **`/mixos help`** — new here or unsure what to build? It explains how apps,
  connectors, and themes relate, asks what you're trying to do, and recommends
  what to build and which docs to read.
- **`/mixos app`** — create, update, or design-review an app under `apps/`.
- **`/mixos convert`** — turn an existing application (a local folder, a git URL,
  or code you've staged here) into a MixOS app. It inventories the original,
  writes a conversion plan to `apps/<slug>/plans/`, stops for your approval, then
  builds the first slice.
- **`/mixos connector`** — create or update a connector under `connectors/`.
- **`/mixos theme`** — create or update a theme under `themes/`.
- **`/mixos deploy`** — commit what you have in sensible commits, push, and
  open the pull request (branching first if you are on `main`). `--reset`
  brings you back to a fresh `main` after the PR merges. `release` cuts a
  version of MixOS, for maintainers (see [Releases](#releases)).

## Authentication

Uses [NextAuth (Auth.js)](https://authjs.dev) with email and password as the only
sign-in method. The first account comes from `npm run seed-admin`; after that an
admin creates and manages people at
[/admin/users](http://localhost:3000/admin/users). Setting
`ALLOWED_EMAIL_DOMAINS` restricts sign-in to a comma-separated list of email
domains; left blank, any provisioned address may sign in.

Sessions are JWTs, but admin status and a per-user session version are re-read
from the database on every session resolution rather than trusted for the
token's lifetime — so a demotion, a deletion, or an explicit revocation takes
effect on the next request instead of at token expiry. Apps declare which roles
they require, enforced per request; see [docs/apps/roles.md](docs/apps/roles.md).

## Connectors

Connectors integrate MixOS with external services (monday.com, Slack, GitHub, etc.).
Their API keys are **not** environment variables — an admin enters them in the UI
at [/admin/connectors](http://localhost:3000/admin/connectors), and MixOS encrypts
them in the database with `CONNECTOR_ENCRYPTION_KEY`.

You obtain each credential from that service's own developer console (an API key,
or an OAuth client for connectors that use it), following the setup guide shown on
the connector's tile in the registry. Because they are entered through the UI and
stored encrypted, no external credential ever belongs in this repo, in
`.env.local`, or in a deployment's environment variables.

Connectors marked `userScoped` are different: each person connects their own
account at [/account/connections](http://localhost:3000/account/connections), and
those grants are encrypted under a separate key. See
[docs/connectors/credentials.md](docs/connectors/credentials.md).

## Connecting Claude (MCP)

MixOS runs an MCP server so Claude can answer questions using data from your apps.
In Claude, add a custom connector pointing at:

```
https://<your-mixos-domain>/api/mcp    # or http://localhost:3000/api/mcp in dev
```

You'll be sent to MixOS to sign in and tick which apps the connection may read.
Access is **read-only** and never exceeds your own permissions — a connection can
only ever see apps you already have. Review or revoke connections at
[/account/mcp](http://localhost:3000/account/mcp).

Apps opt in by declaring tools; see [`docs/apps/mcp.md`](docs/apps/mcp.md) to add
them to yours.

## Developing

Work from a feature branch; `/mixos deploy` creates one if you are still on
`main`, commits your work, and opens the pull request (with a detailed
description). It stops at opening the PR,
since merging is what deploys to production. Without GitHub / `gh` access it
hands you a ready-to-open PR link and body to paste.

Checks that gate a pull request — run them before pushing:

```bash
npm run lint
npm run typecheck
npm run build
npm run verify:connectors   # connector manifests match their implementations
```

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) gates every pull request
with lint, `npm audit --audit-level=high`, typecheck, and build — no database is
involved. `verify:connectors` is a local check; run it after touching a
connector manifest.

There is no publish step. `.githooks/pre-commit` runs
[`scripts/stamp-updated.ts`](scripts/stamp-updated.ts), which stamps `lastUpdated`
on every app, connector, or theme with a file in the commit and re-stages the
manifest — so the date shown in the App Manager and Connector Registry always
matches the last commit that changed it. A merge doesn't re-stamp what it only
brings in from the other branch, so merging `main` into a pull request adds no
date changes. An extension installed from the Registry is never stamped: its
`.registry.json` records the files that were verified, and its date is its
publisher's. Preview what would be stamped with
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

  Starting _another_ `npm run dev` is not a way out of this: it collides on the
  same port, and on the Docker path there is no `.env.local` and no database
  running outside the stack, so a host server has no `DATABASE_URL` — every
  request fails with `No Postgres connection configured`. If you deliberately
  want the host to own port 3000, that is a supported workflow, but it needs the
  containerized backend behind it: boot with `npm run dev:docker -- --detach`,
  free the port with `docker compose -p mixos stop app-dev`, and point a host
  `.env.local` at `127.0.0.1` following
  [docs/local-docker.md](docs/local-docker.md#running-nextjs-on-the-host-against-the-container-backend).

- **The first `npm run dev:docker` looks hung** — the Supabase CLI is pulling
  Postgres, Kong, PostgREST, and Studio images, several GB in total, and prints
  nothing while it does. Give it 5–15 minutes on a first run. `docker images`
  in another terminal shows progress.
- **`self-signed certificate` / TLS or SSL errors from Postgres** — `PGSSLMODE`
  is unset. [src/lib/db/pg-options.ts](src/lib/db/pg-options.ts) deliberately
  defaults to `ssl: "require"` because a hosted database sits on the public
  internet, but the local container speaks plaintext. `.env.docker` sets
  `PGSSLMODE=disable` for the Docker path; add it to `.env.local` yourself if
  you point a host process at a local Postgres.
- **`No Postgres connection configured`** — `DATABASE_URL` is unset. On the
  Docker path it's generated into `.env.docker.local` by `npm run dev:docker`;
  if that file is missing or stale, re-run it. Otherwise set it to your
  database's connection string (or the discrete `PG*` fields).
- **Connection timeouts / "too many clients"** — you are probably on the direct
  port-5432 endpoint of a hosted project. Switch `DATABASE_URL` to the
  **transaction pooler** (port 6543); serverless functions open far more
  connections than a long-lived server does.
- **`public._migrations does not exist`** — the platform schema has not been
  applied. Run `npm run db:local` (Docker) or `npm run db:migrate` (any other
  database) before `npm run migrate:apps`.
- **Nothing works and you want a clean slate** — `npm run docker:reset` stops
  every container and **deletes the local database volume**, so the next
  `npm run dev:docker` starts from an empty database, re-migrates, and re-seeds
  the admin. Local-only data (connector credentials, app rows) is gone; nothing
  in a deployment is touched.
- **Scheduled jobs** — they _do_ fire on the Docker path. A `cron` sidecar calls
  `GET /api/cron` with `Authorization: Bearer $CRON_SECRET` every 5 minutes,
  which is byte-for-byte what Vercel Cron does in production. Watch it with
  `docker compose -p mixos logs -f cron`. On the own-Postgres path (bare
  `npm run dev`) there is no ticker; run one manually with
  `npx tsx scripts/run-scheduled-jobs.ts`.

## Hosting MixOS

A deployment is the server, a Postgres 13+ database from any provider, and a
5-minute tick against `/api/cron`. MixOS connects to the database with one
`DATABASE_URL` and needs nothing from it but Postgres — no PostgREST, no
Supabase API keys. Every path runs the same release step before new code takes
traffic: the platform schema, the app migrations, and the first admin.

| Path | Guide |
| --- | --- |
| Docker Compose on your own server — Postgres, the app, HTTPS and the tick on one machine | [docs/hosting/docker-compose.md](docs/hosting/docker-compose.md) |
| Coolify or Dokploy, from the same Compose file | [docs/hosting/docker-compose.md](docs/hosting/docker-compose.md#coolify) |
| Render — a Blueprint with every secret generated ([`render.yaml`](render.yaml)) | [docs/hosting/render.md](docs/hosting/render.md) |
| Railway — publishable as a one-click template ([`railway.json`](railway.json)) | [docs/hosting/railway.md](docs/hosting/railway.md) |
| Vercel with Neon, Supabase, or any Postgres | [docs/hosting/vercel.md](docs/hosting/vercel.md) |

[docs/hosting/README.md](docs/hosting/README.md) lists the environment every
path needs and explains the release step. Deploy your fork, so the apps you add
are in the build. To make an instance run only what it was deployed with, set
`INSTALL_APPS`, `INSTALL_CONNECTORS` or `INSTALL_THEMES` to `false`: the
catalogue's Browse pages and its install actions go away for that kind, and
Register, from the page or `npm run register`, won't register it
([details](docs/hosting/README.md#fixing-what-an-instance-runs)).

Once a day, each instance asks mixos.org about the extensions it installed from
there, so admins see a release its publisher withdrew. It sends a random
instance ID and each of those extensions' kind, slug and version, and nothing
else. It also reads mixos.org's list of MixOS releases, sending nothing about
the instance, so admins see when a newer one is out.
`MIXOS_UPDATE_CHECK=false` turns both off
([what is sent and kept](docs/hosting/README.md#what-mixos-sends-to-mixosorg)).

Before exposing a deployment publicly, read
[docs/security-architecture.md](docs/security-architecture.md) — the trust
boundaries, the key inventory and what rotating each key costs, and the
Row-Level Security coverage — and
[docs/secure-edge-gateway-architecture.md](docs/secure-edge-gateway-architecture.md)
for the request path in front of it.

## Releases

A release of MixOS is an annotated tag on `main`, `vX.Y.Z`, with a
[GitHub Release](https://github.com/mixoshq/mixos/releases) whose notes are
its section of `CHANGELOG.md`: breaking changes first, then features and
fixes. Until 1.0, a release with a breaking change or any change to the
platform is a minor version (`v0.2.0` → `v0.3.0`), and any other release is a
patch (`v0.3.0` → `v0.3.1`). Prereleases have a suffix, such as
`v0.3.0-rc.1`, and GitHub marks them as prereleases.

**To upgrade a deployment,** merge the newest release tag into your fork, not
`upstream/main`, which holds work that hasn't been released yet. The steps
are in [docs/hosting/README.md](docs/hosting/README.md#upgrading).

**To cut a release** (maintainers), run `/mixos deploy release` on an
up-to-date `main`. It opens a release PR that sets the version in
`package.json` and adds the `CHANGELOG.md` section, both worked out by
[`scripts/release-prep.ts`](scripts/release-prep.ts) from the Conventional
Commits since the last release. Once the PR merges, run it again: it gives you
the commands that tag the merge commit and publish the GitHub Release, and a
person runs them.

A version release is not the release step, `npm run release`, which applies
a deployment's database migrations.

## Licence

MixOS is licensed under the **Mozilla Public License 2.0** ([`LICENSE`](LICENSE)).

The platform is copyleft; **what you build on it is yours.** Apps, connectors
and themes under `apps/`, `connectors/` and `themes/` are not Covered Software
and may be licensed however you like, including proprietary — importing
platform code does not change that. The scaffolding templates are public domain
(CC0) so a copied template never carries obligations into your work.

See [`LICENSING.md`](LICENSING.md) for the boundary in detail and why MPL was
chosen over GPL and AGPL. Contributions are made under the Developer
Certificate of Origin — see [`CONTRIBUTING.md`](CONTRIBUTING.md). The MixOS name
and logo are covered separately by [`TRADEMARK.md`](TRADEMARK.md).
