# Before you install

Installing MixOS puts your own copy of it online, for your team. This page lists
what you need and the choices to make first. The install itself is in
[How to install](install.md).

The install guide has five parts:

1. **Before you install**: this page.
2. **[How to install](install.md)**: a quick install, then each step in detail.
3. **[Running a development copy](development.md)**: MixOS on your own computer,
   for building extensions and trying things before they ship.
4. **[Install at popular providers](providers/README.md)**: the steps for Vercel
   with Supabase, Render, Railway, and a server of your own.
5. **[After you install](after-you-install/README.md)**: the first admin,
   security, backups, upgrades and extensions.

## What you need

- **Your own copy of MixOS on GitHub.** Fork
  [`mixoshq/mixos`](https://github.com/mixoshq/mixos) and deploy your fork. A
  deployment runs the apps, connectors and themes in the repository it's built
  from, so the ones you add have to be in yours.
- **A Postgres database, version 13 or later.** From any provider: a container,
  Render, Railway, Supabase, Neon, RDS or Cloud SQL. MixOS connects with one
  `DATABASE_URL` and uses nothing but Postgres itself: no PostgREST, no Supabase
  API and no service-role key. See [Which database](#which-database).
- **Node.js 22 or later**, wherever you run MixOS's commands, such as
  `npm run keys:generate`, and wherever it's built from source. The repository
  pins 24 in `.nvmrc`, and the Docker image brings its own Node 24.
- **A host, or a server of your own.** It runs the MixOS server and puts HTTPS
  in front of it, through a proxy or platform that sets `X-Forwarded-For` or
  `X-Real-IP` to the client's address. See [Where to host](#where-to-host).
- **A scheduler.** Something outside MixOS calls `GET /api/cron` with
  `Authorization: Bearer $CRON_SECRET` every five minutes. That call, the tick,
  runs scheduled jobs and the daily checks with mixos.org. Every host page sets
  one up.
- **A domain**, when you want your own address. Render, Railway and Vercel give
  MixOS an address of theirs. On a server of your own, point a domain at it, so
  it can have a certificate.
- **The keys.** `npm run keys:generate` prints a fresh value for `AUTH_SECRET`,
  `CRON_SECRET` and the six platform keys. Render's Blueprint and
  `deploy/new-env.sh` generate their own. Three of the keys encrypt data at
  rest, so keep a copy: without them, that data is gone.

## Choices to make first

### Where to host

| Path | What you get | What it takes | Guide |
| --- | --- | --- | --- |
| **Vercel with Supabase** | A preview of every pull request, with Supabase, Neon or any Postgres as the database | Vercel Pro, for the five-minute tick | [Vercel with Supabase](providers/vercel-supabase.md) |
| **Render** | A Blueprint: the app, Render Postgres and the tick, with every key generated | A few clicks, on paid instances | [Render](providers/render.md) |
| **Railway** | The app, Railway Postgres and the tick, publishable as a one-click template | A few minutes once, one click after | [Railway](providers/railway.md) |
| **Your own server** | Postgres, the app, HTTPS and the tick on one machine, from one Compose file | A Linux server with 2 GB of memory or more | [Self-hosted](providers/self-hosted.md) |
| **Coolify or Dokploy** | The same Compose file, deployed from git, with a dashboard, HTTPS and rollbacks | A server running either one | [Self-hosted](providers/self-hosted.md#coolify) |

Any other host that runs a Docker image, or a Node build, works too:
[How to install](install.md#on-another-host) has the steps.

### Which database

- **The host's own** is the least work. Docker Compose runs Postgres in a
  container beside MixOS, and Render and Railway add Postgres on their private
  network.
- **A managed Postgres**, such as Supabase or Neon, suits Vercel, or any host.
  Supabase is only the database here: MixOS doesn't use its API.
- **One Postgres server for each install.** Each app with tables gets a database
  role of its own, and roles belong to the whole server, not to one database. So
  two MixOS installs on one server would share them, and the release step
  refuses that. A staging install needs a server of its own too.
- **The role MixOS connects as must be able to create roles** (`CREATEROLE`).
  The default role on Supabase, Neon, RDS, Render and Railway can, and so can the
  superuser in a container.
- **Serverless hosts need a pooler.** Vercel's functions open many short-lived
  connections, so use the provider's pooled connection string. A long-running
  server can connect directly.

[Step 3 of How to install](install.md#step-3-create-the-database) has the
details.

### How extensions get in

Apps, connectors and themes are **installed in a checkout** of your repository
and **shipped by deploying** it. A deployment runs what its build carries: its
Browse pages show the catalogue at mixos.org, but can't install from it.

So you install an extension from Browse in a
[development copy](development.md), commit its folder, and merge it into the
branch your host deploys. With the [GitHub App](after-you-install/github-app.md)
linked, a deployment can open that pull request for you instead. Either way, a
new app arrives switched off on each instance until an admin activates it. See
[Installing from the Registry on a deployment](after-you-install/README.md#installing-from-the-registry-on-a-deployment).

### Whether to keep a development copy

Most people keep a [development copy](development.md) on their own computer as
well. It's where you install and try extensions, and try an upgrade, before they
reach your deployment. Its keys are public, so it never goes online.

## How MixOS behaves

- **Every page is rendered on request.** The security policy's nonce only exists
  once a request does, so there's no static tier to cache in front of MixOS.
- **Rate limiting lives in Postgres**, so it works across several servers, at
  the cost of some database traffic. When the database can't answer, each
  server falls back to its own count in memory and logs a warning, so a
  database problem doesn't take MixOS down with it.
- **App API routes take request bodies up to 27 MB**, whole. A larger one gets a
  413, whether or not it says its size up front.

## What MixOS doesn't provide yet

| Gap | What it means for you |
| --- | --- |
| **No published image** | Every path builds from your fork, and an upgrade is a rebuild |
| **No Kubernetes chart** | Docker Compose covers one server. Beyond that, you write the orchestration |
| **No automatic rollback** | Migrations only go forward, and nothing rolls a deploy back for you. A backup is the way back: see [Upgrading MixOS](after-you-install/upgrading.md) |
| **No key rotation tool** | Each key can be changed on its own, but changing one of the three data keys means re-entering what it encrypted. Only the GitHub App's key has a command that re-encrypts |
| **Untested at scale** | Nothing here is a capacity figure. MixOS has no published load characteristics |

If you host MixOS, you're operating it yourself, in a real sense. Its
[security model](../security-architecture.md) is published in full, so that's a
decision you can make with the facts. Before anyone else can reach your install,
read [Securing your install](after-you-install/securing.md).
