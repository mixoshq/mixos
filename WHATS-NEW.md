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
- **Fix:** a seed `insert ... on conflict` in an app migration no longer fails,
  and `my-app` and `my_app` no longer share tables.

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
