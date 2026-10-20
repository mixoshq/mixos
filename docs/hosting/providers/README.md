# Install at popular providers

Each page here is the whole install on one host: what you need, the steps, how
the release step runs there, keeping previews of the GitHub App's branches off,
upgrading, and the common problems. [Before you install](../README.md#where-to-host)
compares them.

- **[Vercel with Supabase](vercel-supabase.md)**: Vercel builds your
  repository, with a preview of every pull request, and Supabase, Neon or any
  Postgres is the database.
- **[Render](render.md)**: a Blueprint creates the app, Render Postgres and the
  tick, and generates every key.
- **[Railway](railway.md)**: the app, Railway Postgres and the tick, set up once,
  then reusable as a one-click template.
- **[Self-hosted](self-hosted.md)**: Docker Compose runs Postgres, the app, HTTPS
  and the tick on a server of your own, and Coolify or Dokploy can deploy the
  same file from git.

Whichever you pick, deploy your own repository, not `mixoshq/mixos`, so the
extensions you add are in the build.

## What each host provides

Every deployment is the same four pieces. Each host supplies them its own way:

| MixOS needs | Your own server (Compose, Coolify, Dokploy) | Render or Railway | Vercel |
| --- | --- | --- | --- |
| **HTTPS in front** | Caddy, from the HTTPS file, or Coolify, Dokploy or your own proxy | Built in, on their domain or yours | Built in, on your domain |
| **A Postgres database**, version 13 or later | Postgres in a container, private to the stack | Render or Railway Postgres, on the private network | Supabase, Neon or any Postgres, through a pooler |
| **The tick**, every five minutes | A cron container running `curl` | A cron job or service beside the app | Vercel Cron, which needs Pro at this frequency |
| **The release step**: schema, app migrations, first admin | The `migrate` service, once per `up`, before the app | The pre-deploy command, in the new image, before it goes live | The production build, after `next build`, before it goes live |

On all of them, MixOS reaches its database with one `DATABASE_URL`: no Supabase
API and no service-role key.

## Somewhere else

Any host that runs a Docker image, or Node 22 or later, can run MixOS.
[How to install](../install.md#on-another-host) has the steps.
