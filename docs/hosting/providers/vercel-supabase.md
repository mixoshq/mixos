# Vercel with Supabase

Vercel builds your repository from source and gives every pull request a
preview deployment. Supabase provides the database, and MixOS uses only its
Postgres. Neon, or any Postgres Vercel can reach, works the same way: see
[Another Postgres](#another-postgres).

## What you need

- **Your own repository** on GitHub, with your copy of MixOS: see
  [Step 1 of How to install](../install.md#step-1-get-your-own-copy).
- **Vercel's Pro plan.** [`vercel.json`](../../../vercel.json) schedules the
  tick every five minutes, and on the Hobby plan Vercel allows only daily cron
  jobs: it fails a deployment whose cron runs more often.
- **A Supabase project for this install alone.** Each install needs a Postgres
  server of its own: see [Step 3 of How to install](../install.md#step-3-create-the-database).
- **The keys**, from `npm run keys:generate` in your copy.

## Steps

1. **Create the Supabase project.** From **Connect**, copy the **transaction
   pooler** connection string, on port 6543. Serverless functions open many
   short-lived connections, which is what the pooler is for. Supabase is only the
   Postgres here: `SUPABASE_URL` and the service-role key aren't used.
2. **Import your repository into Vercel.** The framework preset is detected,
   and `vercel.json` sets the build command, `npm run vercel-build`, and the
   tick.
3. **Set the environment variables** for Production, from the
   [environment table](../install.md#step-4-set-the-environment): `DATABASE_URL`
   (the pooler string), `AUTH_SECRET`, `CRON_SECRET`, the six platform keys, and
   `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD` for your admin account.
   `NEXTAUTH_URL` is optional on the production domain, because MixOS falls back
   to `VERCEL_PROJECT_PRODUCTION_URL`. Set it for a custom domain.
4. **Deploy.** Once `next build` has succeeded, the production build runs the
   release step: it applies the platform schema and the app migrations, then
   creates your admin account. The deploy Vercel starts on import fails if
   `DATABASE_URL` isn't set yet: redeploy once it is.
5. **Sign in** at your production address, and check that
   `/api/health/ready` answers `{"status":"ok"}`.

### Another Postgres

- **Neon**: add the Neon integration from the Vercel Marketplace. It sets
  `DATABASE_URL` to Neon's pooled connection string, which is the right one for
  serverless functions, and `DATABASE_URL_UNPOOLED` to the direct one, which the
  release step uses.
- **Anything else**, such as RDS, Crunchy Bridge, or your own server with TLS: a
  connection string, and a pooler in front of it if the provider offers one.

## The release step on Vercel

`vercel.json` makes the build command `npm run vercel-build`, which runs
`npm run build` and then the release step, so it starts only once `next build`
has succeeded. Production builds run it, and preview builds never do; the build
log says which it did, and why. It reads `VERCEL_ENV`, so leave Vercel's system
environment variables exposed, as they are by default.

It connects with `DATABASE_URL_UNPOOLED` when that names the same role and
database as `DATABASE_URL`, and with `DATABASE_URL` otherwise. A production
build without `DATABASE_URL` fails and says so.

If the release step fails, the build fails, and the previous deployment keeps
serving. Two production builds at once take turns at the release step's lock.

You can also run it by hand, from your own machine or from CI, for example to
migrate before the first deploy:

```bash
DATABASE_URL='<the connection string>' \
INITIAL_ADMIN_EMAIL=you@example.com INITIAL_ADMIN_PASSWORD='<a password>' \
npm run release
```

Prefer the provider's direct, unpooled connection string here when there is one,
though a transaction pooler works too. It reads only what the command gives it,
never your checkout's `.env` files, so a local `.env.local` can't change which
database it migrates or how it connects.

## The tick

`vercel.json` registers the tick, `/api/cron` every five minutes, which is why
this needs Pro. A tick may run for 300 seconds, which every plan allows with
Fluid compute, Vercel's default. A tick that's cut short anyway is harmless:
each job is claimed atomically, and the next tick picks up where the last one
stopped.

## Previews of the GitHub App's branches

`vercel.json` turns off deployments of branches under `mixos/`, which are the
ones the [GitHub App](../after-you-install/github-app.md) proposes extensions
and MixOS updates on:

```json
"git": { "deploymentEnabled": { "mixos/**": false } }
```

A preview deployment of one would run a publisher's code with your Preview
environment variables before anyone reviewed it. Other branches keep their
previews. If your copy of `vercel.json` doesn't have this, add it: an instance
on Vercel refuses to propose without it.

## Upgrading on Vercel

Merge the new release tag into your production branch, as in
[Upgrading MixOS](../after-you-install/upgrading.md). The production build then
runs the release step once `next build` has succeeded, before Vercel moves
traffic to the new deployment:

- A build that doesn't compile leaves the database untouched.
- A release step that fails fails the build, and the previous deployment keeps
  serving. The build log says why.
- Two production builds at once take turns at the release step's lock.

Preview builds never run it. A preview's database is often production's own, and
a branch nobody has merged must not migrate it. So a preview of a branch that
adds a migration runs without it, unless you run the release step against that
preview's own database by hand.

The readiness check, `/api/health/ready`, answers 503 while the database is
behind the build, in its platform schema or its app migrations, so a monitor or
a deployment check can catch a missed step. A deployment that serves before its
release step has run shows the
[maintenance page](../install.md#the-maintenance-page) until the step has run.
That can happen to a preview of a branch that adds a platform migration, or to a
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

## Common problems

- **The build fails with "Release step: failing the build".** `DATABASE_URL`
  isn't set for the Production environment. Set it in the Vercel project, then
  redeploy. The previous deployment keeps serving.
- **Vercel won't deploy because of the cron schedule.** The project is on the
  Hobby plan, which allows only daily cron jobs. MixOS's tick runs every five
  minutes, so it needs Pro.
- **Connection timeouts, or "too many clients".** `DATABASE_URL` is a direct
  connection string, on port 5432. Use Supabase's transaction pooler, on port
  6543.
- **The build log says `DATABASE_URL_UNPOOLED` is not used.** It doesn't name
  the same role and database as `DATABASE_URL`, so the release step connects
  with `DATABASE_URL`, as the app does. Remove a `DATABASE_URL_UNPOOLED` left
  over from another database.
- **A preview says "Down for maintenance".** Its branch adds a platform
  migration, and previews never run the release step. Run it by hand against
  that preview's own database.
- **Signing in sends you back to the sign-in page on a custom domain.** Set
  `NEXTAUTH_URL` to that domain, exactly.
- **Admin > GitHub refuses to propose.** Your `vercel.json` doesn't turn off
  deployments of `mixos/**`. Add the setting above.
