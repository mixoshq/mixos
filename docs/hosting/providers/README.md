# Install at popular providers

Each page here is the whole install on one host: what you need, the steps, how
the release step runs there, keeping previews of the GitHub App's branches off,
upgrading, and the common problems. [Where to host](#where-to-host) compares
them.

## Where to host

| Path | What you get | What it takes | Guide |
| --- | --- | --- | --- |
| **Vercel with Supabase** | A preview of every pull request, with Supabase, Neon or any Postgres as the database | Vercel Pro, for the five-minute tick | [Vercel with Supabase](vercel-supabase.md) |
| **Render** | A Blueprint: the app, Render Postgres and the tick, with every key generated | A few clicks, on paid instances | [Render](render.md) |
| **Railway** | The app, Railway Postgres and the tick, publishable as a one-click template | A few minutes once, one click after | [Railway](railway.md) |
| **Your own server** | Postgres, the app, HTTPS and the tick on one machine, from one Compose file | A Linux server with 2 GB of memory or more | [Self-hosted](self-hosted.md) |
| **Coolify or Dokploy** | The same Compose file, deployed from git, with a dashboard, HTTPS and rollbacks | A server running either one | [Self-hosted](self-hosted.md#coolify) |

Any other host that meets [the requirements](../requirements.md#a-host) works
too: [How to install](../install.md#on-another-host) has the steps.

## Which database

- **The host's own** is the least work. Docker Compose runs Postgres in a
  container beside MixOS, and Render and Railway add Postgres on their private
  network.
- **A managed Postgres**, such as Supabase or Neon, suits Vercel, or any host.
  Supabase is only the database here: MixOS doesn't use its API.

Whichever you choose, it must meet
[the requirements](../requirements.md#a-postgres-database).

## What each host provides

Every deployment is the same four pieces. Each host supplies them its own way:

| MixOS needs | Your own server (Compose, Coolify, Dokploy) | Render or Railway | Vercel |
| --- | --- | --- | --- |
| **HTTPS in front** | Caddy, from the HTTPS file, or Coolify, Dokploy or your own proxy | Built in, on their domain or yours | Built in, on your domain |
| **A Postgres database**, version 13 or later | Postgres in a container, private to the stack | Render or Railway Postgres, on the private network | Supabase, Neon or any Postgres, through a pooler |
| **The tick**, every five minutes | A cron container running `curl` | A cron job or service beside the app | Vercel Cron, which needs Pro at this frequency |
| **The release step**: schema, app migrations, first admin | The `migrate` service, once per `up`, before the app | The pre-deploy command, in the new image, before it goes live | The production build, after `next build`, before it goes live |

## How extensions get in

Apps, connectors and themes are **installed in a checkout** of your repository
and **shipped by deploying** it. A deployment runs what its build carries: its
Browse pages show the catalogue at mixos.org, but can't install from it.

So you install an extension from Browse in a
[development copy](../development.md), commit its folder, and merge it into the
branch your host deploys. With the
[GitHub App](../after-you-install/production-updates.md) linked, a deployment can open
that pull request for you instead. Either way, a new app arrives switched off on
each instance until an admin activates it. See
[Installing from the Registry on a deployment](../after-you-install/README.md#installing-from-the-registry-on-a-deployment).

## Whether to keep a development copy

Most people keep a [development copy](../development.md) on their own computer
as well. It's where you install and try extensions, and try an upgrade, before
they reach your deployment. Its keys are public, so it never goes online.
