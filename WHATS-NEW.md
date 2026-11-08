# What's new in MixOS

Recent, developer-facing changes — newest first. When you ship something worth
announcing (a new command, a new capability, a workflow change), add a short
`## <date>` section at the top. Keep entries brief; this is not a full changelog,
and upgrade steps belong in the release notes (`CHANGELOG.md`).

The newest section is shown automatically after you `git pull` (via the
`.githooks/post-merge` hook), but only when this file was among the commits you
just pulled.


## 2026-11-08

- **MixOS Launcher, a Mac app.** It has a window listing every copy of MixOS on
  your Mac with a ✓ or ✗ for each check, and a menu bar icon, the MixOS mark,
  for opening, starting and stopping them. It also sets up a new copy: it
  checks for git, Node and Docker, downloads the newest release, and starts it
  with a database of its own. `npm run desktop:mac` builds it into
  `desktop/macos/dist/`. See [desktop/macos](desktop/macos/README.md).
- **`npm run status -- --json`** prints the status as JSON, for programs like
  the Launcher.
- **You can see that MixOS is up.** `npm run dev:docker`, its `--detach` and a
  host `npm run dev` all end on a summary that the running app answers: a ✓ or
  ✗ for the web server, the database, the sign-in page and Studio, with the
  address, the login, and the fix under anything that failed. Then the browser
  opens, for a person at a terminal (`--no-open` turns that off). Next's own
  `Ready` line isn't the signal any more. See
  [How you know it's up](docs/local-docker.md#how-you-know-its-up).
- **`npm run status`** asks the same questions any time, and lists every MixOS
  running on your computer with its port. It exits 0 only when everything
  answers.
- **Port 3000 taken? MixOS says by what.** When another MixOS already has it, a
  second checkout or a forgotten `npm run dev`, the boot names it and offers
  the next free port. Run by Claude or a script, it prints the command to use
  instead. `.env.instance` no longer needs a `MIXOS_PORT`. A second instance
  now gets `NEXTAUTH_URL` for its own port, not 3000's.
- **Every checkout has its own database.** A second clone or a git worktree
  used to be the same `mixos` instance as the first, sharing one database.
  Now, on its first boot, it gets an instance of its own, named after its
  folder, with its own Supabase ports and a fresh database, saved to its
  `.env.instance`. The first checkout keeps its data. `docker:down`, `db:reset`,
  `npm run dev` and `npm run status` never act on another folder's instance.
  Who owns what is kept in `~/.mixos/instances.json`. A memory warning says
  when Docker gets tight with several running. See
  [More than one instance](docs/local-docker.md#more-than-one-instance-on-one-machine).
- **`npm run dev` needs no `.env.local` for the local database.** It finds the
  stack from `npm run dev:docker` by itself, offers to start it if it's down
  (`npm run dev:docker -- --db-only` starts only the database), and offers to
  take over port 3000 from the dev container. A database you configured
  yourself is left alone.


## 2026-10-25

- **Release notes, in the menu bar.** An app, a connector or a theme keeps
  `release-notes.json` beside its manifest, and MixOS one at the root:
  `[{ "date", "version"?, "note" }]`, newest first, each note one line of 300
  characters or fewer, written for the people the change reaches. A gift before
  the name in the menu bar shows each person the last 14 days' notes for MixOS
  and for what is on in their workspace (the apps they installed, the
  connectors not switched off, the active theme), with a red count, and a dot on
  each note until it has been under the pointer, or on screen, for a second.
  App Manager's **Release Notes** button opens all of them at
  `/apps/release-notes`, with a filter. The build and a Registry install check
  the file, and `/mixos app`, `connector`, `theme` and `deploy` write the line
  with the change. See
  [Release notes](docs/apps/architecture.md#release-notes-release-notesjson).
- **No app may be called `release-notes`.** The build refuses the slug, since
  `/apps/release-notes` is that page.
- **Migration 0002** adds `release_notes_seen`, which notes each person has
  seen.
- **Releases from mixos.org are signed, and MixOS checks.** Every install
  manifest is verified against mixos.org's keys, pinned in
  `src/lib/repository/release-signature.ts`, before anything is downloaded. A
  release that isn't signed, or changed after it was, is refused as `unsigned`.
  A development catalogue's own key goes in `MIXOS_REPOSITORY_KEYS`. See
  [§31](docs/security-architecture.md#31-installing-from-the-repository).
- **Browse counts active installs.** A card shows the instances using an
  extension in the last 30 days, as mixos.org does, not the total ever.

## 2026-10-20

- **Connectors mirror their provider, and building an app doesn't change one.**
  A connector covers every operation on the resources it touches, one method
  each, and each method names its provider `operation` in `connector.json`.
  Every connector has a `version`, and within a major version it only adds: the
  build, Register, the pre-commit hook and mixos.org each refuse a change that
  removes what an app may call. See
  [connectors/AGENTS.md](connectors/AGENTS.md#the-contract-a-connector-mirrors-its-provider).
- **An app entry names its connector's version.** `connectors` and
  `optionalConnectors` hold `{ "name", "version", "access"? }`, and a bare name
  fails the build. The app is handed the connector narrowed to its declared
  methods, so `request()` is out of reach.
- **Writes are off until an admin allows them.** A method declared `mutates`
  runs only for an app whose entry says `"access": "write"`, on an install whose
  admin pressed **Allow changes** on the connector's new Configure step. Scopes
  requested with `"requested": "write"` are asked for at Connect only then.
- **Install without forking.** How to install
  (`docs/hosting/install.md`) starts with the quick way: a prompt for Claude
  Code that clones the newest release into `~/MixOS`, then `/mixos init` in VS
  Code. Your copy becomes a private repository of your own, not a fork, since a
  fork of a public repository can't be private: hosts deploy from it, and
  releases merge into it from `upstream`. The manual way has the same steps by
  hand.
- **`/mixos init` ends by offering that repository.** Once MixOS runs, it asks
  whether to create a private GitHub repository and push your copy, with `gh`.
  A clone's `origin` becomes `upstream`; a `.zip` download is first connected
  to the release it came from. Say no, and MixOS stays on your computer. Set up
  already? `/mixos init` again offers it.
- **`/mixos upgrade`.** Takes your copy to MixOS's newest release: it shows the
  notes, anything breaking and any new migrations, merges the release on a
  branch once you say yes, runs the checks, and hands the pull request to
  `/mixos deploy`. Merging it ships the upgrade.
- **A banner for admins when a release is out.** Over every page: "MixOS
  v0.3.0 is out (you run v0.2.0). Run `/mixos upgrade` in Claude Code to
  upgrade.", with **Details** to the notice on the admin pages, which now gives
  `/mixos upgrade` first, whether or not the GitHub App is linked, and the
  merge by hand second. Dismissing the banner hides it until the next release.
- **`/mixos deploy` needs your own repository.** It stops when `origin` is
  missing, or is `mixoshq/mixos` and you can't push there, and points to
  `/mixos init`.
- **A clone of the core ignores other extensions on its own.** In a checkout
  whose `origin` is `mixoshq/mixos`, `npm ci` writes a marked block into
  `.git/info/exclude` that keeps every extension the core doesn't carry out of
  `git status` (`scripts/core-excludes.ts`), and removes it anywhere else, so
  your own copy's extensions can be committed. Lines you wrote there by hand
  still work beside it.

## 2026-10-18

- **Names an extension may need to change.** The ESLint rules are
  `mixos-apps/app-imports` and `mixos-design/no-low-contrast-token-pairs`, which
  is how an `eslint-disable` comment names them. An MCP tool's `sources` and a
  sync's `source` say `"mixos"` for data that exists only in MixOS. App API keys
  start `mixk_`, and a key minted before is refused: mint a new one.
- **`call()` is the client.** `createAppClient()` has no `get`, `post`, `put`,
  `patch` or `delete`. To upload a file, pass a `FormData` to a `raw: true`
  route (`docs/apps/api-routes.md#uploading-a-file`).
- **`apiVisibility` is gone**, and a manifest with it fails the build: a route's
  auth is its `defineRoute({ auth })`. So are the core hooks `init`,
  `user-login`, `user-sync` and `user-display-name`, which never fired.

## 2026-10-16

- **`/mixos remix`.** Abstract a widget, a page or part of a page from one
  installed app into another, as a component of its own. The agent walks you
  through what is being abstracted, the data structure it needs to render, and
  what each CTA does in your app — the same, something different, or nothing —
  and you can remove any CTA or part. It writes a plan and stops; after you
  approve, it builds it into your app, with a comment in every file it wrote
  crediting the source app, its version, its authors and the day. Code is
  adapted only where the source's license allows; otherwise it is rebuilt. See
  `docs/apps/remix.md`.
- **`remixedFrom` in `app.json`** records each remix: the source app, the exact
  commit it was taken at, and what was kept, changed and removed. It is written
  once and never edited: the pre-commit hook and Danger refuse a change to an
  existing entry. Admin > Apps > an app's **Remixes** tab shows what it took and
  who took from it.

## 2026-10-15

- **MCP tools are off until an admin turns them on.** Each tool has a switch on
  its app's MCP tab (Admin > Apps > Details), and the tab's heading says how
  many are on. A tool that is off isn't listed or callable for anyone, from its
  next call, and an app with none on is left off the consent screen, so a
  connection approved then doesn't include it: connect again once a tool is on.
  Switching is audited as `app.mcp.tool.enable` and `app.mcp.tool.disable`.
  When a different extension takes an app's slug, the release step turns its
  tools off again, as it revokes its API keys.
- **A role in a global app is only a role.** When an app stops being global,
  the people who had only a role in it don't keep the app; the people an admin
  granted it to do. Admin > Apps marks the app **Needs grants**, and its
  Access tab lists the people with a role apart from the people with access,
  with **Grant**, which keeps their role, and **Clear role**.
- **Who can reach an app, in one place.** The app dialog's Access tab filters
  between Users, Password-gated, Public and API keys, each with a count. Users
  lists everyone with access, with their role, who granted it and when: grant
  it by name or email with **Grant access**, change a role, revoke it, and
  filter by role. A role the manifest no longer declares is marked **Unknown
  role**. A global app lists everyone, with roles and no grant or revoke.
  Password-gated and Public list the pages and routes each tier reaches, read
  from the route contracts, and Password-gated sets the password, for an app
  that declares `password` in `defineRoute` too. Admin > Users has the same
  controls, through the same actions, and its role select has **Default**: a
  user on it follows the app's `defaultRole`, and changes when it does. A new
  grant starts there. Granting someone who already has the app, or revoking
  someone who doesn't, changes nothing and says so. An app under **Not in this
  build** has **Revoke access…**, for its grants and API keys.
- **API keys can be created.** The Access tab's API keys view makes a key for
  an app's `key` routes: a label, the routes it may call or every key route,
  and an expiry. The key is shown once. Each key lists its routes, who made it
  and when, when it was last used and whether it is active, expired or
  revoked, and Revoke works from its next request. Audited as
  `app.apikey.create` and `app.apikey.revoke`, never with the key.
- **A connector has to be ready before its app is activated or granted.** A
  three-legged OAuth connector with a saved client ID that was never
  connected, and a connector an admin disabled, block both, as an unconfigured
  one does; a user-scoped connector needs only its client ID and secret. The
  tile, the dialog and Admin > Users say what to do: configure, connect or
  enable. For an app that
  is already active, they say it can't be granted until then.
- **Reach tab.** The app dialog's Reach tab lists the app's connectors and,
  under them, the hosts the app's own code may call, its `egress`, or says it
  makes no outbound calls of its own.

## 2026-10-14

- **The install guide is in five parts, in `docs/hosting/`.** Before you
  install (`README.md`), How to install (`install.md`), Running a development
  copy (`development.md`), Install at popular providers (`providers/`: Vercel
  with Supabase, Render, Railway and Self-hosted), and After you install
  (`after-you-install/`: extensions, upgrading, securing and the GitHub App).
- **CI runs the database tests, and Danger fails a committed version bump.**
  `ci.yml` starts a throwaway Postgres 17 for `npm test`, so the suites that
  skip without `MIXOS_TEST_DATABASE_URL` run on every pull request. A pull
  request to `mixoshq/mixos` that changes `"version"` in `package.json` or
  `package-lock.json` fails Danger unless it is the release PR, from
  `release/vX.Y.Z`.

## 2026-10-08

- **Each app's tables are in a schema of its own.** An app with
  `"database": true` gets `app_<slug>`, owned by a database role of its own,
  `mixos_app_<slug>`, which the release step and `npm run migrate:apps` create.
  Write bare table names: `context.db` reads the app's schema. The release
  step's role needs
  `CREATEROLE`, which every supported host's default role has, and a Postgres
  server holds one MixOS database: app roles belong to the whole server.
- **App migrations are checked before they run, and run as the app.** Every
  statement is parsed with Postgres's own parser and checked against what an app
  migration may do: tables, indexes, views, sequences, enum types and their rows
  in the app's schema. Triggers, functions, `DO`, policies, grants, `SET`,
  extensions, anything outside the app's schema, and function calls beyond a
  short list of built-ins fail the build and the release step, with the file
  and line. See `docs/apps/database.md`. An app that ships `migrations/` sets
  `"database": true`, and an app slug is lowercase letters and digits joined by
  single hyphens or underscores.
- **`updatedAt` in `app.json`** lists columns the platform sets to `now()` on
  every update, with its own trigger, since an app migration can't create
  one.
- **An app that leaves the build keeps its data.** The release step and
  `npm run migrate:apps` mark an app the build no longer carries as missing,
  even when the build only skipped it, and keep everything: its grants,
  installs, password, widgets and scheduled jobs. Admin > Apps lists it under
  **Not in this build**. If it comes
  back with the same files it is as it left; with different files it comes
  back inactive and flagged until an admin activates it. The audit log records
  both, as `app.missing` and `app.returned`. Renaming an app's folder makes a
  new app, and the old slug keeps the old data.
- **Registry installs take turns safely.** While another install is running,
  the dialog says so and offers **Try again**. If an install is paused for more
  than 15 minutes (a laptop asleep mid-download) and another starts meanwhile,
  the paused one stops before its next write and says what it left on disk.
- **Registry installs are checked before they land.** An install stages the
  download and checks it with `generate-project-registry.ts --check`, which
  reads its files, runs none of its code, and writes its verdict to a file the
  install names. A refused extension never reaches `apps/`, `connectors/` or
  `themes/`. A generator an install starts gets only `PATH` and `TMPDIR` from
  the environment. Installs also refuse a package with paths that differ only
  in case or Unicode form, a control or bidi character in a path, or a `.git`
  at any depth, and leave out any `.gitignore` or `.gitattributes`. The
  generator skips folders whose names start with a dot.
- **Every build knows its version.** The admin pages show it with the commit,
  e.g. `MixOS 0.4.2 · commit 3e1f0a2`. The version is `package.json`'s, stamped
  into every build. The commit comes
  from Vercel, Render and Railway's own variables; on Docker Compose, build with
  `MIXOS_COMMIT=$(git rev-parse HEAD)`, and on Coolify set
  `MIXOS_COMMIT=$SOURCE_COMMIT`. See
  `docs/hosting/after-you-install/README.md#which-build-is-running`. An
  extension's `requiresMixOS` is checked in a checkout too, against
  `package.json`: bump it locally to try an extension that needs a newer MixOS,
  but don't commit the bump, which `/mixos deploy` leaves out.
- **A built deployment browses mixos.org.** The Docker image on any host, and
  Vercel, ignore `MIXOS_REPOSITORY_URL` unless it names their own machine
  (`localhost`, `127.0.0.1`, `[::1]`, `host.docker.internal`), and log it. A
  source checkout honours the override.
- **Releases.** A version of MixOS is an annotated tag `vX.Y.Z` on `main` with
  a GitHub Release, whose notes are its section of `CHANGELOG.md`.
  `/mixos deploy release` opens the release PR, which sets the version in
  `package.json` and writes that section from the Conventional Commits since
  the last release (`scripts/release-prep.ts`). Once it merges, run it again
  for the commands that tag the merge commit and publish the GitHub Release,
  which a person runs. To upgrade a deployment, merge the newest release tag
  into your fork rather than `upstream/main`
  (`docs/hosting/after-you-install/upgrading.md`). Prereleases are `vX.Y.Z-rc.N`.
- **Two platform migrations can't share a number.** The ledger records a
  migration by its number, so of two files with one number, one would be
  skipped. The release step and `npm run db:migrate` apply nothing then, the
  build and `npm run dev:docker` stop, and Danger fails a PR that adds a number
  already on `main`, each naming both files and the next free number. If a
  merge brings in a migration with your number, rename yours to the next free
  number and change its `platform_schema_version` value to match.
- **A maintenance page while the database is behind.** When the platform
  schema is behind the build, every page shows a plain maintenance page and
  every API route, `/api/cron`, `/api/webhooks` and `/api/mcp` included,
  answers 503 with `Retry-After: 30` until the release step runs. Only
  `/api/health/live` and `/api/health/ready` answer as usual. Locally,
  `npm run db:local` brings it back. `/api/health/ready` returns `status` and
  `reason`; the server log has the detail.
- **Vercel production builds run the release step.** `vercel.json` makes
  `npm run vercel-build` the build command: `npm run build`, then the release
  step when `VERCEL_ENV` is `production`, over Neon's `DATABASE_URL_UNPOOLED`
  when it names the same database. Preview builds never run it. A build that
  doesn't compile leaves the database alone, and a failed release step fails
  the build, so the previous deployment keeps serving. Set
  `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD` on the project and the
  first deploy creates the admin. Migrations have to work with the deployment
  still serving: add in one release, remove in a later one. See
  `docs/hosting/providers/vercel-supabase.md`.
- **`scripts/smoke-test-app.ts` tests real routes.** It reads routes from the
  generated registry and tests every app, or the slugs you name, with GET and
  HEAD only. Sign in with `SMOKE_EMAIL` and `SMOKE_PASSWORD`, or `SMOKE_COOKIE`;
  `--base-url` points it at another server. Activate and grant an app first:
  one that isn't is reported, not worked around. It exits 1 when a route
  fails or can't be reached, and its last line is a JSON verdict.
- **A deactivated app runs nothing.** None of its modules is imported while it
  is off: its API routes, over HTTP or through `callAppRoute()`, its jobs,
  syncs, services and `hooks.ts`. Run now refuses its jobs, which Scheduled
  Jobs shows as **App inactive**, and a consumer calling one of its services
  gets `PROVIDER_INACTIVE`. Activating it takes effect on the next request,
  with no restart. Run now, a job's Enable and Disable, and Start and Stop
  tick are audited, as `app.job.run`, `app.job.enable`, `app.job.disable`,
  `scheduler.start` and `scheduler.stop`.
- **Disable a connector.** Admin > Connectors has Disable and Enable on each
  connector. Disabling names the apps that use it and asks first. While it is
  off, apps' calls to it fail with "disabled by an administrator", and its
  webhooks, Connect and Test Connection are refused. Its credentials are kept.
  The audit log records `connector.disable` and `connector.enable`, and
  `theme.apply` too. See `docs/connectors/credentials.md`.
- **The Docker image is read-only to the server.** Its files are owned by root,
  so the server can't change its own code on any host, and
  `deploy/docker-compose.yml` runs `app` and `migrate` on a read-only root
  filesystem, with Next's caches and `/tmp` on `tmpfs`. Something you add that
  writes at runtime needs a mount; see
  `docs/hosting/providers/self-hosted.md#whats-read-only`.
- **An app whose migrations are behind waits on its own.** While the build
  carries an app migration the database hasn't applied, none of that app's
  code runs, and it alone says "This app is being updated. Try again shortly.":
  its pages and API routes with a 503 and `Retry-After: 30`, `callAppRoute()`
  as `UNAVAILABLE`, its MCP tools as `APP_UPDATING`, and its services as the
  new `PROVIDER_UPDATING`. Its jobs wait and stay due, and Scheduled Jobs shows
  **App updating**. Every other app serves, and readiness still reports
  `app-migrations-behind`. It serves again within 30 seconds of the release
  step, or of `npm run migrate:apps` after you add a migration locally.
- **An install's check reads routes.** A Registry install reads each route's
  `defineRoute({...})` options from its source, without running it, and
  refuses a bare handler, a role the app doesn't declare, or `raw: true`
  without its escape, in the build's own words. Options it can't read as
  written, such as ones built from a variable, a spread or another file, are
  listed as checked at registration, which loads the route.
- **Registry installs wait for you to register them.** Installing an app or a
  connector from Browse puts it in `.mixos/pending/`, where nothing runs it,
  instead of in `apps/` or `connectors/`. Register it in your checkout with
  `npm run register -- app/<slug>`, or the slug alone: it checks the folder
  still matches what was verified, moves it into place and runs the registry
  generator, which is when its code first runs, and puts it back in pending if
  the generator refuses it. Then commit the folder and deploy. On its own,
  `npm run register` lists what is waiting; `--discard` drops one, `--recover`
  tidies up after one that stopped midway, and `--break-lock` asks before
  clearing a stuck lock. A theme registers when it is installed.
  Installs, registrations and the registry generator take turns through
  `.mixos/lock`, so `npm run dev` or `npm run registry` waits while one runs.
  In the audit log an install is `<kind>.install`, and `<kind>.register` is
  registering a pending one; `npm run register`'s rows name
  `cli:<user>@<host>`, with no user id, and show as unverified.
- **Register and Discard in Admin.** Admin > Apps and Admin > Connectors list
  what is waiting in `.mixos/pending/`, with **Review and register** and
  **Discard**. The review shows what will run (`hooks.ts`, `api/`,
  `widgets.ts`, `jobs/` and migrations), what install's check left to
  registration, the manifest's declarations beside the publisher's claims,
  whether your MixOS version meets the release's floor, and a link to the
  source at the installed commit. Register waits until you confirm you've read
  it. Afterwards, **Activate in this checkout** is offered only when the
  checkout's database is on the same machine; otherwise activate the app on the
  instance that serves it. A deployment that runs a build says to install and
  register in a checkout, commit, and deploy.
- **Installs keep a record in the extension's folder.** An install from the
  Registry writes `.registry.json` into the extension's folder: the catalogue
  it came from, the release, its commit and the hashes that were verified. It
  waits in pending with the extension and is committed with it, and a package
  that ships its own is refused. The pending sidecar keeps only who installed
  it, when, and the check's verdict. The registry generator writes
  `src/generated/registry-installs.ts` from the records, and marks an extension
  modified when its files no longer match. Browse says where an installed one
  came from: "Installed from mixos.org · 1.2.0" (with "modified locally"), "A
  local extension uses this name", or "Installed from <host>; not checked
  here". After Register, the result and `npm run register` list the files
  added, give a commit message built from the record and the commands to
  commit and push it, link to the source at the verified commit, and say what
  shipping means on each host. The pre-commit stamp leaves installed folders
  alone.
- **Fix:** a seed `insert ... on conflict` in an app migration works, and
  `my-app` and `my_app` don't share tables.
- **Fix:** a connection string that doesn't parse is reported by its variable's
  name, and the release step and the app don't print it, password included.
- **Fix:** sign-in attempts are limited on every route that checks a password,
  including Auth.js's own callback, and those routes share one budget per IP.
- **Fix:** the password re-checks, webhooks and MCP bearer checks are limited,
  and a wrong password takes as long for an email with no account as for one
  with. "Change my password" and setting a user's password share one budget
  per person, and a webhook body over 5 MiB is refused.
- **Fix:** app API routes get request bodies over 10 MB whole. Up to 27 MB, a
  body reaches a route on `/api/apps` or `/api/p` exactly as sent, and a larger
  one gets a 413, with or without a `content-length`. Without a session cookie,
  `/api/apps` answers with a JSON 401 or 404, not a redirect to `/login`.
- **Fix:** `/api/analytics/track` and `/api/analytics/app-open` record an event
  only for an app the user holds, while it is active and not being updated.
  Any other event gets a 404, as an app that doesn't exist does, and records
  nothing. The audit log records an admin connecting a tenant connector through
  OAuth, as `connector.connect`, with the scopes the provider granted.
- **Fix:** Registry search, listings and install manifests follow at most three
  redirects, and only within the catalogue's own origin. Any other redirect,
  such as one to another host or from https to http, is refused with an error
  naming the catalogue.
- **`/mixos deploy` leaves a version bump out.** A change to `"version"` in
  `package.json`, or to the version in `package-lock.json`, stays out of its
  commits and is listed under "Left out". Only a release PR changes the
  version: a committed local bump makes `scripts/release-prep.ts` refuse the
  next release.
- **Fix:** the headers of Admin > Apps, Connectors, Themes, Analytics and the
  Browse pages fit a phone or tablet screen. Below 1024px wide, the buttons sit
  under the title and wrap.
- **Fix:** an extension whose repository has a `.gitignore` can be installed.
  Installs leave out a `.gitignore` or `.gitattributes` at any depth, in any
  case, and install the rest. The content hash is checked over the package as
  published, and the
  files hash in `.registry.json` covers what was written. The install result,
  `npm run register` and the install's audit row say what was left out. A
  `.git` or a `.registry.json` is refused.
- **A different extension under the same name starts off.** The release step
  and `npm run migrate:apps` record where each app, connector and theme came
  from: the catalogue and GitHub repository in its `.registry.json`, or local.
  A new release from the same repository is an update and changes nothing.
  Anything else, such as a local app reinstalled from the Registry or a
  release from another repository, is caught at every release step. An app is
  switched off, marked **Replaces a different extension** on Admin > Apps, and
  loses its API keys; activating it needs its slug typed. A connector is
  disabled, keeping its credentials, until an admin enables it by typing its
  name. A theme's change is only recorded. The audit log records each as
  `<kind>.identity.changed`, with both identities.
- **The build checks each installed extension's MixOS floor.** When an
  extension's `.registry.json` says it needs a newer MixOS than the version
  being built, `package.json`'s, the registry generator stops the build, naming
  the extension, its floor and the version: upgrade MixOS, or install an older
  release of the extension. A local extension isn't checked, and a floor that
  isn't a version is a warning, as at install. The install dialog and the
  review before Register say whether this checkout meets a release's floor:
  "Requires MixOS 0.5.0 or newer. This checkout runs 0.4.2, which doesn't meet
  it." To try one before its MixOS is released, bump `package.json` locally,
  and don't ship the extension until that release is merged.
- **Withdrawn releases reach the instances running them.** Once a day the tick
  asks mixos.org about the extensions installed from it. Admin > Apps,
  Connectors and Themes then show a release its publisher withdrew, with the
  reason and, for an app, a **Deactivate** button; a newer release; a listing
  no longer published; and when mixos.org last answered. It sends a random
  instance ID and each extension's kind, slug and version, nothing else, and
  acts on nothing. `MIXOS_UPDATE_CHECK=false` turns it off. See
  `docs/hosting/after-you-install/README.md#what-mixos-sends-to-mixosorg`.
- **Smoke-test an app as you register it, and in every pull request that
  changes one.** `npm run register -- app/<slug> --smoke` registers the app,
  then runs its migrations, activates it, grants it to the user you sign in as
  (`SMOKE_EMAIL` and `SMOKE_PASSWORD`, or `SMOKE_COOKIE`) and runs
  `scripts/smoke-test-app.ts` against your dev server. It reports and never
  rolls back. It refuses a database that isn't on your machine unless you pass
  `--database-is-disposable`, and an app that replaces a different extension
  unless you pass `--confirm-replaces <slug>`. A new workflow,
  `.github/workflows/extensions.yml`, fails a pull request that changes
  `apps/`, `connectors/` or `themes/` when an installed folder no longer matches
  its `.registry.json`, or when a changed app fails the smoke test on a fresh
  instance. It has read-only access and no secrets. See
  `docs/hosting/after-you-install/README.md#the-pull-request-check`.
- **The admin pages say when a newer MixOS is out.** Once a day the tick reads
  mixos.org's list of MixOS releases, an anonymous `GET` that sends nothing
  about the instance and that mixos.org doesn't record. When a newer release
  is out, the top of every admin page says so: "MixOS 0.5.0 is available (this
  instance runs 0.4.2). A minor release: it may need changes." Its notes are
  collapsed, with links shown as text, and the notice links to the release's
  page on mixos.org and to the upgrade guide. Nothing is applied for you.
  `MIXOS_RELEASE_CHANNEL=prerelease` adds prereleases, and
  `MIXOS_UPDATE_CHECK=false` turns this check off too. See
  `docs/hosting/after-you-install/README.md#new-releases-of-mixos`.
- **Remove an extension's code.** Admin > Apps, Connectors and Themes have
  **Remove** on each tile, and `npm run remove -- <kind>/<slug>` does the same
  in a checkout. It says first what goes and what stays, then moves the folder
  to `.mixos/backup/`, regenerates the registry without it, and deletes it, or
  puts it back if the generator fails. It is refused while an app requires the
  connector or uses the app's services or hooks, and for the last theme, and it
  warns about an app that uses the connector optionally and about the applied
  theme. The data stays in each database. It hands back the commit that
  deletes the folder, `.registry.json` included. The audit log records
  `<kind>.remove`, and `npm run remove -- --recover` puts back one that stopped
  midway. The registry generator also deletes its copies in `public/` of an
  extension that is gone.
- **Delete an extension's data.** Admin > Apps and Admin > Connectors list
  under **Not in this build** what the database keeps for an app or a
  connector the build no longer has, each with **Delete data…**: destructive,
  with its name typed. Keeping is the default. For an app it drops the schema
  and database role and deletes its rows, grants and settings; for a connector,
  its credentials and every user's connection. It is refused while the build
  serving the instance has it, until a release step has run without it, and
  while another build that used the database in the last 24 hours has it. The
  release step marks a connector its build lacks, as it does an app, and
  each build records which apps and connectors it carries at its release step,
  when its server starts and on the cron tick. The Remove dialog adds **Remove
  code and delete this checkout's data**, under the same checks. The audit log
  records `<kind>.data.delete`, `connector.missing` and `connector.returned`.
- **Link your repository on Admin > GitHub.** An admin creates a private GitHub
  App from the page, installs it on the one repository the instance is built
  from, and finishes linking. The instance refuses an installation on every
  repository, on more than one, or on upstream MixOS, and checks again before
  every operation, turning the link off if the installation was widened. The
  App can't change workflows and gets no webhook events. Its private key is
  stored encrypted under `GITHUB_APP_ENCRYPTION_KEY`; without that key the
  page stays off. `npm run keys:generate -- --github-app` prints one, and
  `npm run keys:rotate-github-app` re-encrypts the stored key when you rotate
  it. Unlink uninstalls the App from GitHub before forgetting it. Linking,
  unlinking, replacing the key and the link turning off are audited. See
  `docs/hosting/after-you-install/github-app.md#linking-your-github-repository`.
- **Preparing an update of an extension.** Install has an update mode: it
  downloads any release of an app or a connector installed from mixos.org,
  verifies and checks it as an install does, and leaves it in
  `.mixos/pending/` with a record of what it replaces. The folder in place
  isn't touched. Local changes to the folder, found from its `.registry.json`,
  an older release and a withdrawn one each need an explicit yes. An update
  dialog lists the releases with their dates and shows what the chosen one
  changes: the publisher's claims, what its manifest declares, new migrations,
  or for an older release the ones it lacks, and which files were changed
  locally. The audit log records `<kind>.update`.
- **Propose an extension as a pull request.** With the GitHub App linked, a
  deployment's Browse pages offer **Propose to owner/repo**. The instance
  verifies the release in memory and opens a pull request that adds its folder,
  on `mixos/install/<kind>-<slug>`; merging it is the deploy. It refuses,
  naming the file, while a workflow would run that pull request with a secret
  or a write token, or `render.yaml` or, on Vercel, `vercel.json` would build a
  preview of it. It also needs the pull request rule, and an admin's
  confirmation on Admin > GitHub that no host builds previews of the App's
  branches. Admin > Apps, Connectors and Themes list the App's open pull
  requests with their checks, including "No CI ran" and "Changed since
  proposed". `vercel.json` turns off deployments of `mixos/**`,
  `render.yaml` turns off the web service's previews, Danger skips App
  branches, and CI checks out without keeping its token. See
  `docs/hosting/after-you-install/github-app.md#proposing-an-extension`.
- **Updating an extension, in place.** Register puts a pending update in
  place: it moves the folder to `.mixos/backup/`, puts the new release there,
  runs the registry generator, and deletes the backup once the generator
  accepts the new release, or puts the old one back if it doesn't. It refuses
  a folder that changed after the update was prepared. A theme is swapped the
  same way as it installs. The review before Register shows what the update
  changes, from the two folders on disk; the result says what carries over
  (an app's activation, grants and settings, a connector's credentials), to
  run new migrations, and that `npm run dev` may need a restart, and hands
  back the change to commit and how to roll it back. **Update** is on each
  withdrawn or newer notice on Admin > Apps, Connectors and Themes, and on a
  Browse listing of an installed extension; a built deployment links to the
  hosting guide. `npm run register -- --recover` deals with an update that
  stopped midway, asking whether to restore the old release or keep the new
  one. The audit log records the swap on `<kind>.register`, a theme's as
  `theme.update`, and recovery as `<kind>.update.recover`. See
  `docs/hosting/after-you-install/README.md#updating-an-extension`.
- **MixOS update pull requests.** With the GitHub App linked and the
  repository a fork of `mixoshq/mixos`, the release notice offers **Open an
  update pull request**. It first asks GitHub whether upstream's tag is at
  the release's commit and on upstream's `main`; if GitHub can't confirm it
  (it answers 404 while upstream is private), or the release changes a
  workflow, nothing is opened and the notice gives the compare link to merge
  by hand. Otherwise it creates `mixos/update-<tag>` at that commit and opens
  a pull request with the notes as text, GitHub's numbers and the upgrade
  checklist. The App can write only that branch and that pull request for
  it, and never merges. A private copy gets the `git fetch upstream --tags &&
  git merge <tag>` steps instead. Admin > GitHub lists open update pull
  requests with their checks. Audited as `mixos.update.propose`. See
  `docs/hosting/after-you-install/github-app.md#updating-mixos-through-the-app`.
- **Propose an update or a removal as a pull request.** With the GitHub App
  linked, a deployment's withdrawn and newer notices and its Browse cards
  offer **Propose update**, and the Remove dialog offers **Propose removal**,
  for an extension the build installed from mixos.org. The dialog shows the
  update dialog's comparison and the same checks as a proposal, then opens a
  pull request that replaces the folder on `mixos/update/<kind>-<slug>`,
  deleting what the new release lacks, or deletes it on
  `mixos/remove/<kind>-<slug>`. First the folder on the default branch has to
  be what this build runs, file for file; a removal is refused while an app
  requires the connector or uses the app's services or hooks, and for the
  last theme. The data stays on each instance until an admin deletes it
  there. Rolling back is reverting the merge. Admin > Apps, Connectors and
  Themes list these pull requests with their checks beside the installs.
  Audited as `<kind>.propose` with `action: "update"` or `"remove"`. See
  `docs/hosting/after-you-install/github-app.md#proposing-an-extension`.

## 2026-10-07

- **Runs on any Postgres.** A query builder (`src/lib/db/query.ts`) runs every
  query over `DATABASE_URL`, with supabase-js's method names and
  `{ data, error }` results. `docs/apps/database.md` lists its surface.
- **Hosting guides** in `docs/hosting/`: your own server with Docker Compose
  (`deploy/`, which Coolify and Dokploy can also deploy), a Render Blueprint
  (`render.yaml`), Railway (`railway.json`), and Vercel with Neon, Supabase or
  any Postgres.
- **`npm run db:migrate`** applies the platform schema to any Postgres. It
  shares the Supabase CLI's migration ledger, so it and `db:push` can be mixed.
  **`npm run release`** runs everything a deploy needs, and the Docker image
  carries the same step as `node ops/release.cjs`.
- Platform keys may be base64 as well as hex, so hosting platforms can
  generate them.
- **`INSTALL_APPS`, `INSTALL_CONNECTORS`, `INSTALL_THEMES`** (default `true`).
  Set one to `false` and that kind's Browse page and button disappear, and its
  install actions refuse. The instance runs only what it was deployed with.
  See `docs/hosting/after-you-install/README.md#fixing-what-an-instance-runs`.
- **Brand hooks.** An app can change the install's name and marks
  (`brand-name`, `menu-bar-logo`, `login-logo`) from an
  `apps/<slug>/hooks.ts` entrypoint, declared in `app.json` under `branding`;
  the build fails if the two disagree. A theme claims a slot outright with its
  own `branding` block. See `docs/apps/hooks.md#brand-hooks`.
- **Theme logos are measured.** An SVG `assets.logo` needs a `viewBox` (or an
  absolute `width` and `height`), and anything else must be `.png`, `.jpg` or
  `.webp`, or the build fails.
- **`npm test`** runs the unit tests (`*.test.ts` under `src/` and `scripts/`)
  with Node's built-in runner, and CI runs it after typecheck.
- **`raw-response` is the only app escape, and it is required.** A route with
  `raw: true` registers only when `app.json` declares
  `escapes: [{ "rule": "raw-response", "reason": "…" }]`, and an admin sees the
  declaration and its reason in the app's details. A manifest naming any other
  rule fails the build.
- **App containment is enforced by the build, not just lint.** The registry
  generator reads every app's source on every build and every Registry install,
  and skips an app that references `process`, raw network access (`fetch`,
  `WebSocket`, the `http`/`net` modules, HTTP client packages), an HTML sink
  (`dangerouslySetInnerHTML`, `innerHTML`, …), `eval` or `new Function`. Each
  finding names the file and line.
- **`Markdown` for text you did not write.** `@/components/ui/markdown` renders
  GitHub-flavoured Markdown with raw HTML dropped and `javascript:` links
  blanked, styled from the theme's tokens.
- **Route output is validated on every response**, in every environment.
- **Theme checks that fail the build:** a custom property outside the
  top-level `:root` (in a `.mix-*` rule, or a `:root` inside `@media` or
  `@supports`), a colour token the build cannot evaluate or that is
  translucent, a `var()` naming a token `:root` never sets, and an
  `@font-face` missing from `fonts[]`. Only `--border` may be translucent; the
  build composites it over `--background`.
- **The colour fence covers app widgets and pages.** Raw palette classes, an
  opaque `bg-white` / `bg-black` and `dark:` variants are lint errors in
  `apps/**/*.tsx`.
- **The contrast lint rule checks every installed theme**, not only `mixos`,
  and names each theme an element fails under.
- **`npm run lint` generates the registry first**, so the contrast rule has
  theme tokens to read in CI.
- **The theme picker shows `assets.preview`** above the theme's swatch row,
  cropped to 16:9 from its top-left corner.
- **More manifest rules fail the build.** A `sync` needs `"database": true`
  and a `budgetMs` of at most 200000, because the scheduler stops a run at 240
  seconds. Role keys must be unique. A `widgets.ts` that disagrees with
  `app.json` fails the build.
- **`ctx.signal` for route handlers.** It aborts when the caller disconnects or
  the route's `budget.ms` runs out. Pass it to connector calls and
  `context.http.fetch` so the work stops, not just the wait.
- **`signed-in` pages.** A page whose `pageVisibility` accepts `signed-in` opens
  for any signed-in user, without the app's grant.
- **Required widget fields.** The config modal won't save while a field marked
  `required` is empty, and says which field.
- **Untagged releases install.** A release published from the mixos.org website
  has no git tag, and installs pinned to its commit like any other.
- **Cross-app hooks are checked where they're used.** The build skips an app
  that listens to another app's hook without `listensTo`, or fires another
  app's hook, and the registrar refuses both at runtime. The bare `hooks` from
  `@/lib/hooks` takes core hooks only. Listeners follow their app's activation,
  checked each time a hook fires.
- **App settings** are filled in on the Settings tab of an app's details in
  Administration → Apps. `password` values are encrypted when saved and never
  shown again.
- **App code imports from a published list.** An app imports its own files,
  the platform modules listed in `docs/apps/architecture.md` (some by name
  only), and `react`, `zod`, `lucide-react`, `next/link`, `next/navigation` and
  `next/font/*`. Types may come from anywhere. The registry generator judges
  each import by the file it lands on, on every build and every Registry
  install, and skips an app that imports anything else; ESLint shows the same
  findings.
- **Refused in app code:** Node built-ins, `require` and `module`, an
  `import()` with a computed name or a URL, code in a dot-folder or `assets/`,
  a symlink, `node_modules/` or `package.json` anywhere in an app, and writes
  to an imported module.
- **`callAppRoute` takes the app's own slug** as a string literal. The build
  refuses another app's slug, one built at runtime, and any other use of it.
- **Fix:** per-user connector scope status is saved.
- **Fix:** a deactivated app's `/p` pages return 404, as its API routes do.

## 2026-10-05

- **Local Docker on Linux and Windows.** `npm run dev:docker` and `/mixos init`
  run on macOS, on Linux (Docker Engine) and on Windows through WSL 2 (Docker
  Desktop with its WSL integration). On Linux and in WSL the dev container
  writes the checkout as you rather than as root. The cron sidecar reaches the
  app over the compose network, so each instance's cron calls its own app.
- **Contributing terms.** `CONTRIBUTING.md` asks for a DCO sign-off on every
  commit (`git commit -s`) and the MPL notice on every new platform file.
  `TRADEMARK.md` sets out what forks, extensions and hosting services can be
  called.
- **Node 24.** `.nvmrc`, the Docker images and CI run Node 24. 22 is the
  minimum, until it reaches end of life on 30 April 2027. `npm run dev`,
  `build`, `typecheck`, `dev:docker` and the pre-commit hook stop on an older
  Node with an explanation. When a newer Node is installed but hidden from the
  shell, they say where it is and how to put it first. The README has a
  requirements table.


## 2026-09-23

- **Listing screenshots.** An app or theme can ship a gallery for its catalogue
  listing: put images in `apps/<slug>/screenshots/` (or `themes/<slug>/`) and
  declare them in the manifest as `screenshots: [{ file, alt?, caption? }]`. The
  build verifies each file, measures it, and fills in `url`, `width` and
  `height` — never write those by hand. `.png`/`.jpg`/`.webp` only (no SVG: a
  screenshot is a raster, and an SVG is a script-bearing document served from an
  unauthenticated URL), max 8, 2 MB each, 640px wide minimum. Only declared
  files are published, so a draft left in the directory stays local.
- **An app serves nothing until it is activated.** A newly registered app
  arrives INACTIVE and an admin turns it on from the Apps page. Deactivating is
  a switch rather than a deletion: grants, installs, passwords and dashboard
  widgets all survive it, and reactivating puts everyone's dashboard back as
  they left it. The vocabulary split follows — an admin *installs* an app on the
  instance, a user *enables* it for themselves.
- **A checkout can be its own instance.** Copy `.env.instance.example` to
  `.env.instance` and give it a `MIXOS_INSTANCE`, a `MIXOS_PORT` and a
  `MIXOS_SUPABASE_PORT_BASE`, and that checkout boots its own compose project,
  its own Supabase stack and its own database, alongside an existing one. This
  is what makes it possible to author an extension in one tree and install it
  from the catalogue into another, which registration otherwise refuses because
  the directory already exists. Without the file, a checkout is `mixos` on
  port 3000 with Supabase on 54321. `supabase/config.toml` reads its project id
  and ports from `env(...)`, so reach the CLI through
  `npm run supabase -- <command>`; a bare `supabase …` resolves an empty project
  id.

## 2026-09-13

- **`app.json` is the only app manifest form.** A manifest that is static text
  can be schema-checked *before* any of the package executes, and a manifest
  that is a module has to be imported before there is anything to validate —
  the wrong order for a package that just arrived from the Registry. Widget
  `config` arrays built from preset helpers go in an optional `widgets.ts`
  beside it, default-exporting an object keyed by each widget's `component`
  path. The generator refuses to guess when the two disagree: a key matching
  no widget is an error, and so is a widget declaring `config` in both files.
  Plain config needs no `widgets.ts` at all — leave it inline in the JSON.

- **Connectors and themes get listing metadata and a `README.md`.** Both
  manifests take the same optional catalogue fields as apps —
  `tagline`, `keywords` (max 10, lowercase, no duplicates), `license`, and a
  pair of URLs (`connectorUrl` / `connectorSupportUrl`, `themeUrl` /
  `themeSupportUrl`). Alongside them, an optional `README.md` at the extension's
  root is its long-form description on the public listing, as for apps.
  Templates ship both, filled in as placeholders.

## 2026-08-29

- **Six independent platform keys.** Each purpose has its own environment
  variable with a bounded blast radius, so each key rotates alone. Generate
  them with **`npm run keys:generate`** (or `--missing` to fill gaps), and check
  a deployment with **`npm run keys:check`**. Local Docker has them in
  `.env.docker`.

- **Lint gates PRs, and CI audits dependencies.** That matters more than
  style: `eslint.config.mjs` is where the client/server boundary is enforced —
  no raw `fetch` in app code, no `process.env`, no connector or DB client
  outside the server tier — so a lint error fails the PR. An `npm audit` step
  runs beside it.

- **Connector scopes live in `connector.json`.** `auth.scopes` is the
  provider's whole documented catalogue, each entry flagged with whether this
  connector asks for it, and only
  `npx tsx scripts/check-scopes.ts <name> --write` writes it — so a provider
  quietly adding a write scope shows up in a diff rather than in a database row
  an admin populated by pressing a button. What the provider *actually granted*
  is recorded per-scope at the OAuth callback, which is the only moment it can
  change. `icon` is a full path (`"assets/icon.svg"`).

- **Admin actions are recorded**: who configured a connector, who granted a
  person access to an app, who set the password on a public page, on a
  platform whose admins hold every third-party credential in the deployment.
  Values are never logged, only which keys were set.

- **Sessions can be revoked one user at a time.** A `session_version` counter
  carried in the JWT and compared on every session resolution, so "this person
  left" doesn't mean rotating `AUTH_SECRET` and signing out everybody.


## 2026-08-28

- **Themes are a first-class abstraction.** `themes/<slug>/` sits beside `apps/`
  and `connectors/`, with its own manifest, guide and **`/mixos theme`** command.
  A theme declares **exactly one palette**: light is what an install gets by
  default, and a dark look ships as a *separate installable theme*
  (`mixos-dark`) rather than a mode you switch inside the current one.

- **`/mixos convert`** turns an existing application into a MixOS app under
  `apps/`.

- **Connectors carry their own setup guide.** `connector.json` has a
  structured `setup` block — the provider-side steps, links, and a note that can
  hang off each of the registry's own "save credentials / connect / verify"
  buttons, including this deployment's redirect URI. `description` is capped
  at 140 characters and describes *the service*; provisioning prose belongs in
  `setup`. A connector can also ship `assets/icon.png` for its registry tile.

- **Per-user connectors.** A connector may declare `"userScoped": true`
  (three-legged OAuth only). Each person then authorizes their own account at
  **Account → Connections**, instead of everyone sharing the one grant an admin
  connected. The client ID and secret stay tenant-wide — the *application* is
  registered once, only the *grant* is personal.


## 2026-08-24

- **Local development runs in Docker.** One command brings up Supabase
  (Postgres, PostgREST, Studio), applies every migration, seeds the admin user
  and starts the app:

  ```bash
  npm run dev:docker     # hot reload; streams the container logs
  npm run docker:prod    # production-parity build, same ports
  npm run docker:down    # stop everything, keep your data
  npm run docker:reset   # stop everything and DELETE the local database
  ```

  `dev:docker` stays in the **foreground** — Ctrl-C ends the session and stops
  the app container, while the Supabase containers keep running. When you need
  it to return instead (a script, or an agent driving your setup), use
  `npm run dev:docker -- --detach`: it brings the stack up in the background,
  polls `/api/health/ready` until it answers 200, prints the banner and exits.
  `--detach` composes with `--prod`. Reference:
  [docs/local-docker.md](docs/local-docker.md).

- **`.env.docker` is committed**, so a fresh clone has nothing to generate:
  every value in it is a public, dev-only placeholder, the admin login
  included. The database URL is written to `.env.docker.local` on each boot
  from `supabase status`, so there is no dashboard to visit either. Never reuse
  a value from `.env.docker` anywhere reachable from the internet.

- **Use `npm run db:local` for the local schema, not `npm run db:push`.**
  `db:push` targets the *linked remote* project, so reaching for it to repair
  your laptop can silently push migrations at a cloud database. You rarely need
  either: `npm run dev:docker` already applies the platform migrations
  (`db:local`) and then the app migrations (`npm run migrate:apps`) on every
  boot. See [docs/apps/database.md](docs/apps/database.md).

- **Scheduled jobs tick locally.** A `cron` sidecar in `docker-compose.yml`
  runs under both profiles and GETs `/api/cron` every 5 minutes with the same
  bearer header Vercel Cron sends, so the scheduler exercises the production
  path rather than a dev-only timer. Watch it with
  `docker compose -p mixos logs -f cron`.
  `npx tsx scripts/run-scheduled-jobs.ts` works, on either path, for when
  you don't want to wait up to five minutes for the next tick. See
  [docs/apps/scheduled-jobs.md](docs/apps/scheduled-jobs.md).

- **The standalone scripts find the Docker stack on their own.**
  `npm run migrate:apps`, `npm run seed-admin` and
  `npx tsx scripts/run-scheduled-jobs.ts` share
  [`scripts/load-env.ts`](scripts/load-env.ts), which falls back to
  `.env.docker` + `.env.docker.local` and rewrites `host.docker.internal` to
  `127.0.0.1` (a container address does not resolve from your shell). The
  fallback is skipped entirely when `.env.local` exists, so the hosted path is
  untouched — importantly, `.env.docker`'s `PGSSLMODE=disable` must never leak
  into a connection to a hosted database.

- **Fix:** `/api/cron` is on the proxy's public-route list, so the tick reaches
  the route's bearer check, in production as well as locally, rather than a
  redirect to `/login`. The timing-safe `CRON_SECRET` comparison in
  `src/app/api/cron/route.ts` is the real gate.

- **Publishing is automatic — there is no publish command.**
  `.githooks/pre-commit` runs
  [`scripts/stamp-updated.ts`](scripts/stamp-updated.ts), which stamps
  `lastUpdated` on every app or connector with a file in the commit and
  re-stages the manifest, so the date in the App Manager and Connector Registry
  always matches the last commit that touched it. Preview what would be stamped
  with `npx tsx scripts/stamp-updated.ts --dry-run`. The hook is activated by
  `core.hooksPath`, which the `prepare` script sets on `npm install`.
