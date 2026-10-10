# Vercel and any Postgres

Vercel builds this repository from source and gives you a preview deployment
per pull request. The database can be any Postgres reachable from Vercel:
Neon (through the Vercel Marketplace), Supabase, RDS, Crunchy Bridge, or your
own server with TLS.

## Set up

1. **Create the database.**
   - **Neon**: add the Neon integration from the Vercel Marketplace to the
     project. It sets `DATABASE_URL` to Neon's pooled connection string,
     which is the right one for serverless functions.
   - **Supabase**: create a project and copy the **transaction pooler**
     connection string (port 6543) from **Connect**. Supabase is only the
     Postgres here. `SUPABASE_URL` and the service-role key aren't used.
   - **Anything else**: a connection string, and a pooler in front of it if
     the provider offers one. Serverless functions open many short-lived
     connections.
2. **Import your fork into Vercel.** The framework preset and build command
   are detected.
3. **Set the environment variables** from the table in
   [README.md](README.md#environment): `DATABASE_URL`, `AUTH_SECRET`,
   `CRON_SECRET` and the six platform keys (fresh, from
   `npm run keys:generate`). `NEXTAUTH_URL` is optional on the production
   domain, because the app falls back to `VERCEL_PROJECT_PRODUCTION_URL`. Set it
   for a custom domain.
4. **Run the release step against the production database**, from your own
   machine or from CI:

   ```bash
   DATABASE_URL='<the connection string>' \
   INITIAL_ADMIN_EMAIL=you@example.com INITIAL_ADMIN_PASSWORD='<a password>' \
   npm run release
   ```

   It applies the platform schema and the app migrations, then creates the
   admin account. Prefer the provider's direct, unpooled connection string
   here when there is one (Neon sets `DATABASE_URL_UNPOOLED`), though a
   transaction pooler works too. It reads only what the command gives it,
   never your checkout's `.env` files, so a local `.env.local` can't change
   which database it migrates or how it connects.
5. **Deploy.**

[`vercel.json`](../../vercel.json) registers the scheduler tick, `/api/cron`
every five minutes. Vercel's Hobby plan only allows daily cron schedules, so the
5-minute tick needs Pro. Hobby also caps function duration at 60 seconds, which
cuts a long tick short. That's harmless, because each job is claimed atomically
and the next tick picks up where the last one stopped.

## Upgrades

When a change brings a migration, run the release step against production
before promoting the deployment, as in step 4
(`DATABASE_URL='<the connection string>' npm run release`), and run it again if
you skip a version. The readiness probe, `/api/health/ready`, answers 503 while
the database is behind the build, in its platform schema or its app migrations,
so a monitor or a deployment check can catch a missed step. A deployment
promoted before a platform migration has run shows the
[maintenance page](README.md#the-maintenance-page) until the step has run.

Vercel's build doesn't run migrations by itself, and shouldn't. Preview
deployments share the build, and a migration that ran on every preview build
would run against whatever database that preview points at.

## Moving from an existing Vercel and Supabase deployment

Nothing about the database changes. Deploy this version, run the release step
as in step 4 (or `npm run db:push` as before; both read the same migration
ledger), and then delete `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from
the Vercel project. Nothing reads them any more.
