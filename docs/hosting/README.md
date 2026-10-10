# Hosting MixOS

A MixOS deployment is three things:

1. **The server.** The image this repository's [`Dockerfile`](../../Dockerfile)
   builds, or `npm ci && npm run build` on any Node 22+ host.
2. **A Postgres database, version 13 or later, from any provider.** A
   container, Render, Railway, Neon, Supabase, RDS, Cloud SQL: MixOS connects
   with one `DATABASE_URL` and uses nothing but Postgres itself. There is no
   PostgREST, no Supabase API and no service-role key involved.
3. **A tick.** `GET /api/cron` with `Authorization: Bearer $CRON_SECRET` every
   five minutes, which drives scheduled jobs. Vercel Cron, a cron job on the
   host platform, or a `curl` loop all work.

Each deploy also runs **the release step** before new code takes traffic. It
applies the database migrations and creates the first admin. Inside the image
that is `node ops/release.cjs`; on Vercel, the production build runs it after
`next build`; from a checkout,
`DATABASE_URL='<connection string>' npm run release`. It reads its settings
only from the environment it runs in, never from a checkout's `.env` files, so
it stops if nothing there names a database.

## Pick a path

| Path | What you get | Effort | Guide |
| --- | --- | --- | --- |
| **Docker Compose on a server** | Postgres, the app, HTTPS and the tick on one machine you control | A VPS, one command | [docker-compose.md](docker-compose.md) |
| **Coolify or Dokploy** | The same Compose file, deployed from git, with a UI, TLS and rollbacks | Your own server running either one | [docker-compose.md](docker-compose.md#coolify) |
| **Render** | A Blueprint: the app, Render Postgres and the tick, with every secret generated | A few clicks; paid instances | [render.md](render.md) |
| **Railway** | The app, Railway Postgres and the tick, publishable as a one-click template | A few minutes once; one click after | [railway.md](railway.md) |
| **Vercel and any Postgres** | A preview deployment per pull request; the database from Neon, Supabase or anywhere | Vercel Pro for the 5-minute tick | [vercel.md](vercel.md) |

The apps, connectors and themes a deployment runs are the ones in the
repository it is built from. Deploy **your fork**, not this repository, so the
apps you add are in the build.

## What every path needs

### Environment

| Variable | Required | What it is |
| --- | --- | --- |
| `DATABASE_URL` | Yes | The Postgres connection string. `POSTGRES_URL` and discrete `PG*` fields also work; see [`src/lib/db/pg-options.ts`](../../src/lib/db/pg-options.ts). |
| `PGSSLMODE` | When the connection is plaintext | Unset means TLS is required. Set `disable` for a database on the same private network (Compose, Render), and `verify-full` to check the certificate. |
| `NEXTAUTH_URL` | Yes, except on Vercel, Render and Railway's own domains | The public URL people sign in at. OAuth redirect URIs and the MCP resource identifier are built from it. On those three hosts the app falls back to the URL the platform sets ([`src/lib/env/origin.ts`](../../src/lib/env/origin.ts)); set it for a custom domain. |
| `AUTH_SECRET` | Yes | Signs sessions. Rotating it signs everyone out. |
| `CONNECTOR_ENCRYPTION_KEY`, `USER_OAUTH_ENCRYPTION_KEY`, `APP_SETTINGS_ENCRYPTION_KEY`, `MCP_TOKEN_KEY`, `APP_API_KEY_SECRET`, `APP_UNLOCK_SECRET` | Yes | The platform key inventory. Each is 32 random bytes, as 64 hex characters or as base64. [`src/lib/env/keys.ts`](../../src/lib/env/keys.ts) says what each protects and what rotating it costs. The first three encrypt data at rest, so **back them up**: without them, that data is gone. |
| `CRON_SECRET` | Yes | The bearer token the tick sends. Without it `/api/cron` refuses every call, and jobs never run. |
| `INITIAL_ADMIN_EMAIL`, `INITIAL_ADMIN_PASSWORD` | For the first deploy | The release step creates this account if no account has the email. It never changes an existing one, so the variables are safe to leave set. |
| `INSTALL_APPS`, `INSTALL_CONNECTORS`, `INSTALL_THEMES` | No, default `true` | Whether admins can browse the catalogue for that kind and install from it. See [Fixing what an instance runs](#fixing-what-an-instance-runs). |
| `ALLOWED_EMAIL_DOMAINS` | No | Comma-separated domains allowed to sign in. Blank: any. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | No | Web Push, for apps that send notifications. |

`npm run keys:generate` prints a fresh value for every key, and
`npm run keys:check` validates a set. Never reuse a value from
[`.env.docker`](../../.env.docker): that file is committed, so its keys are
public.

Connector credentials are not environment variables. An admin enters them at
`/admin/connectors`, and they are stored encrypted in the database.

### Fixing what an instance runs

By default an admin can browse the catalogue at mixos.org from the Apps,
Connectors and Themes admin pages, and install from it. To make an instance run
only the extensions it was deployed with, set the kind's flag to `false`:

```
INSTALL_APPS=false
INSTALL_CONNECTORS=false
INSTALL_THEMES=false
```

Each one, independently, removes that kind's Browse button and makes its browse
page a 404. The server actions behind the page refuse that kind too, so there is
no way left to install one, not just no link to it. Extensions already on the
instance are unaffected: apps can still be activated, connectors configured and
themes applied. A new one arrives the way code always can, through the
repository and a deploy.

Any value other than `true`, `false` (or `1`/`0`, `yes`/`no`, `on`/`off`) is
treated as `false`, and the release step reports it. A typo locks the instance
down rather than leaving it open. The flags are read per request, so changing
one needs a restart, not a rebuild.

A deployment built from the Docker image (Compose, Render, Railway) or on
Vercel can't install from the catalogue anyway: installing writes source into a
checkout and re-runs the registry generator, and a built artifact has neither.
On those, the flags decide whether the catalogue can be browsed at all. They
lock installs down on an instance that runs from a checkout.
[docs/security-architecture.md](../security-architecture.md#turning-it-off)
has the detail.

### The release step

[`scripts/release.ts`](../../scripts/release.ts) runs three things, in order:

1. **The platform schema**, `supabase/migrations/*.sql`, by
   [`scripts/platform-migrations.ts`](../../scripts/platform-migrations.ts).
   Applied files are recorded in the same ledger the Supabase CLI keeps, so a
   database that `supabase db push` migrated is seen as migrated, and the
   reverse. Any Postgres works; the ledger's name is the CLI's, not a
   dependency on Supabase.
2. **The app registry and app migrations**, as `npm run migrate:apps` does
   locally. Each app with a database gets a schema and a database role of its
   own, created here if they are missing, and its migrations run as that role,
   after every pending statement has been checked against what an app
   migration may do. One refused statement stops the step before any app SQL
   runs; see
   [docs/apps/database.md](../apps/database.md#what-a-migration-may-contain).
   An app the build no longer carries is not deleted; see
   [When an app leaves the build](#when-an-app-leaves-the-build).
3. **The first admin**, from `INITIAL_ADMIN_*`, only if that account does not
   exist yet.

It is safe to run on every deploy, and safe to run twice at once: each
migration takes a transaction-scoped lock and re-checks the ledger first. The
readiness probe, `/api/health/ready`, returns 503 until the database has the
platform schema the build expects and every app migration the build carries,
so point the platform's health check there. On a host that waits for it, a
deploy that skips the release step, or whose release step failed, does not
serve errors. On Vercel the release step is part of the production build, so a
failed one fails the build and the previous deployment keeps serving.

### When an app leaves the build

The release step never deletes an app. When the build doesn't carry an app the
database knows, because its folder was removed or renamed or the build skipped
it, the step marks it missing and keeps everything it had: whether it was
active, its grants, installs, widgets and password, its settings and API keys,
its scheduled jobs and its tables. Nobody can open it while it is missing, and
Admin > Apps lists it under **Not in this build**. A renamed folder is a new
app: it arrives inactive with none of the old one's data.

When the app comes back, the step compares a hash of its files with the one it
recorded:

- **The same files**, after a rollback or once the build stops skipping it: the
  app comes back as it left, active or not.
- **Different files**: the app comes back switched off and marked **Back with
  different code** on Admin > Apps until an admin activates it. Its grants and
  data are still there, so check what changed first.

The audit log records both, as `app.missing` and `app.returned`, with
`release-step` as the actor.

### The database role

Every table has row-level security enabled with no policies, so only the role
that owns a table can use it. **Run the release step as the same role the app
connects as**, which it does whenever both use the same `DATABASE_URL`. A
setup where an admin role migrates and a restricted role serves will find
every table empty to the app.

That role also needs to be able to create roles (`CREATEROLE`). Each app with a
database gets one, `mixos_app_<slug>`, which cannot log in and owns only that
app's schema; the release step creates it and makes itself a member, which is
how the app reaches its tables. The default role on Supabase, Neon, RDS,
Render and Railway has it, and so does the superuser in a container.

**One MixOS database per Postgres server.** Roles belong to the whole server,
not to one database, so two MixOS databases on the same server would share each
app's role. The release step refuses an app role that another database on the
server already uses. Give each MixOS install a Postgres server of its own, not
just a database of its own.

On Supabase that lock is doing real work. Every Supabase project serves its
own public API over the `public` schema, whether or not MixOS uses it, and RLS
is what keeps that API closed. See
[docs/security-architecture.md](../security-architecture.md).

### Connection pooling

A long-lived server (Compose, Render, Railway) holds a small pool and can use a
direct connection. Serverless functions (Vercel) open many short-lived
connections and should use the provider's **pooler**: Supabase's transaction
pooler on port 6543, or the pooled `DATABASE_URL` that Neon's Vercel
integration sets. Transaction-mode poolers are fine. MixOS uses no prepared
statements or session state, and the migration runner's lock is
transaction-scoped. On Vercel, the production build's release step uses Neon's
direct `DATABASE_URL_UNPOOLED` instead, when it names the same role and
database as `DATABASE_URL`.

## Before going public

Read [docs/security-architecture.md](../security-architecture.md): the trust
boundaries, the key inventory and the row-level security coverage. Then read
[docs/secure-edge-gateway-architecture.md](../secure-edge-gateway-architecture.md)
for the request path in front of it.
