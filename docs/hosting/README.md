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
   five minutes, which drives scheduled jobs, the daily
   [update check](#what-mixos-sends-to-mixosorg) and the daily check for
   [new releases of MixOS](#new-releases-of-mixos). Vercel Cron, a cron job on
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
| `MIXOS_UPDATE_CHECK` | No, default `true` | Whether the instance asks mixos.org once a day about the extensions it installed from there, so admins see a release its publisher withdrew, and about new releases of MixOS. `false` sends nothing. See [What MixOS sends to mixos.org](#what-mixos-sends-to-mixosorg). |
| `MIXOS_RELEASE_CHANNEL` | No, default `stable` | Which releases of MixOS the admin pages tell you about: `stable`, or `prerelease` to include prereleases. See [New releases of MixOS](#new-releases-of-mixos). |
| `GITHUB_APP_ENCRYPTION_KEY` | No | Turns on Admin > GitHub, which links the instance to its repository through a GitHub App you own. 32 random bytes; `npm run keys:generate -- --github-app` prints one. The App's private key is stored encrypted under it, so **back it up**. See [Linking your GitHub repository](#linking-your-github-repository). |
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
your repository, commit, and deploy." With the GitHub App linked, a deployment
can propose an extension as a pull request instead; see
[Proposing an extension](#proposing-an-extension). To add one from a checkout:

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

`npm run register -- app/<slug> --smoke` follows the same rule. After Register
it runs the app's migrations, activates it, grants it to the user you sign in
as (`SMOKE_EMAIL` and `SMOKE_PASSWORD`, or `SMOKE_COOKIE`) and runs the smoke
test against your dev server. It reports and never rolls back. On a database
that isn't on your machine it refuses, before registering anything, unless you
pass `--database-is-disposable`.

### The pull-request check

[`.github/workflows/extensions.yml`](../../.github/workflows/extensions.yml)
runs on pull requests that change `apps/`, `connectors/` or `themes/`. It fails
the pull request when:

- **An installed folder doesn't match its `.registry.json`.** It hashes each
  folder as committed, so an edit after install fails it, and so does a file the
  commit left out. Your `.gitignore` can leave one out (`*.pem`, `.npmrc`);
  `npm run register` names any it would. Commit the file with `git add -f`,
  install the release again, or delete the `.registry.json` to keep the folder
  as your own local extension. To run this check yourself:
  `npx tsx scripts/check-install-records.ts`.
- **A changed app fails its smoke test.** The job starts a fresh MixOS: a
  Postgres that lives as long as the job, keys made for the run, the release
  step, `npm run build` and `npm run start`. It activates and grants each app
  the pull request changes, then runs `scripts/smoke-test-app.ts` as the first
  admin. A 5xx, a timeout or a refused request fails it. The job has no
  connector credentials, so a route that answers 503 UNAVAILABLE is skipped,
  not failed. A pull request that changes only a connector or a theme gets the
  folder check and no smoke test.

The job can read the repository and nothing else: no secrets, and a read-only
token it doesn't keep. It runs only when those paths change, so GitHub would
wait for it forever on other pull requests if you made it a required check.
Read its result on the pull request instead.

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
created, and admins aren't told about withdrawn releases. The same switch stops
the check for [new releases of MixOS](#new-releases-of-mixos), so with it off
the instance sends nothing to mixos.org on its own. Any value other than `true`
or `false` is read as `false`, and the release step reports it. To stop
checking one extension, delete its `.registry.json`.

### New releases of MixOS

Once a day, each instance also asks mixos.org which releases of MixOS exist, so
admins hear when a newer one is out. The tick sends one request, from the
server:

```
GET https://mixos.org/api/v1/mixos/releases
User-Agent: MixOS
```

- **Sent:** nothing about the instance. No ID, no version, no query and no
  body. mixos.org records nothing for a `GET`, so all it learns is that a MixOS
  somewhere asked, from the request's IP address.
- **Shown:** when a newer release is out, a notice at the top of every admin
  page, such as "MixOS 0.5.0 is available (this instance runs 0.4.2). A minor
  release: it may need changes." Its notes are collapsed, and their links are
  shown as text, never as links. The notice links to the release's page on
  mixos.org and to [Upgrading](#upgrading). Under the version at the foot of
  the admin pages, a line says when mixos.org last answered.
- **Never applied.** Nothing is merged, downloaded or deployed. Taking a release
  is up to you: merge its tag into your copy, as [Upgrading](#upgrading) says.

The check keeps the update check's schedule: about once a day, and an hour
after a failure, or later if mixos.org asks, but never more than a day later.
Its last answer is kept in the database as
`platform_settings.mixos_release_check`.

**The channel.** `MIXOS_RELEASE_CHANNEL=stable`, the default, tells you about
releases only. `prerelease` adds prereleases, tags with a suffix such as
`v0.3.0-rc.1`, which are for trying a version before it's final. Any other
value is read as `stable`, and the release step reports it.

**Turning it off.** `MIXOS_UPDATE_CHECK=false` turns this check off along with
the update check. Nothing is sent, and the admin pages say the checks are off.

### Linking your GitHub repository

Admin > GitHub links an instance to the repository it is built from, through
a private GitHub App you own. It is off until `GITHUB_APP_ENCRYPTION_KEY` is
set. Generate a value, set it where the instance runs, and restart it:

```
npm run keys:generate -- --github-app
```

Keep a copy: the App's private key is stored encrypted under it. Link from the
deployed instance, not from a development checkout.

1. **Create the App.** Choose your account, or the organization that owns the
   repository. The App asks for contents and pull requests to write, and
   checks, commit statuses and metadata to read. It doesn't ask for workflows
   or any webhook event.
2. **Install it** on GitHub. Choose **Only select repositories**, then the one
   repository this instance is built from.
3. **Finish linking.** The instance checks that the installation covers one
   chosen repository, and that it isn't upstream MixOS, then records it.

Before every operation, the instance checks the installation again. If it
covers every repository, or more than one, the link turns off. Narrow it on
GitHub, then choose **Check again**.

**Add a ruleset.** The App can write to any branch, and your host deploys the
default branch, so require pull requests there. In the repository's
**Settings > Rules > Rulesets**:

- a branch ruleset on the default branch, with **Require a pull request before
  merging** and **Restrict deletions**;
- a tag ruleset on all tags, with **Restrict creations** and
  **Restrict updates**.

Don't put the App on either bypass list. Admin > GitHub shows whether a pull
request rule applies. It reads rulesets only, so if you use classic branch
protection, or your repository is private on GitHub Free, which has no
rulesets, confirm that on the page instead. Linking doesn't need the rule;
proposing changes through the App will.

**Replace the private key** by generating a new one in the App's settings on
GitHub and pasting it on the page. The instance checks it with GitHub before
storing it. Then delete the old key on GitHub.

**Unlink** uninstalls the App from GitHub, then deletes its key and the link
here. If GitHub refuses, nothing is deleted. Then delete the App in its
settings on GitHub.

**Rotating `GITHUB_APP_ENCRYPTION_KEY`.** Re-encrypt the stored key with the
old and the new key, then set the new key and restart:

```
GITHUB_APP_ENCRYPTION_KEY_OLD=<old key> GITHUB_APP_ENCRYPTION_KEY_NEW=<new key> \
  DATABASE_URL=<database> npm run keys:rotate-github-app
```

With Docker Compose, put both in the shell's environment and run
`docker compose -f deploy/docker-compose.yml run --rm -e GITHUB_APP_ENCRYPTION_KEY_OLD -e GITHUB_APP_ENCRYPTION_KEY_NEW migrate node ops/rekey-github-app.cjs`.

### Proposing an extension

With the App linked, a deployment's Browse pages show **Propose to
owner/repo** where a checkout shows Install. Proposing downloads the release,
checks it against the hash mixos.org published, and opens a pull request into
your default branch that adds the extension's folder, with its
`.registry.json`, on the branch `mixos/install/<kind>-<slug>`. Nothing runs on
the instance.

Admin > GitHub shows what proposals need:

- the pull request rule on the default branch, or another protection you
  confirmed;
- **Previews elsewhere** confirmed: Render service previews, Railway PR
  environments and Coolify preview deployments off, and nothing else that
  builds the repository's branches or pull requests with secrets. The App
  can't read those settings, so it asks you.

Before each proposal, the instance reads the default branch and refuses,
naming the file, when:

- a workflow uses `pull_request_target`;
- a workflow that runs for pull requests into the default branch, or for
  pushes to `mixos/**`, uses a secret other than `GITHUB_TOKEN`, asks for a
  write permission, sets no `permissions`, or runs on a self-hosted runner;
- `render.yaml` turns previews on;
- on Vercel, `vercel.json` doesn't turn off deployments of `mixos/**`.

A pull request from a branch in your repository gets its secrets, which is why.
To keep such a workflow, skip each of its jobs for the App's pull requests:

```yaml
jobs:
  deploy:
    if: ${{ !startsWith(github.head_ref, 'mixos/') }}
```

A `branches-ignore` on a `pull_request` trigger doesn't do it, because it
filters the target branch. MixOS's own workflows pass as they are. The instance
also refuses when the extension's folder is already on the default branch, or
the branch exists.

**Merging is the deploy.** Your repository's CI checks the pull request: the
build runs the registry generator, and `extensions.yml` smoke-tests a changed
app. Admin > Apps, Connectors and Themes list the App's open pull requests with
their checks:

- **No CI ran:** nothing checked the head commit within ten minutes. On a new
  fork, GitHub keeps workflows off until you turn them on under **Actions**.
  Don't merge it unchecked.
- **Changed since proposed:** someone pushed to the branch after the App opened
  it. Read those commits before you merge.

When the merge deploys, an app arrives inactive: activate it on Admin > Apps.

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
   the one recorded under its name is disabled. A connector the build no
   longer has, whose credentials the database keeps, is marked missing, and
   keeps them.
4. **What this build carries**: its apps and connectors, which Delete data on
   every instance sharing the database counts; see
   [Deleting an extension's data](#deleting-an-extensions-data).
5. **The first admin**, from `INITIAL_ADMIN_*`, only if that account does not
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

A connector the build no longer has keeps its credentials and its users'
connections the same way. The release step marks it missing, as
`connector.missing`, and clears the mark when it comes back, as
`connector.returned`. Admin > Connectors lists it under **Not in this build**.

What an app or a connector kept stays until an admin deletes it; see
[Deleting an extension's data](#deleting-an-extensions-data).

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

### Removing an extension

Removing an extension is a change to your repository, as installing one is:

1. In a checkout of your repository, running `npm run dev`, press **Remove** on
   its tile in Admin > Apps, Connectors or Themes, or run
   `npm run remove -- <kind>/<slug>`. Either says first what goes and what
   stays. It is refused while an app depends on it (an app that requires the
   connector, or uses the app's services or hooks), and for the last theme.
2. Commit the deletion and open a pull request. Removing hands back the
   commands and a commit message; `/mixos deploy` does the same. An extension
   installed from the Registry takes its `.registry.json` with it.
3. Merge it into the branch your host deploys.

Its data stays in each database: an app's tables, settings, API keys, grants
and scheduled jobs, and a connector's credentials. The release step marks a
removed app or connector missing and keeps all of it; see
[When an app leaves the build](#when-an-app-leaves-the-build). An admin deletes
it on each instance once the removal is deployed there; see
[Deleting an extension's data](#deleting-an-extensions-data). A theme holds no
data. An instance that applies a removed theme shows the first theme by name
until an admin applies another.

A removal that stops midway leaves the folder in `.mixos/backup/`, and
`npm run remove -- --recover` puts it back.

### Deleting an extension's data

Admin > Apps and Admin > Connectors list under **Not in this build** each app
or connector whose data the database keeps and the build doesn't have. Keeping
it costs nothing and needs nothing. To delete it, press **Delete data…** on its
entry, read what goes, and type its name.

- **An app** loses its schema, `app_<slug>`, with its tables, and its database
  role, `mixos_app_<slug>`; its settings, API keys, scheduled jobs and their
  runs, the record of which of its migrations ran, its telemetry and recorded
  opens; its place in each MCP authorization; and its row, with its grants,
  user installs, password and widgets.
- **A connector** loses its saved credentials, every user's own connection,
  its granted scopes, webhook replay markers and telemetry, and its switch and
  marks.

The audit log is never touched, and gains a row for the deletion,
`app.data.delete` or `connector.data.delete`, with how much went. Nothing else
is touched either: another extension whose name starts with the same letters
keeps all of its data. Afterwards nothing under the name is left, so a later
extension with the same name starts with nothing. Deleting can't be undone, so
back up the database first if you might want the data back.

It is refused:

- while the build serving this instance has it;
- until a release step has run on this database without it. Deploy the
  removal, or run `npm run migrate:apps` in a checkout. A host's rollback
  serves an older build without a release step, so a build that lacks an
  extension doesn't show on its own that it has gone;
- while any other build that used this database in the last 24 hours has it.

Each build records which apps and connectors it carries at its release step,
when its server starts, and on the cron tick, at most every ten minutes. A
deployment is known by its commit and what it carries, and a checkout by the
random id in `.mixos/checkout-id`. The instance asking doesn't count against
itself.

In a checkout, the Remove dialog also has **Remove code and delete this
checkout's data**, which asks for the name typed and deletes the data right
after the code, with the same checks. On a database only this machine reaches,
the removal counts as the release step having run. On a shared one it doesn't:
run `npm run migrate:apps` or deploy first, then use Delete data. If the data
can't be deleted, the code still goes and the data stays.

### Which build is running

The admin pages show the MixOS version and the commit the deployment was built
from, for example `MixOS 0.4.2 · commit 3e1f0a2`, so you can check that a deploy
landed, and when a newer release is out (see
[New releases of MixOS](#new-releases-of-mixos)). Only admins see them.

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
with notes that put breaking changes first. When a newer one is out, the admin
pages say so ([New releases of MixOS](#new-releases-of-mixos)). Upgrade by
merging the newest release tag into your fork. Don't merge `upstream/main`:
between releases it holds work that hasn't been released yet.

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
