# Vercel and any Postgres

Vercel builds this repository from source and gives you a preview deployment
per pull request. The database can be any Postgres reachable from Vercel:
Neon (through the Vercel Marketplace), Supabase, RDS, Crunchy Bridge, or your
own server with TLS.

## Set up

1. **Create the database.**
   - **Neon**: add the Neon integration from the Vercel Marketplace to the
     project. It sets `DATABASE_URL` to Neon's pooled connection string,
     which is the right one for serverless functions, and
     `DATABASE_URL_UNPOOLED` to the direct one, which the release step uses.
   - **Supabase**: create a project and copy the **transaction pooler**
     connection string (port 6543) from **Connect**. Supabase is only the
     Postgres here. `SUPABASE_URL` and the service-role key aren't used.
   - **Anything else**: a connection string, and a pooler in front of it if
     the provider offers one. Serverless functions open many short-lived
     connections.
2. **Import your fork into Vercel.** The framework preset is detected, and
   [`vercel.json`](../../vercel.json) sets the build command,
   `npm run vercel-build`.
3. **Set the environment variables** from the
   [environment table](README.md#environment): `DATABASE_URL`, `AUTH_SECRET`,
   `CRON_SECRET`, the six platform keys (fresh, from
   `npm run keys:generate`), and `INITIAL_ADMIN_EMAIL` and
   `INITIAL_ADMIN_PASSWORD` for your admin account. `NEXTAUTH_URL` is optional
   on the production domain, because the app falls back to
   `VERCEL_PROJECT_PRODUCTION_URL`. Set it for a custom domain.
4. **Deploy.** The production build runs the release step once `next build`
   has succeeded. It applies the platform schema and the app migrations, then
   creates the admin account. Preview builds never run it, and the build log
   says which it did and why. It reads `VERCEL_ENV`, so leave Vercel's system
   environment variables exposed, as they are by default.

   It connects with `DATABASE_URL_UNPOOLED` when that names the same role and
   database as `DATABASE_URL`, and with `DATABASE_URL` otherwise. A
   production build without `DATABASE_URL` fails and says so. That's what
   happens to the deploy Vercel starts on import if the database isn't
   connected yet: redeploy once it is.

   You can also run the release step by hand, from your own machine or from
   CI, for example to migrate before the first deploy:

   ```bash
   DATABASE_URL='<the connection string>' \
   INITIAL_ADMIN_EMAIL=you@example.com INITIAL_ADMIN_PASSWORD='<a password>' \
   npm run release
   ```

   Prefer the provider's direct, unpooled connection string here when there is
   one, though a transaction pooler works too. It reads only what the command
   gives it, never your checkout's `.env` files, so a local `.env.local` can't
   change which database it migrates or how it connects.

[`vercel.json`](../../vercel.json) registers the scheduler tick, `/api/cron`
every five minutes. Vercel's Hobby plan allows only daily cron jobs and fails a
deployment whose cron runs more often, so deploying with this file needs Pro. The
tick may run for 300 seconds, which every plan allows with Fluid compute,
Vercel's default. A tick that's cut short anyway is harmless, because each job
is claimed atomically and the next tick picks up where the last one stopped.

## Upgrades

Merge the new release tag into your production branch, as in
[Upgrading](README.md#upgrading). The production build then runs the release
step once `next build` has succeeded, before Vercel moves traffic to the new
deployment:

- A build that doesn't compile leaves the database untouched.
- A release step that fails fails the build, and the previous deployment keeps
  serving. The build log says why.
- Two production builds at once take turns at the release step's lock.

Preview builds never run it. A preview's database is often production's own,
and a branch nobody has merged must not migrate it. So a preview of a branch
that adds a migration runs without it, unless you run the release step against
that preview's own database by hand.

The readiness probe, `/api/health/ready`, answers 503 while the database is
behind the build, in its platform schema or its app migrations, so a monitor or
a deployment check can catch a missed step. A deployment that serves before its
release step has run shows the
[maintenance page](README.md#the-maintenance-page) until the step has run. That
can happen to a preview of a branch that adds a platform migration, or to a
deployment promoted without a rebuild after you restored the database to before
its migrations.

The admin pages show the MixOS version and the commit the deployment was built
from, which Vercel sets as `VERCEL_GIT_COMMIT_SHA`.

### Migrations must work with the deployment that's serving

The release step runs while the previous deployment is still serving, so that
deployment runs against the migrated database until the new one is promoted.
With staged production deployments, that can be a while. Every migration has to
work with the code before it: add in one release, and remove in a later one,
once no serving deployment uses what you remove.

### Rolling back

Instant Rollback points the production domains at an earlier deployment without
rebuilding it. No release step runs, and the database stays as the newer
deployment left it: ahead of the earlier one, not behind, so the maintenance
page doesn't show. The rule above keeps the deployment just before the newest
working against it, but one further back may need something a later release
removed. Migrations only go forward: to take the schema back too, restore the
database from a backup taken before the migration, or with your provider's
point-in-time restore.

After a rollback, Vercel stops promoting new production builds until you undo
it, but those builds still run the release step.

Redeploying a production deployment rebuilds it, and so does **Promote to
Production** on a preview deployment, both with the production environment. So
both run the release step, as a push does. Promoting a staged production
deployment doesn't rebuild: its release step ran when it was built.

## Previews of the GitHub App's branches

`vercel.json` turns off deployments of branches under `mixos/`, which are the
ones the [GitHub App](README.md#proposing-an-extension) proposes extensions
and [MixOS updates](README.md#updating-mixos-through-the-app) on:

```json
"git": { "deploymentEnabled": { "mixos/**": false } }
```

A Preview deployment of one would run a publisher's code with your Preview
environment variables before anyone reviewed it. Other branches keep their
Previews. If your copy of `vercel.json` doesn't have this, add it: an instance
on Vercel refuses to propose without it.

## Moving from an existing Vercel and Supabase deployment

Nothing about the database changes. Deploy this version, whose production build
runs the release step (it reads the same migration ledger as
`npm run db:push`), and then delete `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` from the Vercel project. Nothing reads them any
more.
