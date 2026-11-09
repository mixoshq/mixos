# After you install

MixOS is running. This page covers what comes next: the first admin, checking
the build, backups, the notices MixOS shows, and installing, updating and
removing extensions. Three pages go further:

- **[Upgrading MixOS](upgrading.md)**: taking a new release, and rolling back.
- **[Securing your install](securing.md)**: who can reach it, taking access
  away, and what to watch.
- **[The GitHub App](github-app.md)**: linking your repository, so a deployment
  can propose extensions and updates as pull requests.

## Sign in and add your team

The release step created your admin account from `INITIAL_ADMIN_EMAIL` and
`INITIAL_ADMIN_PASSWORD`. Sign in at your address, and change the password on
your account page. The release step never changes an existing account, so the
two variables are safe to leave set.

Only people with an account can sign in, and there's no sign-up page: an admin
creates each account at Admin > Users. Email and password is the only way in. To
limit which addresses can have an account at all, set `ALLOWED_EMAIL_DOMAINS` to
your company's domain; it's checked when an admin creates an account, and again
at sign-in.

To reset a forgotten admin password, set `INITIAL_ADMIN_EMAIL` and a new
`INITIAL_ADMIN_PASSWORD`, and run `node ops/seed-admin.cjs` in the image, with
the deployment's environment. Unlike the release step, it resets an existing
account's password and makes it an admin. With Docker Compose, that's
[one command](../providers/self-hosted.md#backups-and-access). From a checkout,
`npm run seed-admin` does the same, and reads your `.env.local` as well as its
environment.

## Which build is running

The admin pages show the MixOS version and the commit the deployment was built
from, for example `MixOS 0.4.2 · commit 3e1f0a2`, so you can check that a deploy
landed. Only admins see them.

The version is `package.json`'s, stamped into every build. The commit comes from
the host:

| Host | Where the commit comes from |
| --- | --- |
| Docker Compose | `MIXOS_COMMIT=$(git rev-parse HEAD)` in front of the build command. See [Upgrading](../providers/self-hosted.md#upgrading) |
| Coolify | `MIXOS_COMMIT=$SOURCE_COMMIT` in the resource's environment, made available at build time too. See [Coolify](../providers/self-hosted.md#coolify) |
| Dokploy | Nothing sets it, so the commit shows as unknown |
| Render | `RENDER_GIT_COMMIT`, which Render sets |
| Railway | `RAILWAY_GIT_COMMIT_SHA`, which Railway sets on deploys from GitHub |
| Vercel | `VERCEL_GIT_COMMIT_SHA`, which Vercel sets |

MixOS takes the first of `MIXOS_COMMIT`, `VERCEL_GIT_COMMIT_SHA`,
`RENDER_GIT_COMMIT` and `RAILWAY_GIT_COMMIT_SHA` that holds a commit SHA. An empty
or malformed value is skipped. With none, the commit shows as unknown.

## Back it up

- **The database.** `pg_dump` works on every host:
  `pg_dump "$DATABASE_URL" -Fc -f mixos.dump`. Each host page says how to reach
  its database: Render's needs your address on its allow list, Railway's needs
  the public connection string, and Docker Compose's is reached from inside its
  container.
- **The keys.** `CONNECTOR_ENCRYPTION_KEY`, `USER_OAUTH_ENCRYPTION_KEY` and
  `APP_SETTINGS_ENCRYPTION_KEY` encrypt data in the database, and
  `GITHUB_APP_ENCRYPTION_KEY`, if you set it, encrypts the GitHub App's key. A
  database backup is no use without them.

Back up before anything that migrates the database: an upgrade, or an update of
an extension that adds a migration. Migrations only go forward, so a backup is
the way back. [Rolling back](upgrading.md#rolling-back) says how to restore one.

## Keep it secure

- **Always use HTTPS**, which every host page sets up.
- **Never put a development copy online.** Its keys are public.
- **Decide who can reach it at all.** A private network is safest.
- **Read [Securing your install](securing.md)** before anyone else can reach
  it.

## Keep MixOS up to date

Each version of MixOS is a release: a tag on `mixoshq/mixos`, such as `v0.2.0`.
Admins hear when a newer one is out: see
[Release and update notices](#release-and-update-notices). To take it, run
`/mixos upgrade` in Claude Code, in your copy, or merge the release's tag into
your repository from `upstream` by hand, and deploy it: see
[Upgrading MixOS](upgrading.md).

## Release and update notices

Once a day, MixOS checks mixos.org for updates: new releases of MixOS, and of
the extensions it installed from mixos.org. It identifies itself only by a
random ID, and mixos.org doesn't keep IP addresses.

- **Sent:** the random ID, and the kind, slug and version of each extension the
  instance installed from mixos.org.
- **Not sent:** extensions you wrote or installed from anywhere else, users,
  data, settings, the instance's address, and the MixOS version.
- **What admins see:** a banner when a new release of MixOS is out, and a
  notice on Admin > Apps, Connectors or Themes when an installed extension has
  a newer release, or its publisher withdrew the one you run. Nothing is
  updated or switched off for you.

To turn the checks off, set `MIXOS_UPDATE_CHECK=false`. Nothing is sent, and
admins aren't told about new or withdrawn releases. The Registry API docs say
[what mixos.org records](https://mixos.org/docs/api#what-we-record-and-what-we-do-not).

## Extensions

Installing, updating and removing an extension are changes to your repository.
You make them in a [development copy](../development.md), commit them, and
deploy; or, with the [GitHub App](github-app.md) linked, a deployment proposes
them as a pull request.

### Fixing what an instance runs

By default an admin can browse the catalogue at mixos.org from the Apps,
Connectors and Themes admin pages, and install from it in a checkout. To make an
instance run only the extensions it was deployed with, set the kind's flag to
`false`:

```
INSTALL_APPS=false
INSTALL_CONNECTORS=false
INSTALL_THEMES=false
```

Each one, on its own, removes that kind's Browse button and makes its browse page
a 404. The server actions behind the page refuse that kind too, so there's no way
left to install one, not just no link to it. Register, from the page or from
`npm run register`, won't register it either. Extensions already on the instance
are unaffected: apps can still be activated, connectors configured and themes
applied. A new one arrives the way code always can, through the repository and a
deploy.

`true`, `1`, `yes` and `on` are on; `false`, `0`, `no` and `off` are off. Any
other value is read as `false`, and the release step reports it, so a typo locks
the instance down rather than leaving it open. The flags are read per request, so
changing one needs a restart, not a rebuild.

A deployment built from the Docker image (Docker Compose, Render, Railway) or on
Vercel doesn't install from the catalogue in any case: installing writes source
into a checkout and runs the registry generator, and a built deployment has
neither. On those, the flags decide whether the catalogue can be browsed at all.
On an instance that runs from a checkout, they lock installs down.
[Installing from the repository](../../security-architecture.md#31-installing-from-the-repository)
has the detail, under "Turning it off".

Those deployments browse mixos.org. `MIXOS_REPOSITORY_URL`, which points a
development checkout at another catalogue, is ignored there unless it names the
deployment's own machine (`localhost`, `127.0.0.1`, `[::1]` or
`host.docker.internal`), and the server log says when it is.

### Installing from the Registry on a deployment

A deployment runs what its build carries. Its Browse pages show the catalogue,
and say: "This deployment runs a build. Install and register in a checkout of
your repository, commit, and deploy." With the GitHub App linked, a deployment
can propose an extension as a pull request instead; see
[Proposing an extension](github-app.md#proposing-an-extension). To add one from a
checkout:

1. In a checkout of your repository, running `npm run dev`, install it from
   Browse. An app or a connector waits in `.mixos/pending/`, where none of its
   code runs.
2. Review it and register it: **Review and register** on Admin > Apps or
   Admin > Connectors, or `npm run register -- <kind>/<slug>`. A theme is
   registered as it installs.
3. Commit its folder, `apps/<slug>`, `connectors/<slug>` or `themes/<slug>`, with
   the `.registry.json` install wrote in it, and open a pull request. Register
   hands back the commands and a commit message that records where the extension
   came from; `/mixos deploy` does the same.
4. Merge it into the branch your host deploys. On Coolify, Dokploy, Render,
   Railway and Vercel, that ships it. With Docker Compose on your own server,
   pull it there, then build, migrate and start, as in
   [Upgrading](../providers/self-hosted.md#upgrading).

The deployment reads where each extension came from out of its build
(`src/generated/registry-installs.ts`, from the `.registry.json` files), and
Browse says so: "Installed from mixos.org · 1.2.0". An installed folder edited
after install shows "modified locally".

An app arrives **inactive** on each instance. The release step adds it switched
off, and none of its code runs until an admin activates it on that instance's
Admin > Apps. The switch is kept in the database, so an instance with a database
of its own, staging as well as production, activates each app on its own. One
that takes the name of a different extension that instance had asks for its name
typed; see
[When a different extension takes a name](#when-a-different-extension-takes-a-name).
[Running a development copy](../development.md#installing-from-the-registry) has
the checkout's side: Register's commands, `--smoke`, and **Activate in this
checkout**.

### The pull-request check

[`.github/workflows/extensions.yml`](../../../.github/workflows/extensions.yml)
runs on pull requests that change `apps/`, `connectors/` or `themes/`. It fails
the pull request when:

- **An installed folder doesn't match its `.registry.json`.** It hashes each
  folder as committed, so an edit after install fails it, and so does a file the
  commit left out. Your `.gitignore` can leave one out (`*.pem`, `.npmrc`);
  `npm run register` names any it would. Commit the file with `git add -f`,
  install the release again, or delete the `.registry.json` to keep the folder as
  your own local extension. To run this check yourself:
  `npx tsx scripts/check-install-records.ts`.
- **A changed app fails its smoke test.** The job starts a fresh MixOS: a
  Postgres that lives as long as the job, keys made for the run, the release
  step, `npm run build` and `npm run start`. It activates and grants each app the
  pull request changes, then runs `scripts/smoke-test-app.ts` as the first admin.
  A 5xx, a timeout or a refused request fails it. The job has no connector
  credentials, so a route that answers 503 UNAVAILABLE is skipped, not failed. A
  pull request that changes only a connector or a theme gets the folder check and
  no smoke test.

The job can read the repository and nothing else: no secrets, and a read-only
token it doesn't keep. It runs only when those paths change, so GitHub would
wait for it forever on other pull requests if you made it a required check. Read
its result on the pull request instead.

### When an extension needs a newer MixOS

A release of an extension can name the oldest MixOS it runs on, and its
`.registry.json` keeps it. Install and Register refuse a release that needs a
newer MixOS than the checkout's, the version in `package.json`, and the build
checks again. When an extension in the build needs a newer MixOS than the one
being built, the build stops:

```
This build is MixOS 0.4.2, and an extension installed from a Registry needs a newer one:
  apps/acme-board/.registry.json: release 1.2.0 requires MixOS 0.5.0 or newer.
Upgrade MixOS, or install an older release of it that runs on 0.4.2. The build stops rather than leave it out of this deploy.
```

It stops because skipping the extension would drop it from the deploy without a
word. Nothing is deployed, so what was serving keeps serving, and a pull request
that carries the extension fails CI the same way. It happens when the extension
was installed on a newer MixOS than the one being built: in a checkout with
`package.json` bumped locally, say, or on a branch with an upgrade yours doesn't
have.

To fix it, [upgrade MixOS](upgrading.md) to a release that meets the floor, or go
back to a release of the extension that runs on your version. Browse installs
only an extension's current release, so going back means reverting the commit
that brought the newer one in. A local extension, with no `.registry.json`, is
never checked, and a floor that isn't a version is a warning, not a stop.

### Updating an extension

Updating an extension is a change to your repository, as installing one is. A
notice under the Apps, Connectors or Themes header says when a newer release is
out, or when the installed one was withdrawn: see
[Release and update notices](#release-and-update-notices). To update:

1. In a checkout of your repository, running `npm run dev`, press **Update** on
   the notice, or on the extension's listing in Browse. The dialog lists the
   releases with their dates, and for the one you pick shows what changes: the
   publisher's claims, what the manifest declares, new migrations, and any files
   you changed locally. Local changes, an older release and a withdrawn one each
   need an explicit yes.
2. For an app or a connector, the release is downloaded, verified and checked as
   an install is, and waits in `.mixos/pending/`; the folder in place isn't
   touched yet. Press **Review and register**, there or later under Waiting to
   register, or run `npm run register -- <kind>/<slug>`. Register moves the
   folder to `.mixos/backup/`, puts the new release in its place and runs the
   registry generator. If the generator refuses the new release, the old one is
   put back; if it accepts it, the backup is deleted. Register refuses to go
   ahead if the folder changed after the update was prepared. A theme runs no
   code, so the dialog swaps it in at once.
3. An app's activation, grants and settings, and a connector's credentials,
   belong to its name in the database, so they carry over. New migrations are
   applied by `npm run migrate:apps` in the checkout and by the release step on
   each instance, and can't be undone. If `npm run dev` was running, restart it:
   it can keep serving the old code until it does.
4. Commit the change and open a pull request. Register hands back the commands
   and a commit message that names both releases; `/mixos deploy` does the same.
5. Merge it into the branch your host deploys.

On a deployment with the [GitHub App](github-app.md) linked, **Propose update**
on the notice or the listing does steps 1 to 5 as a pull request; see
[Proposing an extension](github-app.md#proposing-an-extension).

An update that stops midway leaves the old folder in `.mixos/backup/`, and
`npm run register -- --recover` asks whether to put it back or keep the new
release.

**Rolling an update back.** Once it's deployed, roll it back as you would any
change: revert the commit and deploy again, or redeploy the previous build on
your host. Neither undoes a migration the new release ran; only restoring a
backup of the database does, so back the database up before deploying an update
that adds one. The release step treats a new release from the same repository as
the same extension, so nothing is switched off or revoked; a release from another
repository counts as a different extension (see
[When a different extension takes a name](#when-a-different-extension-takes-a-name)).

### Removing an extension

Removing an extension is a change to your repository, as installing one is:

1. In a checkout of your repository, running `npm run dev`, press **Remove** on
   its tile in Admin > Apps, Connectors or Themes, or run
   `npm run remove -- <kind>/<slug>`. Either says first what goes and what stays.
   It's refused while an app depends on it (an app that requires the connector,
   or uses the app's services or hooks), and for the last theme.
2. Commit the deletion and open a pull request. Removing hands back the commands
   and a commit message; `/mixos deploy` does the same. An extension installed
   from the Registry takes its `.registry.json` with it.
3. Merge it into the branch your host deploys.

On a deployment with the [GitHub App](github-app.md) linked, **Propose removal**
in the Remove dialog does all three as a pull request; see
[Proposing an extension](github-app.md#proposing-an-extension).

Its data stays in each database: an app's tables, settings, API keys, grants and
scheduled jobs, and a connector's credentials. The release step marks a removed
app or connector missing and keeps all of it; see
[When an app leaves the build](#when-an-app-leaves-the-build). An admin deletes
it on each instance once the removal is deployed there; see
[Deleting an extension's data](#deleting-an-extensions-data). A theme holds no
data. An instance that applies a removed theme shows the first theme by name
until an admin applies another.

A removal that stops midway leaves the folder in `.mixos/backup/`, and
`npm run remove -- --recover` puts it back.

### When an app leaves the build

The release step never deletes an app. When the build doesn't carry an app the
database knows, because its folder was removed or renamed or the build skipped
it, the step marks it missing and keeps everything it had: whether it was
active, its grants, installs, widgets and password, its settings and API keys,
its scheduled jobs and its tables. Nobody can open it while it's missing, and
Admin > Apps lists it under **Not in this build**, where **Revoke access…**
takes it from people, or revokes its API keys, before it comes back. A renamed
folder is a new app: it arrives inactive with none of the old one's data.

When the app comes back, the step compares a hash of its files with the one it
recorded:

- **The same files**, after a rollback or once the build stops skipping it: the
  app comes back as it left, active or not.
- **Different files**: the app comes back switched off, and marked **Back with
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

The release step also records where each app, connector and theme came from: the
catalogue and GitHub repository in its `.registry.json`, or local when it has
none. A new release from the same repository is an update, and changes nothing.
Anything else means a different extension now has the name, for example a local
app you removed and installed again from the Registry, or a release from another
repository. The release step then:

- **switches an app off**, marks it **Replaces a different extension** on
  Admin > Apps, revokes its API keys and turns its MCP tools off. Its grants,
  settings and data stay. To turn it on, check what it does, press
  **Activate** and type its slug, then turn on the tools you want on its MCP
  tab.
- **disables a connector**, keeping its credentials. To turn it on, press
  **Enable** on Admin > Connectors and type its name.
- **records a theme**, and nothing more. A theme runs no code and holds no data.

The audit log records each as `app.identity.changed`,
`connector.identity.changed` or `theme.identity.changed`, with both identities.
Deleting an installed extension's `.registry.json` makes it local, which counts
as a different extension too.

### Deleting an extension's data

Admin > Apps and Admin > Connectors list under **Not in this build** each app or
connector whose data the database keeps and the build doesn't have. Keeping it
costs nothing and needs nothing. To delete it, press **Delete data…** on its
entry, read what goes, and type its name.

- **An app** loses its schema, `app_<slug>`, with its tables, and its database
  role, `mixos_app_<slug>`; its settings, API keys, scheduled jobs and their
  runs, the record of which of its migrations ran, its telemetry and recorded
  opens; its place in each MCP authorization; and its row, with its grants, user
  installs, password, widgets and MCP tool switches.
- **A connector** loses its saved credentials, every user's own connection, its
  granted scopes, webhook replay markers and telemetry, and its switch and marks.

The audit log is never touched, and gains a row for the deletion,
`app.data.delete` or `connector.data.delete`, with how much went. Nothing else is
touched either: another extension whose name starts with the same letters keeps
all of its data. Afterwards nothing under the name is left, so a later extension
with the same name starts with nothing. Deleting can't be undone, so back up the
database first if you might want the data back.

It's refused:

- while the build serving this instance has it;
- until a release step has run on this database without it. Deploy the removal,
  or run `npm run migrate:apps` in a checkout. A host's rollback serves an older
  build without a release step, so a build that lacks an extension doesn't show
  on its own that it has gone;
- while any other build that used this database in the last 24 hours has it.

Each build records which apps and connectors it carries at its release step, when
its server starts, and on the tick, at most every ten minutes. A deployment is
known by its commit and what it carries, and a checkout by the random ID in
`.mixos/checkout-id`. The instance asking doesn't count against itself.

In a checkout, the Remove dialog also has **Remove code and delete this
checkout's data**, which asks for the name typed and deletes the data right after
the code, with the same checks. On a database only this machine reaches, the
removal counts as the release step having run. On a shared one it doesn't: run
`npm run migrate:apps` or deploy first, then use Delete data. If the data can't
be deleted, the code still goes and the data stays.

## Link the GitHub App

Developers > GitHub App links a deployment to the repository it's built from, through a
private GitHub App you own, installed on that one repository. Then the
deployment can propose extensions, their updates and their removals as pull
requests, which you review and merge on GitHub. It's off until
`GITHUB_APP_ENCRYPTION_KEY` is set. See [The GitHub App](github-app.md).
