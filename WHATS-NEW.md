# What's new in MixOS

Recent, developer-facing changes — newest first. When you ship something worth
announcing (a new command, a workflow change, a breaking change), add a short
`## <date>` section at the top. Keep entries brief; this is not a full changelog.

The newest section is shown automatically after you `git pull` (via the
`.githooks/post-merge` hook), but only when this file was among the commits you
just pulled.


## 2026-08-28

- **Themes are a first-class abstraction.** `themes/<slug>/` sits beside `apps/`
  and `connectors/`, with its own manifest, guide and **`/mix-theme`** command.
  A theme declares **exactly one palette**: light is what an install gets by
  default, and a dark look ships as a *separate installable theme*
  (`mixos-dark`) rather than a mode you switch inside the current one.

- **`/mix-convert`** turns an existing application into a MixOS app under
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

- **Gmail connector.** Read-only access to a shared mailbox: search with Gmail's
  `q` syntax, threads, labels, attachments, and message bodies decoded out of
  MIME.


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

- **Publishing is automatic — there is no publish command.** `/mix-publish` is
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

  Full walkthrough in [README.md](README.md), or run `/mix-init` for a guided
  setup.

- **Publishing an app or connector.** *(Superseded 2026-08-24 — `/mix-publish`
  is gone and `lastUpdated` stamps automatically on commit. See the entry above.)*
  Each one carries a `lastUpdated` date in
  its `app.json` / `connector.json`, stamped by one command:

  ```bash
  /mix-publish <slug>          # or: npm run mix-publish -- <slug>
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
