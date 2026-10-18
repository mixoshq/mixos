# Running a development copy

A development copy is MixOS running from a checkout on your own computer. It's
where you build extensions, install them from the Registry, try an upgrade and
run the tests, before anything reaches your deployment. There's no account to
create and nothing to pay for.

The dev container runs on keys that are fixed and public, shared by everyone
with the code, so a development copy never goes online. To put MixOS where your
team can reach it, see [How to install](install.md).

## What you need

| What | Version | Notes |
| --- | --- | --- |
| Operating system | macOS, Linux, or Windows with WSL 2 | On Windows, MixOS runs inside WSL. Git Bash and PowerShell can't run it |
| [Node.js](https://nodejs.org) | **24**, pinned in `.nvmrc`, so `nvm use` selects it. 22 is the minimum | Node 22 reaches end of life on 30 April 2027. Every shell that runs MixOS's commands needs it, not only your terminal |
| npm | Comes with Node | The lockfile is npm's: install with `npm ci`, not pnpm or yarn |
| Git | Any recent version | |
| Docker | Docker Desktop on macOS and Windows, or Docker Engine with the Compose v2 plugin on Linux | Give Docker about 4 GiB of memory, and keep several GB of disk free |
| Free ports | 3000, 54321, 54322, 54323 | MixOS, the Supabase API, Postgres, and Supabase Studio |
| [VS Code](https://code.visualstudio.com/) | Current | With the Claude Code and Prettier extensions. Claude Code needs a Claude account; only the guided `/mixos` commands use it |
| [GitHub CLI](https://cli.github.com) | Optional | Lets `/mixos deploy` open pull requests for you. Without it, you get a link to paste |

`/mixos init` checks all of this and installs what's missing. To do it yourself:

- **Node in every shell.** Git hooks, editors and Claude Code often start shells
  that never read `~/.zprofile`. On a Mac where Homebrew is set up there
  (`brew shellenv`), they can find an older Node first, typically one a nodejs.org installer left in
  `/usr/local/bin`. `npm run dev`, `build`, `typecheck` and `dev:docker` check
  first, and when the Node is too old they name the newer one that's installed
  but hidden, and how to put it first. `node scripts/check-node.mjs` runs the
  same check on its own.
- **Docker on macOS**: install Docker Desktop as the **cask**,
  `brew install --cask docker-desktop`. A plain `brew install docker` gets you
  the `docker` command with no daemon, which fails later with "Cannot connect to
  the Docker daemon". Docker Desktop is free for personal use, education and
  small companies; organizations above 250 employees or $10M annual revenue need
  a paid subscription, and [OrbStack](https://orbstack.dev) is an alternative.
- **Docker on Linux**: Docker Engine with the Compose plugin, and your user in
  the `docker` group. Docker's script covers Ubuntu, Debian, Fedora, CentOS and
  RHEL; for anything else, follow
  [Docker's install guide](https://docs.docker.com/engine/install/). Sign out
  and back in afterwards: the group change only reaches new sessions.

  ```bash
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
  ```

- **Docker on Windows**: Docker Desktop, with its WSL integration turned on for
  the distribution your copy lives in. See [On Windows](#on-windows).
- **VS Code extensions**: in the Extensions view (`Cmd+Shift+X` on macOS,
  `Ctrl+Shift+X` on Linux and Windows), install **Claude Code for VS Code** by
  Anthropic, and Prettier. Or from a terminal:
  `code --install-extension Anthropic.claude-code` and
  `code --install-extension esbenp.prettier-vscode`. If `code` isn't found on a
  Mac, run **Shell Command: Install 'code' command in PATH** from VS Code's
  Command Palette.

## Quick start with `/mixos init`

The easiest way to set up a development copy is to let Claude do it, in VS Code.
You install VS Code and the Claude Code extension; Claude installs and starts
everything else.

1. **Get the code.** In VS Code, open the Command Palette (`Cmd+Shift+P` on
   macOS, `Ctrl+Shift+P` on Linux and Windows), run **Git: Clone**, and paste
   your fork's address, or `https://github.com/mixoshq/mixos.git` to look around
   first. Choose **Open** when VS Code offers to open it. On macOS, if you're
   offered the command line developer tools, choose **Install**: that's where
   `git` comes from. On Linux, install `git` with your package manager if it's
   missing, such as `sudo apt install git`.
2. **Run `/mixos init`.** In the Claude Code panel, type `/mixos init` and press
   Enter. Claude checks what your computer is missing (Node, Docker, the VS Code
   extensions, and Homebrew on a Mac), shows you the list, and asks once before
   installing anything. Then it starts MixOS and its database, applies every
   migration, and creates your admin login. It stops only when it needs you: to
   type your password, or to click through Docker the first time it opens. On
   Linux, installing Docker needs administrator rights, so Claude gives you one
   command to paste.
3. **Open MixOS** at [http://localhost:3000](http://localhost:3000), and sign in
   with the email and password Claude gives you.

Budget 5 to 15 minutes the first time, most of it Docker downloading images. It
can look stuck for minutes at a time; it isn't. Running `/mixos init` again is
safe: it skips whatever is already in place. From there, `/mixos help` explains
how apps, connectors and themes relate and suggests what to build first.

### On Windows

MixOS runs inside WSL 2, the Linux built into Windows.

1. Open **PowerShell as Administrator**, run `wsl --install`, and restart when
   it asks. Ubuntu opens afterwards: choose a Linux username and password.
2. Install
   [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/).
   In its **Settings > Resources > WSL integration**, turn on **Ubuntu**.
3. In VS Code, install the **WSL** extension by Microsoft, then run **WSL:
   Connect to WSL** from the Command Palette.

Do everything else in that WSL window, and keep your copy in your Linux home
folder, not under `/mnt/c`, where it runs slowly and edits don't reload. Run
`/mixos init` anywhere else on Windows and it walks you through setting WSL up
first.

## The dev container, by hand

This is what `/mixos init` does for you.

1. **Start Docker once.** On macOS and Windows, Docker Desktop's first launch
   shows a licence agreement, and on macOS asks for your password to install a
   helper. That part can't be scripted.
2. **Clone and install:**

   ```bash
   git clone https://github.com/<you>/mixos.git
   cd mixos
   npm ci
   ```

   `npm ci` rather than `npm install`: it installs exactly what
   `package-lock.json` pins, and fails if the lockfile has drifted, as CI and
   both Dockerfiles do.

3. **Start everything:**

   ```bash
   npm run dev:docker
   ```

   It starts the Supabase local stack, writes the database's address to
   `.env.docker.local`, applies the platform migrations and each app's, creates
   the admin login, and starts MixOS in a container with hot reload. The first
   run downloads several GB and can take 5 to 15 minutes, with no visible
   progress for long stretches.

4. **Sign in** at [http://localhost:3000](http://localhost:3000) with the
   `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD` in
   [`.env.docker`](../../.env.docker).

There's no secret to generate and no `.env.local` to fill in. `.env.docker` is
committed on purpose: every value in it is a throwaway that only ever protects a
database on your own computer. **Never reuse any of them in a deployment.** The
committed `AUTH_SECRET` lets anyone with the repository forge a session, and the
committed `CONNECTOR_ENCRYPTION_KEY` decrypts any credential stored with it.
That's also why MixOS listens only on your own computer here.

`npm run dev:docker` then stays in the foreground, showing the logs, so an error
appears in front of you. Ctrl-C stops MixOS's containers and leaves the database
running, so the next start skips the slow part.

### The commands

```bash
npm run dev:docker              # start the database and MixOS, with hot reload
npm run dev:docker -- --detach  # the same, but return once MixOS answers
npm run docker:prod             # the production image instead, to reproduce a deploy
npm run docker:down             # stop everything, keep the data
npm run docker:reset            # stop everything and DELETE the local database
npm run db:local                # apply new platform migrations
npm run migrate:apps            # apply new app migrations
```

`--detach` starts everything in the background, waits until
`http://localhost:3000/api/health/ready` answers 200, and exits, so a zero exit
means MixOS really is serving. Stop it with `npm run docker:down`. The bare `--`
is npm's: `npm run dev:docker --detach` silently starts attached.

`npm run dev:docker` applies both kinds of migration every time it starts, so
you only need `db:local` and `migrate:apps` when you add a migration while
MixOS is running.

Supabase Studio, for browsing your local data, is at
[http://localhost:54323](http://localhost:54323) while MixOS is running.

### More than one copy on one machine

A second checkout can run at the same time as the first by naming itself in
`.env.instance`: copy [`.env.instance.example`](../../.env.instance.example).
It gets its own Compose project, Supabase stack, database and ports. Without the
file, a checkout is `mixos`, on port 3000. A shell value beats the file:

```bash
MIXOS_INSTANCE=mixos-test MIXOS_PORT=3002 npm run dev:docker
```

[Local development in Docker](../local-docker.md) explains how the dev container
fits together: what runs where, the port map, the environment files, and why
containers reach the database at `host.docker.internal` while your terminal uses
`127.0.0.1`.

## `npm run dev` on your computer

You can also run Next.js directly on your computer, with `npm run dev`.

### Against the dev container's database

It's a fallback for slow hot reload, not the default. Start the stack with
`npm run dev:docker -- --detach`, free port 3000 with
`docker compose -p mixos stop app-dev`, and point a `.env.local` at
`127.0.0.1:54322` with `PGSSLMODE=disable`. Copy the other values from
`.env.docker` too, so sessions and saved connector credentials keep working.
Then run `npm run dev`. The details are in
[Running Next.js on the host](../local-docker.md#running-nextjs-on-the-host-against-the-container-backend).

### With a database of your own

A Postgres on your computer, a Supabase or Neon project, or a development
database you share. Use it if you can't run Docker, or need shared data. It's
more setup, not less.

1. **Configure it:**

   ```bash
   cp .env.local.example .env.local
   npm run keys:generate        # a fresh value for every key
   ```

   Fill in `.env.local`. The database is one variable, `DATABASE_URL`: for a
   hosted project, its pooled connection string (Supabase: the **transaction
   pooler**, port 6543). Add `PGSSLMODE=disable` for a Postgres that speaks
   plaintext, such as one on your computer. The keys come from
   `npm run keys:generate`, and `npm run keys:check` says whether any is
   missing or malformed.

2. **Apply the schema:**

   ```bash
   npm run db:migrate       # the platform schema, supabase/migrations/*.sql
   npm run migrate:apps     # each app's tables
   ```

   `db:migrate` records what it applied in the ledger the Supabase CLI keeps, so
   against a linked Supabase project `npm run db:push` does the same job, and the
   two can be mixed. A change to the platform schema is a new
   `supabase/migrations/NNNN_*.sql`, with the next free number; see
   [OS-UPDATES.md](../../OS-UPDATES.md). Each app's migrations live in
   `apps/<slug>/migrations/` and run in a schema of its own, `app_<slug>`, as the
   app's own database role: see [Database](../apps/database.md).

3. **Create the first admin.** Set `INITIAL_ADMIN_EMAIL` and
   `INITIAL_ADMIN_PASSWORD` in `.env.local`, then run `npm run seed-admin`. Once
   you've signed in, you can remove them.

4. **Run it:** `npm run dev`.

Scheduled jobs don't run on this path: nothing calls the tick. Run them by hand
with `npx tsx scripts/run-scheduled-jobs.ts`.

A development database other instances share needs care: turning an app on in
it turns it on for every instance on that database. So a checkout offers
**Activate in this checkout** only when its database is on this machine.

## Working in it

Everything you build lives in one of three folders. The folder's name is its
name in MixOS, so `apps/my-app` opens at
[localhost:3000/apps/my-app](http://localhost:3000/apps/my-app).

```text
mixos/
  apps/my-app/         an app
  connectors/my-crm/   a connector
  themes/my-brand/     a theme
  src/                 MixOS itself
```

Folders whose names start with `_`, like `apps/_template`, are templates and are
skipped. Leave `src/generated/` alone: MixOS writes it from what's on disk, every
time it starts and on every build.

Save a file and the browser updates, usually in under a second. Two kinds of
change need one more command, and restarting MixOS runs both:

- **Added an app, connector or theme, or changed its manifest?** Run
  `npm run registry`.
- **Added a database migration to an app?** Run `npm run migrate:apps`.

The first time you open a page it takes a moment to compile; after that, edits
are fast. The guides for each kind of extension start from
[Extending MixOS](../../README.md#extending-mixos), and `/mixos app`,
`/mixos connector` and `/mixos theme` build one with you; `/mixos help` helps you
decide what to build. To ship your work to your deployment, `/mixos deploy`
opens the pull request. To share an extension with everyone, publish it to the
Registry: see [Publishing to the Registry](https://mixos.org/docs/extending/publishing).

## Installing from the Registry

In a development copy, Admin > Apps, Connectors and Themes can browse the
catalogue at [mixos.org](https://mixos.org) and install from it.

1. **Install it** from Browse. An app or a connector waits in
   `.mixos/pending/`, where none of its code runs. A theme has no code, so it's
   registered as it installs.
2. **Register it**: **Review and register** on Admin > Apps or Admin >
   Connectors, which first shows what will run, or from a terminal:

   ```bash
   npm run register                        # what's waiting
   npm run register -- app/<slug>          # move it into apps/ and run its code
   npm run register -- app/<slug> --smoke  # and migrate, activate and smoke-test it here
   npm run register -- app/<slug> --discard
   npm run register -- --recover           # after one that stopped midway
   ```

   Registering checks the folder is still what was verified, moves it into
   `apps/` or `connectors/`, and runs the registry generator, which is the first
   time its code runs.
3. **Try it.** A new app arrives switched off. After Register, the checkout
   offers **Activate in this checkout** when its database is on this machine:
   loopback, a Unix socket or `host.docker.internal`, as with the dev container.
4. **Ship it.** Every install writes a record into the extension's folder,
   `.registry.json`: where it came from, the release, and the hashes that were
   verified. Commit the folder, record included, and open a pull request.
   Register hands back the files, a commit message that records where the
   extension came from, and the commands; `/mixos deploy` does the same.
   Merging into the branch your host deploys ships it: see
   [After you install](after-you-install/README.md#installing-from-the-registry-on-a-deployment).

**`--smoke`** follows the same rule as Activate. After Register, it runs the
app's migrations, activates it, grants it to the user you sign in as
(`SMOKE_EMAIL` and `SMOKE_PASSWORD`, or `SMOKE_COOKIE`), and runs the app's
smoke test against your running MixOS, or the one `--base-url` names. It reports
and never rolls back. On a database that isn't on your machine it refuses,
before registering anything, unless you pass `--database-is-disposable`.

**Don't edit an installed folder.** The registry generator compares it with its
record, and Browse then says "modified locally"; a pull request with an
installed folder that no longer matches its record fails the
[pull-request check](after-you-install/README.md#the-pull-request-check). Check
that `git status` lists every file: a rule in your `.gitignore` can leave one
out, and `npm run register` warns when one does. On Windows, work in WSL, or set
`git config core.autocrlf false` in the repository: converting line endings
changes the files, so every installed folder would count as modified.

An extension copied in by hand, with no `.registry.json`, counts as local. To
give it a record, remove it and install it again from the Registry; the release
step then counts it as a different extension, once: see
[When a different extension takes a name](after-you-install/README.md#when-a-different-extension-takes-a-name).
[Installing from the repository](../security-architecture.md#31-installing-from-the-repository)
has the security model behind all of this.

Updating and removing an installed extension work in a checkout too: see
[Updating an extension](after-you-install/README.md#updating-an-extension) and
[Removing an extension](after-you-install/README.md#removing-an-extension).

To try a local copy of the catalogue, `MIXOS_REPOSITORY_URL` points a checkout
at another one: see [`.env.local.example`](../../.env.local.example). A built
deployment ignores it unless it names the deployment's own machine.

## Running the tests

These are the checks CI runs on every pull request, and `/mixos deploy` runs
before it commits:

```bash
npm run registry            # checks every manifest and rebuilds the registry
npm run lint                # the platform's rules, as lint errors
npm run typecheck
npm test                    # the unit tests
npm run build               # the production build, which also checks every manifest
npm audit --omit=dev --audit-level=high
npm audit --audit-level=critical
npm run verify:connectors   # after changing a connector's manifest
```

When a check fails, read the reason before working around it. Most of what the
platform enforces is a lint rule or a check in the registry generator, and the
message names the rule and why it exists.

**The database tests.** `npm test` also runs suites that need a real Postgres.
They're skipped unless `MIXOS_TEST_DATABASE_URL` names a server they may create
and drop databases on. Each suite works in a database of its own and drops it
when it finishes. To run them, start a throwaway Postgres, then remove it:

```bash
docker run -d --name mixos-test-db -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres npm test
docker rm -f -v mixos-test-db
```

Each suite's header shows how to run it on its own. In CI,
[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs them against a
Postgres that lives as long as the job.

**An app's smoke test.** With MixOS running and the app activated and granted to
you, `npx tsx scripts/smoke-test-app.ts <slug>` calls each of the app's routes as
you would, signed in with `SMOKE_EMAIL` and `SMOKE_PASSWORD`, or `SMOKE_COOKIE`.
A pull request that changes an app runs it in CI too.

## Common problems

[Local development in Docker](../local-docker.md#troubleshooting) has more, with
the causes.

### It looks stuck the first time

The first start downloads several GB and can take 5 to 15 minutes, often with no
visible progress. Leave it running. `docker images` in another terminal shows
the downloads arriving.

### Cannot connect to the Docker daemon

Docker isn't running. On a Mac, start it with `open -ga Docker` and wait until
`docker info` exits 0. Check with a bare `docker info`: the templated
`docker info --format '...'` exits 0 even when the daemon is down.

### Port 3000 is already in use

Docker says `address already in use` or `port is already allocated`: something
else holds one of MixOS's ports, usually a dev server left running. Find it,
then stop it:

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN    # macOS
ss -ltnp 'sport = :3000'            # Linux and WSL
```

Ports 54321, 54322 and 54323 need to be free too. Starting another `npm run dev`
isn't a way out: it collides on the same port, and on the Docker path it has no
database to use.

### MixOS won't start, or acts strangely

Reset it and start again. This **deletes your local data**: the admin login is
created again, but saved connector credentials and app data are gone. Nothing in
a deployment is touched.

```bash
npm run docker:reset && npm run dev:docker
```

### Starting in the background doesn't work

You probably ran `npm run dev:docker --detach`. Put `--` in front of the flag:
`npm run dev:docker -- --detach`.

### Preflight fails on supabase/migrations

Two platform migrations share a number, usually after a merge. `npm run
dev:docker` stops before starting anything and names both files and the next
free number: rename yours to it, and change its `platform_schema_version` value
to match.

### The page has no styling

You opened `127.0.0.1:3000`. Use [localhost:3000](http://localhost:3000): Next's
dev server refuses `/_next/*` requests, including hot reload, from addresses it
doesn't recognise.

### Signing in keeps sending you back to the sign-in page

Open MixOS at exactly [localhost:3000](http://localhost:3000). Signing in sends
you to `NEXTAUTH_URL`, which is `http://localhost:3000` here, and the session
cookie belongs to the address you signed in at.

### Changes take a long time to show up

They should appear in under a second. On a Mac, check that Docker Desktop uses
**VirtioFS** file sharing, under **Settings > General**. On Windows, keep your
copy in your Linux home folder, not under `/mnt/c`. If it's still slow, run
[`npm run dev` on your computer](#npm-run-dev-on-your-computer) against the dev
container's database.

### The first visit to a page is slow

That's expected: each page compiles the first time it's opened, then stays fast.

### Every page says "Down for maintenance"

The database is behind the code, usually after pulling new code while MixOS
runs. Run `npm run db:local`, and MixOS serves again within 30 seconds. If only
one app says it's being updated, run `npm run migrate:apps` instead.

### Connection refused, or the wrong database

`.env.docker.local` is out of date, usually after switching instances. Delete it
and start again; it's written fresh every time:

```bash
rm .env.docker.local && npm run dev:docker
```

### TLS or "self-signed certificate" errors on every query

`PGSSLMODE=disable` is missing. `.env.docker` sets it for the dev container; add
it to `.env.local` if you run `npm run dev` against a Postgres on your computer.

### No Postgres connection configured

`DATABASE_URL` isn't set. On the Docker path, `npm run dev:docker` writes it to
`.env.docker.local`; start that first. Otherwise set it in `.env.local`.

### Connection timeouts, or too many clients

You're probably on a hosted project's direct endpoint, on port 5432. Switch
`DATABASE_URL` to its pooled connection string, such as Supabase's transaction
pooler on port 6543.

### public._migrations does not exist

The platform schema hasn't been applied. Run `npm run db:local` (dev container)
or `npm run db:migrate` (any other database) before `npm run migrate:apps`.

### The readiness check returns 503

`/api/health/ready` returns 503 when MixOS can't reach its database. In
`.env.docker.local`, `DATABASE_URL` should say `host.docker.internal`, not
`127.0.0.1`. With a `reason`, the database is reachable but behind:
`schema-behind` wants `npm run db:local`, and `app-migrations-behind` wants
`npm run migrate:apps`.

### App API routes return 404

Only with `npm run docker:prod`: `apps/` didn't make it into the image. Test a
**nested** route, such as `/api/apps/my-app/something`, since an app's index
route works even when the folder is missing. Check with
`docker compose -p mixos exec app ls apps`.

### In-app guide pages return 500

Only with `npm run docker:prod`: `docs/` didn't make it into the image. Check
with `docker compose -p mixos exec app ls docs/apps`.

### Scheduled jobs don't run

On the dev container they do: a `cron` container calls the tick every five
minutes, as a host's scheduler would. Watch it with
`docker compose -p mixos logs -f cron`. With `npm run dev` against a database of
your own, nothing calls it: run `npx tsx scripts/run-scheduled-jobs.ts`.

### Docker is using a lot of disk

`docker system df` shows what's using it, and `docker system prune` frees what
nothing uses. The Supabase images and the build cache run to several GB.
