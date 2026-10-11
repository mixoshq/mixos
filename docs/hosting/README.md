# Hosting MixOS

A MixOS deployment is three things:

1. **The server.** The image this repository's [`Dockerfile`](../../Dockerfile)
   builds, or `npm ci && npm run build` on any Node 22+ host. Serve it behind
   a proxy or platform that sets `X-Forwarded-For` or `X-Real-IP` to the
   client's address.
2. **A Postgres database, version 13 or later, from any provider.** A
   container, Render, Railway, Neon, Supabase, RDS, Cloud SQL: MixOS connects
   with one `DATABASE_URL` and uses nothing but Postgres itself. There is no
   PostgREST, no Supabase API and no service-role key involved.
3. **A tick.** `GET /api/cron` with `Authorization: Bearer $CRON_SECRET` every
   five minutes, which drives scheduled jobs and the daily
   [update check](#what-mixos-sends-to-mixosorg). Vercel Cron, a cron job on
   the host platform, or a `curl` loop all work.

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

A new app arrives **inactive** on each instance. The release step adds it
switched off, and none of its code runs until an admin activates it on that
instance's **Admin > Apps**. The switch is kept in the database, so an instance
with a database of its own, staging as well as production, activates each app
on its own.

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
| `MIXOS_UPDATE_CHECK` | No, default `true` | Whether the instance asks mixos.org once a day about the extensions it installed from there, so admins see a release its publisher withdrew. `false` sends nothing. See [What MixOS sends to mixos.org](#what-mixos-sends-to-mixosorg). |
| `MIXOS_COMMIT` | No | The commit the admin pages show beside the MixOS version. For the Docker image it's a build argument. See [Which build is running](#which-build-is-running). |
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
Vercel doesn't install from the catalogue in any case: installing writes source
into a checkout and runs the registry generator, and a built artifact has
neither (see
[Installing from the Registry on a deployment](#installing-from-the-registry-on-a-deployment)).
On those, the flags decide whether the catalogue can be browsed at all. They
lock installs down on an instance that runs from a checkout.
[docs/security-architecture.md](../security-architecture.md#turning-it-off)
has the detail.

Those deployments browse mixos.org. `MIXOS_REPOSITORY_URL`, which points a
development checkout at another catalogue, is ignored there unless it names the
deployment's own machine (`localhost`, `127.0.0.1`, `[::1]` or
`host.docker.internal`), and the server log says when it is.

### Installing from the Registry on a deployment

A deployment runs what its build carries. Its Browse pages show the catalogue,
and say: "This deployment runs a build. Install and register in a checkout of
your repository, commit, and deploy." To add an extension:

1. In a checkout of your repository, running `npm run dev`, install it from
   Browse. An app or a connector waits in `.mixos/pending/`, where none of its
   code runs.
2. Review it and register it: **Review and register** on Admin > Apps or
   Admin > Connectors, or `npm run register -- <kind>/<slug>`. A theme is
   registered as it installs.
3. Commit its folder, `apps/<slug>`, `connectors/<slug>` or `themes/<slug>`,
   with the `.registry.json` install wrote in it, and open a pull request.
   Register hands back the commands and a commit message that records where
   the extension came from; `/mixos deploy` does the same.
4. Merge it into the branch your host deploys. On Coolify, Dokploy, Render,
   Railway and Vercel, that ships it. With Docker Compose on your own server,
   pull it there, then build, migrate and start, as in
   [Upgrading](docker-compose.md#upgrading).

The deployment reads where each extension came from out of its build
(`src/generated/registry-installs.ts`, from the `.registry.json` files), and
Browse says so: "Installed from mixos.org · 1.2.0". An installed folder edited
after install shows "modified locally".

An app arrives **inactive** on each instance. Activate it on that instance's
Admin > Apps. One that takes the name of a different extension that instance
had asks for its name typed; see
[When a different extension takes a name](#when-a-different-extension-takes-a-name).
After Register, the checkout offers **Activate in this checkout**
only when its own database is on the same machine: loopback, a Unix socket or
`host.docker.internal`, as with the local Docker stack. A checkout that uses a
database other instances share doesn't offer it, because activating there would
turn the app on for every instance on that database.

### When an extension needs a newer MixOS

A release of an extension can name the oldest MixOS it runs on, and its
`.registry.json` keeps it. Install and Register refuse a release that needs a
newer MixOS than the checkout's, the version in `package.json`, and the build
checks again. When an extension in the build needs a newer MixOS than the one
being built, the build stops:

```
This build is MixOS 0.1.0, and an extension installed from a Registry needs a newer one:
  apps/acme-board/.registry.json: release 1.2.0 requires MixOS 0.2.0 or newer.
Upgrade MixOS, or install an older release of it that runs on 0.1.0. The build stops rather than leave it out of this deploy.
```

It stops because skipping the extension would drop it from the deploy without
a word. Nothing is deployed, so what was serving keeps serving, and a pull
request that carries the extension fails CI the same way. It happens when the
extension was installed on a newer MixOS than the one being built: in a
checkout with `package.json` bumped locally, say, or on a branch with an
upgrade yours doesn't have.

To fix it, [upgrade MixOS](#upgrading) to a release that meets the floor, or go
back to a release of the extension that runs on your version. Browse installs
only an extension's current release, so going back means reverting the commit
that brought the newer one in. A local extension, with no `.registry.json`, is
never checked, and a floor that isn't a version is a warning, not a stop.

### What MixOS sends to mixos.org

Once a day, each instance asks mixos.org about the extensions it installed from
there, so that when a publisher withdraws a release, for a security problem say,
the admins of every instance running it see why. The tick sends one request,
from the server:

```
POST https://mixos.org/api/v1/updates
{ "instanceId": "<random UUID>",
  "items": [{ "kind": "app", "slug": "files", "version": "1.2.0" }] }
```

- **Sent:** a random ID for the instance, and the kind, slug and version of
  each extension installed from mixos.org, from its `.registry.json`.
- **Not sent:** extensions you wrote or installed from anywhere else, users,
  data, settings, the instance's URL, and the MixOS version.
- **The ID** is made at the first check and kept in the instance's database, as
  `platform_settings.registry_instance_id`. It comes from nothing about the
  instance. Each database is one instance, so a checkout and production are
  two.
- **What mixos.org keeps:** for each instance and extension, the version it last
  listed, a two-letter country, and when it was first and last seen, until 30
  days after the last check that listed it; and, for each release an instance
  lists for the first time, a row that counts the install, for 30 days and then
  only as daily totals. Its database doesn't store IP addresses. Its
  [API docs](https://mixos.org/docs/api#what-we-record-and-what-we-do-not)
  have the detail.

The answer only shows notices, under the header of Admin > Apps, Connectors and
Themes: a release its publisher withdrew, with their reason and, for an app, a
**Deactivate** button; a newer release; a listing that's no longer published;
and when mixos.org last answered. Nothing is updated or switched off for you.

A check runs about once a day, and at the next tick after a deploy changes what
is installed. If mixos.org can't be reached, the last answer stays, and the
check tries again an hour later, or after the wait mixos.org asks for, but
never more than a day later.

To turn it off, set `MIXOS_UPDATE_CHECK=false`: nothing is sent and no ID is
created, and admins aren't told about withdrawn releases. Any value other than
`true` or `false` is read as `false`, and the release step reports it. To stop
checking one extension, delete its `.registry.json`.

### The release step

[`scripts/release.ts`](../../scripts/release.ts) runs four things, in order:

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
   [When an app leaves the build](#when-an-app-leaves-the-build). An app that
   is a different extension than the one recorded under its slug is switched
   off; see
   [When a different extension takes a name](#when-a-different-extension-takes-a-name).
3. **Where each connector and theme came from**, by
   [`scripts/sync-identities.ts`](../../scripts/sync-identities.ts), which
   `npm run migrate:apps` also runs. A connector that is a different one than
   the one recorded under its name is disabled.
4. **The first admin**, from `INITIAL_ADMIN_*`, only if that account does not
   exist yet.

It is safe to run on every deploy, and safe to run twice at once: each
migration takes a transaction-scoped lock and re-checks the ledger first. The
readiness probe, `/api/health/ready`, returns 503 until the database has the
platform schema the build expects and every app migration the build carries,
so point the platform's health check there. On a host that waits for it, a
deploy that skips the release step, or whose release step failed, does not
serve errors. On one that doesn't, a platform schema behind the build shows
[the maintenance page](#the-maintenance-page) instead, and an app whose own
migrations are behind says it is being updated. On Vercel the release
step is part of the production build, so a failed one fails the build and the
previous deployment keeps serving.

### The maintenance page

When the platform schema is behind the build, because the release step didn't
run or failed, the whole instance waits. Every page shows a plain "Down for
maintenance" page, and every API route answers 503 with `Retry-After: 30`. That
includes `/api/cron`, so the tick is skipped, and `/api/webhooks`, so senders
retry later. Only `/api/health/live` and `/api/health/ready` answer as usual,
and readiness reports `"reason": "schema-behind"`.

The page shows no versions and no instructions, since visitors aren't
operators. The server log has both, in a line starting
`Serving the maintenance page:`. To fix it, run the release step against the
database: `node ops/release.cjs` in the image, or
`DATABASE_URL='<connection string>' npm run release` from a checkout. The
instance serves again within 30 seconds, with no restart.

An app whose own migrations are behind doesn't close the instance. Only that
app waits: its pages show a plain "Being updated" page, and its API routes
answer 503 with `Retry-After: 30`, both saying "This app is being updated. Try
again shortly." Its scheduled jobs wait too, and stay due. Every other app and
page serves as usual. Readiness reports it as
`"reason": "app-migrations-behind"`, and the server log names the app and its
files in a line starting `Serving "being updated" for`. The same release step
applies them, and the app serves again within 30 seconds. An app an admin has
switched off answers as it always does.

On a host that waits for readiness before it switches traffic, visitors keep
the previous version and never see the page.

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

### When a different extension takes a name

The release step also records where each app, connector and theme came from:
the catalogue and GitHub repository in its `.registry.json`, or local when it
has none. A new release from the same repository is an update, and changes
nothing. Anything else means a different extension now has the name, for
example a local app you removed and installed again from the Registry, or a
release from another repository. The release step then:

- **switches an app off**, marks it **Replaces a different extension** on
  Admin > Apps, and revokes its API keys. Its grants, settings and data stay.
  To turn it on, check what it does, press **Activate** and type its slug.
- **disables a connector**, keeping its credentials. To turn it on, press
  **Enable** on Admin > Connectors and type its name.
- **records a theme**, and nothing more. A theme runs no code and holds no
  data.

The audit log records each as `app.identity.changed`,
`connector.identity.changed` or `theme.identity.changed`, with both
identities. Every app the database knew before this check existed counts as
local, and so does every connector that held credentials then. So the first
release step after you reinstall one of those from the Registry switches it
off once. Deleting an installed extension's `.registry.json` makes it local,
which counts as a different extension too.

### Which build is running

The admin pages show the MixOS version and the commit the deployment was built
from, for example `MixOS 0.4.2 · commit 3e1f0a2`, so you can check that a deploy
landed. Only admins see them.

The version is `package.json`'s, stamped into every build. The commit comes from
the host:

| Host | Where the commit comes from |
| --- | --- |
| Docker Compose | `MIXOS_COMMIT=$(git rev-parse HEAD)` in front of the build command. See [docker-compose.md](docker-compose.md#upgrading). |
| Coolify | `MIXOS_COMMIT=$SOURCE_COMMIT` in the resource's environment. See [docker-compose.md](docker-compose.md#coolify). |
| Dokploy | Nothing maps it, so it shows as unknown. |
| Render | `RENDER_GIT_COMMIT`, which Render sets. |
| Railway | `RAILWAY_GIT_COMMIT_SHA`, which Railway sets on deploys from GitHub. |
| Vercel | `VERCEL_GIT_COMMIT_SHA`, which Vercel sets. |

The app takes the first of `MIXOS_COMMIT`, `VERCEL_GIT_COMMIT_SHA`,
`RENDER_GIT_COMMIT` and `RAILWAY_GIT_COMMIT_SHA` that holds a commit SHA. An
empty or malformed value is skipped. With none, the commit shows as unknown.

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

## Upgrading

Each version of MixOS is a release: a tag on this repository's `main`, such
as `v0.2.0`, listed on the [releases page](https://github.com/mixoshq/mixos/releases)
with notes that put breaking changes first. Upgrade by merging the newest
release tag into your fork. Don't merge `upstream/main`: between releases it
holds work that hasn't been released yet.

1. **Back up the database.** Migrations only go forward, so a backup is the
   way back. `pg_dump` works on every path; for the database in the Compose
   file, see [Backups and access](docker-compose.md#backups-and-access).
2. **Merge the release on a branch.** Add this repository as `upstream` once
   (`git remote add upstream https://github.com/mixoshq/mixos.git`), then:

   ```bash
   git fetch upstream --tags
   git describe --abbrev=0 --exclude '*-*' upstream/main   # the newest release, e.g. v0.2.0
   git switch -c upgrade-v0.2.0
   git merge --no-edit v0.2.0
   ```

3. **Check it.** Read the release's breaking changes against your apps. Then
   run `npm ci && npm run build`, and start it locally with
   `npm run dev:docker`, which applies its migrations to your local database
   first.
4. **Push the branch and open a pull request** against your fork's `main`,
   not this repository's. Once it merges, your host's guide says what happens
   next: [Docker Compose](docker-compose.md#upgrading),
   [Render](render.md#upgrades), [Railway](railway.md#upgrades) or
   [Vercel](vercel.md#upgrades). When the deploy is done, the admin pages
   show the new version and its commit
   ([Which build is running](#which-build-is-running)).

Skipping releases is fine. Merge the newest tag, and the release step applies
every migration in between; read the notes of each release you skipped.
Prereleases, tags with a suffix such as `v0.3.0-rc.1`, are for trying a
version before it's final, and `--exclude '*-*'` leaves them out.

Extensions installed from the Registry move with your copy. A release of one
can name the oldest MixOS it runs on: install and Register refuse it on an
older version, and a build that carries it stops (see
[When an extension needs a newer MixOS](#when-an-extension-needs-a-newer-mixos)).
Upgrading never trips that check, since every floor an older MixOS meets, a
newer one meets too.

## Before going public

Read [docs/security-architecture.md](../security-architecture.md): the trust
boundaries, the key inventory and the row-level security coverage. Then read
[docs/secure-edge-gateway-architecture.md](../secure-edge-gateway-architecture.md)
for the request path in front of it.
