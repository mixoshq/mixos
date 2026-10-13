# What's new in MixOS

Recent, developer-facing changes — newest first. When you ship something worth
announcing (a new command, a workflow change, a breaking change), add a short
`## <date>` section at the top. Keep entries brief; this is not a full changelog.

The newest section is shown automatically after you `git pull` (via the
`.githooks/post-merge` hook), but only when this file was among the commits you
just pulled.


## 2026-10-08

- **Each app's tables are in a schema of its own.** An app with
  `"database": true` gets `app_<slug>`, owned by a database role of its own,
  `mixos_app_<slug>`, which the release step and `npm run migrate:apps` create.
  The `_app_<slug>_` table prefix is gone: write bare names, as before, and
  `context.db` reads the app's schema. The release step's role needs
  `CREATEROLE`, which every supported host's default role has, and a Postgres
  server holds one MixOS database: app roles belong to the whole server.
- **App migrations are checked before they run, and run as the app.** Every
  statement is parsed with Postgres's own parser and checked against what an app
  migration may do: tables, indexes, views, sequences, enum types and their rows
  in the app's schema. Triggers, functions, `DO`, policies, grants, `SET`,
  extensions, anything outside the app's schema, and function calls beyond a
  short list of built-ins fail the build and the release step, with the file
  and line. See `docs/apps/database.md`. **Breaking:** an app that ships
  `migrations/` must set `"database": true`, and an app slug must be lowercase
  letters and digits joined by single hyphens or underscores.
- **`updatedAt` in `app.json`** lists columns the platform sets to `now()` on
  every update, with its own trigger, since an app migration can no longer
  create one.
- **An app that leaves the build keeps its data.** The release step and
  `npm run migrate:apps` used to delete an app the build no longer carried,
  with its grants, installs, password and widgets, even when the build had only
  skipped it. They now mark it missing and keep everything, scheduled jobs
  included, and Admin > Apps lists it under **Not in this build**. If it comes
  back with the same files it is as it left; with different files it comes
  back inactive and flagged until an admin activates it. The audit log records
  both, as `app.missing` and `app.returned`. Renaming an app's folder makes a
  new app, and the old slug keeps the old data. Migration 0010; run
  `npm run db:local` to apply it.
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
  generator now skips folders whose names start with a dot.
- **Every build knows its version.** The admin pages show it with the commit,
  e.g. `MixOS 0.1.0 · commit 3e1f0a2`. The version is `package.json`'s, stamped
  into every build, and `MIXOS_RELEASE` is no longer read. The commit comes
  from Vercel, Render and Railway's own variables; on Docker Compose, build with
  `MIXOS_COMMIT=$(git rev-parse HEAD)`, and on Coolify set
  `MIXOS_COMMIT=$SOURCE_COMMIT`. See `docs/hosting/README.md`. **Breaking:** an
  extension's `requiresMixOS` is now checked in a checkout too, against
  `package.json`; bump it locally to try an extension that needs a newer MixOS,
  but don't commit the bump: `/mixos deploy` leaves it out.
- **A built deployment browses mixos.org.** The Docker image on any host, and
  Vercel, ignore `MIXOS_REPOSITORY_URL` unless it names their own machine
  (`localhost`, `127.0.0.1`, `[::1]`, `host.docker.internal`), and log it.
  **Breaking:** a deployment pointed at another catalogue now browses
  mixos.org; a source checkout still honours the override.
- **Releases.** A version of MixOS is an annotated tag `vX.Y.Z` on `main` with
  a GitHub Release, whose notes are its section of `CHANGELOG.md`.
  `/mixos deploy release` opens the release PR, which sets the version in
  `package.json` and writes that section from the Conventional Commits since
  the last release (`scripts/release-prep.ts`). Once it merges, run it again
  for the commands that tag the merge commit and publish the GitHub Release,
  which a person runs. To upgrade a deployment, merge the newest release tag
  into your fork rather than `upstream/main`
  (`docs/hosting/README.md#upgrading`). Prereleases are `vX.Y.Z-rc.N`.
- **Two platform migrations can't share a number.** The ledger records a
  migration by its number, so the release step and `npm run db:migrate` applied
  one of two files with the same number and silently skipped the other. Now
  they apply nothing, the build and `npm run dev:docker` stop, and Danger fails
  a PR that adds a number already on `main`, each naming both files and the
  next free number. If a merge brings in a migration with your number, rename
  yours to the next free number and change its `platform_schema_version` value
  to match.
- **A maintenance page while the database is behind.** When the platform
  schema is behind the build, every page shows a plain maintenance page and
  every API route, `/api/cron`, `/api/webhooks` and `/api/mcp` included,
  answers 503 with `Retry-After: 30` until the release step runs. Only
  `/api/health/live` and `/api/health/ready` answer as usual. Locally,
  `npm run db:local` brings it back. **Breaking:** `/api/health/ready` returns
  only `status` and `reason`. The schema versions, the count of pending app
  migrations and the message are gone; the server log has them.
- **Vercel production builds run the release step.** `vercel.json` makes
  `npm run vercel-build` the build command: `npm run build`, then the release
  step when `VERCEL_ENV` is `production`, over Neon's `DATABASE_URL_UNPOOLED`
  when it names the same database. Preview builds never run it. A build that
  doesn't compile leaves the database alone, and a failed release step fails
  the build, so the previous deployment keeps serving. Set
  `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD` on the project and the
  first deploy creates the admin. Migrations have to work with the deployment
  still serving: add in one release, remove in a later one. See
  `docs/hosting/vercel.md`.
- **`scripts/smoke-test-app.ts` tests real routes.** It looked for routes
  with a pattern no `defineRoute` route matches, so it sent no requests, and
  it skipped apps without connectors. It now reads routes from the generated
  registry and tests every app, or the slugs you name, with GET and HEAD
  only. Sign in with `SMOKE_EMAIL` and `SMOKE_PASSWORD`, or `SMOKE_COOKIE`;
  `--base-url` points it at another server. Activate and grant an app first:
  one that isn't is reported, not worked around. It exits 1 when a route
  fails or can't be reached, and its last line is a JSON verdict.
- **A deactivated app runs nothing.** None of its modules is imported while it
  is off: its API routes, over HTTP or through `callAppRoute()`, its jobs,
  syncs, services and `hooks.ts`. Run now refuses its jobs, which Scheduled
  Jobs shows as **App inactive**, and a consumer calling one of its services
  gets `PROVIDER_INACTIVE`. Activating it takes effect on the next request,
  with no restart. Run now, a job's Enable and Disable, and Start and Stop
  tick are now audited, as `app.job.run`, `app.job.enable`, `app.job.disable`,
  `scheduler.start` and `scheduler.stop`.
- **Disable a connector.** Admin > Connectors has Disable and Enable on each
  connector. Disabling names the apps that use it and asks first. While it is
  off, apps' calls to it fail with "disabled by an administrator", and its
  webhooks, Connect and Test Connection are refused. Its credentials are kept.
  The audit log records `connector.disable` and `connector.enable`, and now
  `theme.apply` too. See `docs/connectors/credentials.md`.
- **The Docker image is read-only to the server.** Its files are owned by root,
  so the server can't change its own code on any host, and
  `deploy/docker-compose.yml` runs `app` and `migrate` on a read-only root
  filesystem, with Next's caches and `/tmp` on `tmpfs`. Something you add that
  writes at runtime needs a mount; see `docs/hosting/docker-compose.md`.
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
  clearing a stuck lock. A theme still registers when it is installed.
  Installs, registrations and the registry generator take turns through
  `.mixos/lock`, so `npm run dev` or `npm run registry` waits while one runs.
  **Breaking:** in the audit log an install is `<kind>.install`, and
  `<kind>.register` means registering a pending one; `npm run register`'s
  rows name `cli:<user>@<host>`, with no user id, and show as unverified.
- **Register and Discard in Admin.** Admin > Apps and Admin > Connectors list
  what is waiting in `.mixos/pending/`, with **Review and register** and
  **Discard**. The review shows what will run (`hooks.ts`, `api/`,
  `widgets.ts`, `jobs/` and migrations), what install's check left to
  registration, the manifest's declarations beside the publisher's claims,
  whether your MixOS version meets the release's floor, and a link to the
  source at the installed commit. Register waits until you confirm you've read
  it. Afterwards, **Activate in this checkout** is offered only when the
  checkout's database is on the same machine; otherwise activate the app on the
  instance that serves it. Browse no longer has Install & Activate, and a
  deployment that runs a build says to install and register in a checkout,
  commit, and deploy.
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
  alone. **Breaking:** an install made before this has no record, so Register
  refuses it: discard it and install it again. An extension installed before
  this counts as local; reinstall it to give it a record.
- **Fix:** a seed `insert ... on conflict` in an app migration no longer fails,
  and `my-app` and `my_app` no longer share tables.
- **Fix:** a connection string that doesn't parse is reported by its variable's
  name, and the release step and the app no longer print it, password included.
- **Fix:** sign-in attempts are limited on every route that checks a password,
  including Auth.js's own callback, and those routes share one budget per IP.
- **Fix:** the password re-checks, webhooks and MCP bearer checks are limited,
  and a wrong password takes as long for an email with no account as for one
  with. "Change my password" and setting a user's password share one budget
  per person, and a webhook body over 5 MiB is refused.
- **Fix:** app API routes get request bodies over 10 MB whole. Up to 27 MB, a
  body reaches a route on `/api/apps` or `/api/p` exactly as sent, and a larger
  one gets a 413, with or without a `content-length`. Without a session cookie,
  `/api/apps` now answers with a JSON 401 or 404 instead of a redirect to
  `/login`.
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
  Browse pages no longer run off a phone or tablet screen. Below 1024px wide,
  the buttons sit under the title and wrap.
- **Fix:** an extension whose repository has a `.gitignore` can be installed.
  Installs refused a package with a `.gitignore` or `.gitattributes` at any
  depth; now they leave those files out, in any case, and install the rest.
  The content hash is still checked over the package as published, and the
  files hash in `.registry.json` covers what was written. The install result,
  `npm run register` and the install's audit row say what was left out. A
  `.git` or a `.registry.json` is still refused.
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
  `<kind>.identity.changed`, with both identities. Migration 0011; run
  `npm run db:local` to apply it. **Breaking:** every app the database already
  knows, and every connector with saved credentials, counts as local. Each one
  installed from the Registry, before or after this change, is switched off
  once at the first release step that carries it, and an app's API keys are
  revoked.
- **The build checks each installed extension's MixOS floor.** When an
  extension's `.registry.json` says it needs a newer MixOS than the version
  being built, `package.json`'s, the registry generator stops the build, naming
  the extension, its floor and the version: upgrade MixOS, or install an older
  release of the extension. A local extension isn't checked, and a floor that
  isn't a version is a warning, as at install. The install dialog and the
  review before Register now say whether this checkout meets a release's floor:
  "Requires MixOS 0.2.0 or newer. This checkout runs 0.1.0, which doesn't meet
  it." **Breaking:** a checkout or a deploy that carries such an extension no
  longer builds. To try one before its MixOS is released, bump `package.json`
  locally, and don't ship the extension until that release is merged.
- **Withdrawn releases reach the instances running them.** Once a day the tick
  asks mixos.org about the extensions installed from it. Admin > Apps,
  Connectors and Themes then show a release its publisher withdrew, with the
  reason and, for an app, a **Deactivate** button; a newer release; a listing
  no longer published; and when mixos.org last answered. It sends a random
  instance ID and each extension's kind, slug and version, nothing else, and
  acts on nothing. `MIXOS_UPDATE_CHECK=false` turns it off. See
  `docs/hosting/README.md#what-mixos-sends-to-mixosorg`.
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
  `docs/hosting/README.md`.
- **The admin pages say when a newer MixOS is out.** Once a day the tick reads
  mixos.org's list of MixOS releases, an anonymous `GET` that sends nothing
  about the instance and that mixos.org doesn't record. When a newer release
  is out, the top of every admin page says so: "MixOS 0.5.0 is available (this
  instance runs 0.4.2). A minor release: it may need changes." Its notes are
  collapsed, with links shown as text, and the notice links to the release's
  page on mixos.org and to the upgrade guide. Nothing is applied for you.
  `MIXOS_RELEASE_CHANNEL=prerelease` adds prereleases, and
  `MIXOS_UPDATE_CHECK=false` turns this check off too. See
  `docs/hosting/README.md#new-releases-of-mixos`.
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
  midway. The registry generator now also deletes its copies in `public/` of
  an extension that is gone.
- **Delete an extension's data.** Admin > Apps and Admin > Connectors list
  under **Not in this build** what the database keeps for an app or a
  connector the build no longer has, each with **Delete data…**: destructive,
  with its name typed. Keeping is the default. For an app it drops the schema
  and database role and deletes its rows, grants and settings; for a connector,
  its credentials and every user's connection. It is refused while the build
  serving the instance has it, until a release step has run without it, and
  while another build that used the database in the last 24 hours has it. The
  release step now marks a connector its build lacks, as it does an app, and
  each build records which apps and connectors it carries at its release step,
  when its server starts and on the cron tick. The Remove dialog adds **Remove
  code and delete this checkout's data**, under the same checks. The audit log
  records `<kind>.data.delete`, `connector.missing` and `connector.returned`.
  Migration 0012; run `npm run db:local` to apply it.
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
  `docs/hosting/README.md#linking-your-github-repository`.
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
  `docs/hosting/README.md#updating-an-extension`.

## 2026-10-07

- **Runs on any Postgres.** The platform no longer uses supabase-js or
  PostgREST: a query builder (`src/lib/db/query.ts`) runs every query over
  `DATABASE_URL`. `context.db` keeps its method names and `{ data, error }`
  results, but joins, `or()`, `filter()` and `rpc()` are gone, so an app that
  used one no longer compiles; `docs/apps/database.md` lists the full surface.
  `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are no longer read, so delete
  them from your deployments.
- **Hosting guides** in `docs/hosting/`: your own server with Docker Compose
  (`deploy/`, which Coolify and Dokploy can also deploy), a Render Blueprint
  (`render.yaml`), Railway (`railway.json`), and Vercel with Neon, Supabase or
  any Postgres.
- **`npm run db:migrate`** applies the platform schema to any Postgres. It
  shares the Supabase CLI's migration ledger, so it and `db:push` can be mixed.
  **`npm run release`** runs everything a deploy needs, and the Docker image
  carries the same step as `node ops/release.cjs`.
- Platform keys may now be base64 as well as hex, so hosting platforms can
  generate them.
- **`INSTALL_APPS`, `INSTALL_CONNECTORS`, `INSTALL_THEMES`** (default `true`).
  Set one to `false` and that kind's Browse page and button disappear, and its
  install actions refuse. The instance runs only what it was deployed with.
  See `docs/hosting/README.md`.
- **Brand hooks.** An app can change the install's name and marks
  (`brand-name`, `menu-bar-logo`, `login-logo`) from a new
  `apps/<slug>/hooks.ts` entrypoint, declared in `app.json` under `branding`;
  the build fails if the two disagree. A theme claims a slot outright with its
  own `branding` block. See `docs/apps/hooks.md#brand-hooks`.
- **Theme logos are measured.** An SVG `assets.logo` needs a `viewBox` (or an
  absolute `width` and `height`), and anything else must be `.png`, `.jpg` or
  `.webp`, or the build fails. Both bundled themes already comply.
- **`npm test`** runs the unit tests (`*.test.ts` under `src/` and `scripts/`)
  with Node's built-in runner, and CI runs it after typecheck.
- **`raw-response` is the only app escape, and it is required.** A route with
  `raw: true` registers only when `app.json` declares
  `escapes: [{ "rule": "raw-response", "reason": "…" }]`, and an admin sees the
  declaration and its reason in the app's details. `process-env`, `raw-fetch`,
  `raw-html` and `output-validate-dev-only` are gone; a manifest naming one
  fails the build.
- **App containment is enforced by the build, not just lint.** The registry
  generator reads every app's source on every build and every Registry install,
  and skips an app that references `process`, raw network access (`fetch`,
  `WebSocket`, the `http`/`net` modules, HTTP client packages), an HTML sink
  (`dangerouslySetInnerHTML`, `innerHTML`, …), `eval` or `new Function`. Each
  finding names the file and line.
- **`Markdown` for text you did not write.** `@/components/ui/markdown` renders
  GitHub-flavoured Markdown with raw HTML dropped and `javascript:` links
  blanked, styled from the theme's tokens.
- **Route output is validated on every response.** The
  `output: { schema, validate: "dev-only" }` form is removed; pass the schema.
- **Theme checks the build used to skip now fail it:** a custom property
  outside the top-level `:root` (in a `.mix-*` rule, or a `:root` inside
  `@media` or `@supports`), a colour token the build cannot evaluate or that is
  translucent, a `var()` naming a token `:root` never sets, and an `@font-face`
  missing from `fonts[]`. Only `--border` may be translucent; the build
  composites it over `--background`. Both bundled themes already comply.
- **The colour fence covers app widgets and pages again.** Raw palette classes,
  an opaque `bg-white` / `bg-black` and `dark:` variants are lint errors in
  `apps/**/*.tsx`, where a later config block had been switching them off.
- **The contrast lint rule checks every installed theme**, not only `mixos`,
  and names each theme an element fails under.
- **`npm run lint` generates the registry first**, so the contrast rule has
  theme tokens to read in CI, where it had been inactive.
- **The theme picker shows `assets.preview`** above the theme's swatch row,
  cropped to 16:9 from its top-left corner.
- **More manifest rules fail the build.** A `sync` needs `"database": true`
  and a `budgetMs` of at most 200000, because the scheduler stops a run at 240
  seconds. Role keys must be unique. A `widgets.ts` that disagrees with
  `app.json` now fails the build, where it used to leave the app out.
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
- **Fix:** per-user connector scope status was never saved (migration 0008).
  Run `npm run db:local` to apply it.
- **Fix:** a deactivated app's `/p` pages return 404, as its API routes already
  did.

## 2026-10-05

- **Local Docker on Linux and Windows.** `npm run dev:docker` and `/mixos init`
  now run on Linux (Docker Engine) and on Windows through WSL 2 (Docker Desktop
  with its WSL integration), not only on macOS. On Linux and in WSL the dev
  container writes the checkout as you rather than as root. The cron sidecar
  now reaches the app over the compose network, so a second instance's cron no
  longer calls the first instance's app.
- **Contributing terms.** `CONTRIBUTING.md` asks for a DCO sign-off on every
  commit (`git commit -s`) and the MPL notice on every new platform file.
  `TRADEMARK.md` sets out what forks, extensions and hosting services can be
  called.
- **Node 24.** `.nvmrc`, the Docker images and CI now run Node 24. 22 is still
  the minimum, until it reaches end of life on 30 April 2027. `npm run dev`,
  `build`, `typecheck`, `dev:docker` and the pre-commit hook now stop on an
  older Node with an explanation, instead of failing deep inside the registry
  generator. When a newer Node is installed but hidden from the shell, they say
  where it is and how to put it first. The README has a requirements table.


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
  the directory already exists. **Without the file nothing changes:** a checkout
  is still `mixos` on port 3000 with Supabase on 54321. One consequence — since
  `supabase/config.toml` now reads its project id and ports from `env(...)`,
  reach the CLI through `npm run supabase -- <command>`; a bare `supabase …`
  resolves an empty project id.

## 2026-09-13

- **`app.json` is the only app manifest form.** An app whose whole manifest was
  the default export of `app.ts` no longer loads. The reason is the install
  path: a manifest that is static text can be schema-checked *before* any of the
  package executes, and a manifest that is a module has to be imported before
  there is anything to validate — the wrong order for a package that just
  arrived from the Registry. **Migrating:** move every field to `app.json`, and
  move widget `config` arrays built from preset helpers into an optional
  `widgets.ts` beside it, default-exporting an object keyed by each widget's
  `component` path. The generator refuses to guess when the two disagree: a key
  matching no widget is an error, and so is a widget declaring `config` in both
  files. Plain config needs no `widgets.ts` at all — leave it inline in the JSON.

- **Connectors and themes get listing metadata and a `README.md`.** Both
  manifests now take the same optional catalogue fields apps already had —
  `tagline`, `keywords` (max 10, lowercase, no duplicates), `license`, and a
  pair of URLs (`connectorUrl` / `connectorSupportUrl`, `themeUrl` /
  `themeSupportUrl`). Alongside them, an optional `README.md` at the extension's
  root is its long-form description on the public listing, the same convention
  apps adopted. Templates ship both, filled in as placeholders.

- **Guide diagrams render as diagrams.** A ```` ```mermaid ```` fence in
  `docs/` now draws in the in-app guides instead of showing an admin the raw
  source, matching how mixos.org renders the same files. The ASCII diagrams in
  the apps, connectors, theme and security docs are converted. Mermaid is a
  dynamic import, so only an opened guide tab pays for it.

## 2026-08-29

- **Six independent platform keys.** Five of them used to be
  `CONNECTOR_ENCRYPTION_KEY` itself or derived from it, which made the base key
  impossible to rotate: changing it broke every stored connector credential,
  every MCP token, every app API key and every unlock cookie at once. Each
  purpose now has its own environment variable with a bounded blast radius.
  Generate them with **`npm run keys:generate`** (or `--missing` to fill gaps),
  and check a deployment with **`npm run keys:check`**. Local Docker already has
  them in `.env.docker` — nothing to do there.

- **Lint gates PRs again, and CI audits dependencies.** The `continue-on-error`
  on CI's lint step is gone now that the 10 pre-existing react-hooks errors are
  fixed. This matters more than style: `eslint.config.mjs` is where the
  client/server boundary is enforced — no raw `fetch` in app code, no
  `process.env`, no connector or DB client outside the server tier — and all of
  it was advisory while the step could not fail a build. A new
  `npm audit --audit-level=high` step runs beside it.

- **Connector scopes live in `connector.json`.** `auth.scopes` is now the
  provider's whole documented catalogue, each entry flagged with whether this
  connector asks for it, and only
  `npx tsx scripts/check-scopes.ts <name> --write` writes it — so a provider
  quietly adding a write scope shows up in a diff rather than in a database row
  an admin populated by pressing a button. What the provider *actually granted*
  is recorded per-scope at the OAuth callback, which is the only moment it can
  change. `icon` is now a full path (`"assets/icon.svg"`, not `"icon.svg"`).

- **Admin actions are recorded.** Who configured a connector, who granted a
  person access to an app, who set the password on a public page — none of it
  was written down before, on a platform whose admins hold every third-party
  credential in the deployment. Values are never logged, only which keys were set.

- **Sessions can be revoked one user at a time.** A `session_version` counter
  carried in the JWT and compared on every session resolution, so "this person
  left" no longer means rotating `AUTH_SECRET` and signing out everybody.

- **RLS is enforced by a backstop, not a hand-kept list.** `npm run migrate:apps`
  now enables row-level security on every uncovered table in `public`, app
  tables included — they were never covered, because an app's own `create table`
  lands in `public` exactly as written.

- **`-q` on any `/mix-*` command** makes it ask you 3–5 clarifying questions
  before it plans or writes anything.


## 2026-08-28

- **Themes are a first-class abstraction.** `themes/<slug>/` sits beside `apps/`
  and `connectors/`, with its own manifest, guide and **`/mixos theme`** command.
  A theme declares **exactly one palette**: light is what an install gets by
  default, and a dark look ships as a *separate installable theme*
  (`mixos-dark`) rather than a mode you switch inside the current one.

- **`/mixos convert`** turns an existing application into a MixOS app under
  `apps/`.

- **Connectors carry their own setup guide.** `connector.json` gained a
  structured `setup` block — the provider-side steps, links, and a note that can
  hang off each of the registry's own "save credentials / connect / verify"
  buttons, including this deployment's redirect URI. `description` is now capped
  at 140 characters and describes *the service*; provisioning prose belongs in
  `setup`. A connector can also ship `assets/icon.png` for its registry tile.

- **Per-user connectors.** A connector may declare `"userScoped": true`
  (three-legged OAuth only). Each person then authorizes their own account at
  **Account → Connections**, instead of everyone sharing the one grant an admin
  connected. The client ID and secret stay tenant-wide — the *application* is
  registered once, only the *grant* is personal.


## 2026-08-24

- **Local development now runs in Docker.** One command brings up Supabase
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

- **There is no `.env.local` to fill in any more.** `.env.docker` is committed,
  so a fresh clone has nothing to generate — every value in it is a public,
  dev-only placeholder, the admin login included. The Supabase URL, service key
  and DSN are written to `.env.docker.local` on each boot from
  `supabase status`, so there is no dashboard to visit either. The flip side of
  committing them: never reuse a value from `.env.docker` anywhere reachable
  from the internet.

- **Use `npm run db:local` for the local schema, not `npm run db:push`.**
  `db:push` targets the *linked remote* project, so reaching for it to repair
  your laptop can silently push migrations at a cloud database. You rarely need
  either: `npm run dev:docker` already applies the platform migrations
  (`db:local`) and then the app migrations (`npm run migrate:apps`) on every
  boot. See [docs/apps/database.md](docs/apps/database.md).

- **Scheduled jobs tick locally now.** A `cron` sidecar in `docker-compose.yml`
  runs under both profiles and GETs `/api/cron` every 5 minutes with the same
  bearer header Vercel Cron sends, so the scheduler exercises the production
  path rather than a dev-only timer. Watch it with
  `docker compose -p mixos logs -f cron`.
  `npx tsx scripts/run-scheduled-jobs.ts` still works, on either path, for when
  you don't want to wait up to five minutes for the next tick. See
  [docs/apps/scheduled-jobs.md](docs/apps/scheduled-jobs.md).

- **The standalone scripts now find the Docker stack on their own.**
  `npm run migrate:apps`, `npm run seed-admin` and
  `npx tsx scripts/run-scheduled-jobs.ts` used to read only `.env.local` and
  `.env` — neither of which the Docker path creates — so they worked when
  `npm run dev:docker` spawned them and failed with "No Postgres connection
  configured" when you ran them yourself. They now share
  [`scripts/load-env.ts`](scripts/load-env.ts), which falls back to
  `.env.docker` + `.env.docker.local` and rewrites `host.docker.internal` to
  `127.0.0.1` (a container address does not resolve from your shell). The
  fallback is skipped entirely when `.env.local` exists, so the hosted path is
  untouched — importantly, `.env.docker`'s `PGSSLMODE=disable` must never leak
  into a connection to a hosted database.

- **Fixed: `/api/cron` was missing from the proxy's public-route list.** Every
  tick was 307-redirected to `/login` before the route's bearer check could run
  — **in production as well as locally**, so Vercel Cron has been hitting a
  redirect instead of the handler and no scheduled job has actually been firing.
  If a job of yours looked dead, that is why. Nothing about the route's auth
  changed: the timing-safe `CRON_SECRET` comparison in
  `src/app/api/cron/route.ts` always was the real gate, and it still is.

- **Publishing is automatic — there is no publish command.** `/mos-publish` is
  gone. `.githooks/pre-commit` runs
  [`scripts/stamp-updated.ts`](scripts/stamp-updated.ts), which stamps
  `lastUpdated` on every app or connector with a file in the commit and
  re-stages the manifest, so the date in the App Manager and Connector Registry
  always matches the last commit that touched it. Preview what would be stamped
  with `npx tsx scripts/stamp-updated.ts --dry-run`. The hook is activated by
  `core.hooksPath`, which the `prepare` script sets on `npm install`.

## 2026-08-23

- **MixOS runs on Vercel, backed by Supabase Postgres.** Vercel builds
  and deploys straight from GitHub — a Preview deployment per pull request,
  Production on merge to `main`. CI
  ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) gates pull requests
  with lint, typecheck, and build; it deploys nothing itself.

- **Setting up.** *(Superseded 2026-08-24 — local development runs in Docker;
  there is no `.env.local` to create, and `npm run db:push` is the wrong command
  locally. See the entry above.)* Local development points at a Supabase
  project, so it has the same shape as production. Copy `.env.local.example` to
  `.env.local` and fill in `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and
  `DATABASE_URL` — use the **transaction pooler** connection string (port 6543),
  which is what serverless functions need. Then apply the schema:

  ```bash
  npm run db:push       # platform schema  → supabase/migrations/
  npm run migrate:apps  # per-app tables   → apps/*/migrations/
  ```

  Full walkthrough in [README.md](README.md), or run `/mixos init` for a guided
  setup.

- **Publishing an app or connector.** *(Superseded 2026-08-24 — `/mos-publish`
  is gone and `lastUpdated` stamps automatically on commit. See the entry above.)*
  Each one carries a `lastUpdated` date in
  its `app.json` / `connector.json`, stamped by one command:

  ```bash
  /mos-publish <slug>          # or: npm run mos-publish -- <slug>
  ```

  It validates the manifest first — a broken one never publishes — writes the
  date as an ISO 8601 string, and regenerates the registry. The date means *the
  author published this*, so a formatting pass or a dependency bump never makes
  an app look freshly updated. Run it as part of the work and commit the
  one-line manifest change alongside it. Until it runs, the App Manager and
  Connector Registry show **"Never published"**.

- **Background jobs run on Vercel Cron.** *(Superseded 2026-08-24 — jobs tick
  locally too, via the compose cron sidecar, and `/api/cron` was being redirected
  to `/login` in production. See the entry above.)* Apps declare `schedules` in
  their manifest; `vercel.json` registers a 5-minute tick against `/api/cron`.
  Nothing ticks under `npm run dev` — run
  `npx tsx scripts/run-scheduled-jobs.ts` to fire one by hand. See
  [docs/apps/scheduled-jobs.md](docs/apps/scheduled-jobs.md).
