# Requirements

What MixOS needs to run: online, where your team signs in, and on your
computer, where you install it and build on it.
[How to install](install.md) has the steps.

## Online

A deployment, the copy of MixOS your team signs in to, needs a host, a Postgres
database, a scheduler and your own repository, along with the keys and settings
from [Step 2](install.md#step-2-generate-the-keys) and
[Step 4](install.md#step-4-set-the-environment) of How to install.
[What each host provides](providers/README.md#what-each-host-provides) shows how
the popular hosts supply them.

### A host

Any host that runs a Docker image, which brings its own Node 24, or Node.js 22
or later. [Where to host](providers/README.md#where-to-host) compares the
popular ones.

It must put HTTPS in front of MixOS, and be the only way in: through its
platform, or a proxy of your own that passes the client's address in
`X-Forwarded-For` or `X-Real-IP`. Every per-IP rate limit counts by that
address.
[If you run your own proxy](after-you-install/securing.md#if-you-run-your-own-proxy)
lists the rest of what a proxy must do.

Render, Railway and Vercel give MixOS an address of theirs. A server of your own
needs a domain pointed at it, so it can have a certificate.
[Put it online](install.md#put-it-online) says how to use a domain of your own.

### A Postgres database

Postgres 13 or later, from any provider: a container, Render, Railway,
Supabase, Neon, RDS or Cloud SQL. MixOS connects with one `DATABASE_URL` and
uses nothing but Postgres itself: no PostgREST, no Supabase API and no
service-role key. A few things decide whether it works well:

- **Its own Postgres server.** Each app with tables gets a database role of its
  own, `mixos_app_<slug>`, and roles belong to the whole server. So two MixOS
  databases on one server would share each app's role, and the release step
  refuses an app role that another database on the server already uses. Give
  each install a server of its own, not just a database of its own: a staging
  install too.
- **A role that can create roles** (`CREATEROLE`). The release step creates each
  app's role and makes itself a member, which is how the app reaches its
  tables. The default role on Supabase, Neon, RDS, Render and Railway can, and so
  can the superuser in a container.
- **One role for everything.** Every table has row-level security on, with no
  policies, so only the role that owns a table can use it. Run the release step
  as the role the app connects as, which it does whenever both use the same
  `DATABASE_URL`. A setup where an admin role migrates and a restricted role
  serves finds every table empty.
- **A pooler on serverless hosts.** A long-running server holds a small pool of
  connections and can connect directly. Serverless functions, such as Vercel's,
  open many short-lived ones, so use the provider's pooled connection string:
  Supabase's transaction pooler, on port 6543, or the pooled `DATABASE_URL` that
  Neon's Vercel integration sets. Transaction-mode poolers are fine: MixOS uses
  no prepared statements or session state, and the release step's lock is
  transaction-scoped.
- **TLS.** MixOS requires TLS to the database unless `PGSSLMODE` says
  otherwise. Set `PGSSLMODE=disable` for a database on the same private
  network, as on Docker Compose and Render, or `verify-full` to check the
  database's certificate.

On Supabase, row-level security does real work: every Supabase project serves
its own API over the `public` schema, whether or not MixOS uses it, and the
locked tables are what keep it closed. See the
[security architecture](../security-architecture.md).

### A scheduler

Something outside MixOS calls `GET /api/cron` every five minutes, with
`Authorization: Bearer $CRON_SECRET`. That call, the tick, runs scheduled jobs
and the [daily check for updates](after-you-install/README.md#release-and-update-notices).
A tick may run for up to 300 seconds, and one that's cut short is harmless:
each job is claimed atomically, and the next tick picks up where the last
stopped.

### Your own repository

Your host builds from a private repository of your own on GitHub, holding your
copy of MixOS, not from `mixoshq/mixos`. A deployment runs the apps, connectors
and themes in the repository it's built from, so the ones you add have to be in
yours. `/mixos init` creates it, or see
[Step 1 of How to install](install.md#step-1-get-your-own-copy).

### How MixOS runs

- **Every page is rendered on request.** The security policy's nonce only exists
  once a request does, so there's no static tier to cache in front of MixOS.
- **Rate limiting lives in Postgres**, so it works across several servers, at
  the cost of some database traffic. When the database can't answer, each
  server falls back to its own count in memory and logs a warning, so a
  database problem doesn't take MixOS down with it.
- **App API routes take request bodies up to 27 MB**, whole. A larger one gets a
  413, whether or not it says its size up front.

### What MixOS doesn't provide yet

| Gap | What it means for you |
| --- | --- |
| **No published image** | Every path builds from your repository, and an upgrade is a rebuild |
| **No Kubernetes chart** | Docker Compose covers one server. Beyond that, you write the orchestration |
| **No automatic rollback** | Migrations only go forward, and nothing rolls a deploy back for you. A backup is the way back: see [Upgrading MixOS](after-you-install/upgrading.md) |
| **No key rotation tool** | Each key can be changed on its own, but changing one of the three data keys means re-entering what it encrypted. Only the GitHub App's key has a command that re-encrypts |
| **Untested at scale** | Nothing here is a capacity figure. MixOS has no published load characteristics |

If you host MixOS, you're operating it yourself, in a real sense. Its
[security model](../security-architecture.md) is published in full, so that's a
decision you can make with the facts. Before anyone else can reach your install,
read [Securing your install](after-you-install/securing.md).

## On your computer

[What you need](install.md#what-you-need), in How to install, lists where to
run Claude Code, the Claude app or VS Code, and the accounts to get first.
Claude Code runs the guided `/mixos` commands, and MixOS itself doesn't need it.

Your computer also needs these, to run MixOS or its commands, such as
`npm run keys:generate`. `/mixos init` checks for them, and installs what's
missing:

| What | Version | Notes |
| --- | --- | --- |
| Operating system | macOS, Linux, or Windows with WSL 2 | On Windows, MixOS runs inside WSL. Git Bash and PowerShell can't run it |
| [Node.js](https://nodejs.org) | **24**, pinned in `.nvmrc`, so `nvm use` selects it. 22 is the minimum | Node 22 reaches end of life on 30 April 2027. Every shell that runs MixOS's commands needs it, not only your terminal |
| npm | Comes with Node | The lockfile is npm's: install with `npm ci`, not pnpm or yarn |
| Git | Any recent version | |
| Docker | Docker Desktop on macOS and Windows, or Docker Engine with the Compose v2 plugin on Linux | Runs the dev container. Give it about 4 GiB of memory, and keep several GB of disk free. Without Docker, use [a database of your own](development.md#with-a-database-of-your-own) |
| Free ports | 3000, 54321, 54322, 54323 | MixOS, and the dev container's Supabase API, Postgres and Supabase Studio |
| [GitHub CLI](https://cli.github.com) | Optional | Lets `/mixos init` create your own repository on GitHub, and `/mixos deploy` open pull requests there. Without it, `/mixos deploy` gives you a link to paste |

To install them yourself, see
[What you need](development.md#what-you-need) in Running a development copy.
