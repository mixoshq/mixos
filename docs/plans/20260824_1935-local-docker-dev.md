# Local Docker development environment

## Context

MOS deploys to Vercel with a hosted Supabase Postgres. Local development
currently requires each developer to create their own Supabase cloud project,
copy four secrets out of its dashboard, link the CLI, push the schema, and seed
an admin by hand — the path documented in [README.md](../../README.md) and
walked through by [`/mix-init`](../../.claude/commands/mix-init.md).

That is a lot of setup for a repo whose audience explicitly includes
non-technical builders (`/mix-help`, `/mix-init`), and it makes every developer
share or duplicate cloud infrastructure just to run the app.

**Goal:** a new person installs nothing by hand, runs `/mix-init`, and ends up
with the whole system — Next.js app *and* Supabase — running in Docker on their
machine, logged in as an admin.

### What the codebase actually needs from Supabase

This is the finding that shapes the whole design. MOS uses a very narrow slice
of Supabase. [src/lib/db/server.ts](../../src/lib/db/server.ts) documents the
only two data paths:

- `createServiceClient()` — `supabase-js` with the **service role key**, i.e.
  PostgREST over HTTP.
- `sql` — a raw `postgres.js` pool for the queries PostgREST can't express.

There is **no** Supabase Auth (NextAuth owns authentication), no Storage, no
Realtime, and no Edge Functions — verified by grep across `src/`, `scripts/`,
`apps/`, and `connectors/`. RLS is enabled with zero policies purely to keep
PostgREST's `anon` surface closed; the service role bypasses it entirely.

So "run Supabase locally" reduces to **Postgres + PostgREST + a gateway serving
`/rest/v1`**. Everything else in the Supabase stack would be booted for nothing.

### Blocking defects found during review

`npm run typecheck` fails with 5 errors today, so `next build` fails, so no
production image can be built until they are fixed:

| Location | Error |
|---|---|
| [src/instrumentation.ts](../../src/instrumentation.ts) | imports a server-hooks module from an app that does not exist (`apps/` contains only `_template`) |
| [src/instrumentation.ts](../../src/instrumentation.ts) | calls `startScheduler()`, removed from [src/lib/apps/scheduler.ts](../../src/lib/apps/scheduler.ts) when the tick moved to Vercel Cron |
| [src/app/(main)/apps/page.tsx:34](<../../src/app/(main)/apps/page.tsx#L34>) | missing required prop `missingUserConnectorsBySlug` |
| [src/components/admin/app-register-list.tsx:7](../../src/components/admin/app-register-list.tsx#L7) | imports `userScopedConnectorNames`, not exported by the generated connector registry |
| [src/components/admin/connector-registry-row.tsx:41](../../src/components/admin/connector-registry-row.tsx#L41) | reads `.scope`, absent from `ConnectorManifest` |

There is also no `supabase/config.toml` — only `supabase/migrations/` — so the
CLI's local stack has never been initialized and `npm run db:push` assumes a
*linked remote* project.

## Decisions

Locked with the user before writing this plan.

1. **Backend = Supabase CLI local stack, trimmed.** `supabase start` with
   auth, storage, realtime, edge runtime, inbucket, and analytics disabled in
   `config.toml`. Keeps real Postgres + PostgREST + Kong (so PostgREST version
   and behaviour match production) plus Studio for browsing data, at roughly
   four containers instead of ten. The CLI is already a devDependency, so there
   is nothing extra to install. Rejected: a hand-rolled Postgres + PostgREST
   compose (we would own JWT minting, roles, and version drift) and the full
   self-hosted Supabase compose (ten containers for services never called).
2. **App runs in Docker in both modes, via compose profiles.** A `dev` profile
   (bind-mounted source, `next dev`, hot reload) and a `prod` profile
   (multi-stage build, `output: "standalone"`, `next start`). Host
   `npm run dev` against the containerized backend keeps working and stays
   supported.
3. **Cron = sidecar container.** A small container polls
   `GET /api/cron` with `Authorization: Bearer $CRON_SECRET` every 5 minutes —
   byte-for-byte the path Vercel Cron takes in production, including the auth
   check in [src/app/api/cron/route.ts](../../src/app/api/cron/route.ts).
   Rejected: reviving an in-process `croner` timer, which would diverge from
   production behaviour.
4. **Bootstrap is fully automatic.** A committed `.env.docker` carries fixed
   dev-only secrets so nobody generates anything by hand, and the boot script
   applies platform migrations, runs `migrate:apps`, and seeds a known admin.
   Fixed `CONNECTOR_ENCRYPTION_KEY` also means locally stored connector
   credentials survive restarts.
5. **Fix all 5 typecheck errors** as part of this work.
6. **Docker becomes the documented default.** README Setup/Running and
   `/mix-init` are rewritten around it; the hosted-Supabase + host-Node path
   stays documented as the alternative.
7. **CI is unchanged.** [.github/workflows/ci.yml](../../.github/workflows/ci.yml)
   stays lint → typecheck → build with no database, which is what its comments
   deliberately describe.
8. **`/mix-init` is the installer**, not just a doc walkthrough. It:
   - targets **macOS only** — other platforms get a clear message and a pointer
     to the manual docs rather than a guessed path;
   - standardizes on **Docker Desktop**;
   - detects everything missing (Homebrew, Node 22, Docker Desktop, VSCode
     extensions), shows the complete list, asks **once**, then installs it all
     and boots the stack;
   - is **Docker-only** — it does not ask newcomers to choose a backend; the
     hosted path is a one-line escape hatch for people who ask.

## Structure

### New files

**`supabase/config.toml`**
`project_id = "mixos"`. API on 54321, DB on 54322, Studio on 54323. Explicitly
`enabled = false` for `[auth]`, `[storage]`, `[realtime]`, `[edge_runtime]`,
`[inbucket]`, and `[analytics]`, each with a one-line comment saying which grep
proved it unused — so a future reader knows the disable was measured, not
guessed.

**`Dockerfile`** — multi-stage production-parity image on `node:22-bookworm-slim`:
`deps` (`npm ci`) → `builder` (`npm run build`, whose `prebuild` regenerates
`src/generated/`) → `runner` (non-root, `next start` via standalone output).

The runner stage **must** copy more than `.next/standalone` and `public/`,
because two code paths read the repo from disk at runtime:

- [src/lib/apps/api-router.ts:19](../../src/lib/apps/api-router.ts#L19) walks
  `process.cwd()/apps/<slug>/api/**` on every app API request and checks for a
  literal `route.ts` — so **the `apps/` source tree, `.ts` files included, must
  be in the image**.
- [src/components/apps/guide-tabs.tsx:28](../../src/components/apps/guide-tabs.tsx#L28)
  and [src/components/connectors/connector-guide-tabs.tsx:14](../../src/components/connectors/connector-guide-tabs.tsx#L14)
  read `process.cwd()/docs/apps/*.md` and `docs/connectors/*.md` — so **`docs/`
  must be in the image** or the in-app guide pages 500.

**`Dockerfile.dev`** — `node:22-bookworm-slim`, source bind-mounted, named
volumes for `node_modules` and `.next` so host artifacts don't shadow the
container's, `npm run dev` bound to `0.0.0.0`.

**`docker-compose.yml`** — three services:

| Service | Profile | Notes |
|---|---|---|
| `app-dev` | `dev` | `Dockerfile.dev`, bind mount, port 3000 |
| `app` | `prod` | `Dockerfile`, port 3000 |
| `cron` | both | curl loop → `/api/cron` every 5 min with `CRON_SECRET` |

Every service gets `extra_hosts: ["host.docker.internal:host-gateway"]` and
healthchecks against the existing `/api/health/live` (app) and
`/api/health/ready` (DB reachable, 2s cap) endpoints. `cron` waits on the app
being healthy.

**`.env.docker`** (committed, dev-only) — `AUTH_SECRET`,
`CONNECTOR_ENCRYPTION_KEY`, `APP_UNLOCK_SECRET`, `CRON_SECRET`,
`INITIAL_ADMIN_EMAIL`/`INITIAL_ADMIN_PASSWORD`, `NEXTAUTH_URL=http://localhost:3000`,
and — load-bearing — **`PGSSLMODE=disable`**. Without it,
[src/lib/db/pg-options.ts:86](../../src/lib/db/pg-options.ts#L86) defaults to
`ssl: "require"` and every query against the local plaintext Postgres fails.
A header comment states plainly that these values are public, local-only, and
must never appear in a Vercel environment variable.

**`.env.docker.local`** (generated, gitignored) — `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, and `DATABASE_URL`, written by the boot script from
`supabase status -o json`. **Not hardcoded**: the CLI's local keys and their
format change between versions, and a stale copied key fails as a confusing 401
from PostgREST rather than an obvious error.

**`scripts/docker-up.ts`** — the single entry point, ordered so each step's
prerequisites already exist:

1. Verify the Docker daemon answers (`docker info`); if not, `open -a Docker`
   and poll with a timeout and a clear message.
2. `npx supabase start` (no-op if already running).
3. Read `supabase status -o json`; write `.env.docker.local`, rewriting
   `127.0.0.1` to `host.docker.internal` for the container's copies.
4. `npx supabase migration up --local` — incremental, unlike `db reset`, so
   restarts don't wipe local data.
5. `npm run migrate:apps`.
6. `npm run seed-admin` — already idempotent
   ([scripts/seed-admin.ts](../../scripts/seed-admin.ts) updates when the email
   exists, inserts otherwise).
7. `docker compose --profile dev up` (or `prod` via a flag).

Note the two-address split: host tooling in steps 4–6 talks to
`127.0.0.1:54322`, while the containers use `host.docker.internal`. Both are
derived from the same `supabase status` output rather than duplicated by hand.

**`scripts/docker-down.ts`** — `docker compose down` then `npx supabase stop`;
a `--reset` flag adds `supabase stop --no-backup` to discard the volume.

**`.dockerignore`** — `node_modules`, `.next`, `.git`, `supabase/.temp`,
`.env.local`, `*.tsbuildinfo`.

**`docs/local-docker.md`** — how the pieces fit, the two-address split, port
map, and troubleshooting. The README links here rather than absorbing it.

### Modified files

- **`instrumentation.ts` → [`src/instrumentation.ts`](../../src/instrumentation.ts)** —
  moved during implementation. Next derives the directory it scans for the hook
  as `<appDir>/..`, which is `src/` for this repo's `src/app`, and reads it
  *non-recursively* — so a repo-root copy is silently dropped from
  `output: "standalone"` and from Vercel builds while still working under
  `next dev`. Verified by build: the file appears in `.next/standalone` only
  from `src/`.
- **[next.config.ts](../../next.config.ts)** — add `output: "standalone"`.
- **[src/instrumentation.ts](../../src/instrumentation.ts)** — drop the nonexistent app
  import and the `startScheduler()` call (fixes 2 of the 5 errors); keep
  `register()` with its comment as the documented extension point for apps that
  register server-side hook listeners.
- **The 3 remaining typecheck errors** in `apps/page.tsx`,
  `app-register-list.tsx`, and `connector-registry-row.tsx`.
- **[package.json](../../package.json)** — add `dev:docker`, `docker:prod`,
  `docker:down`, `docker:reset`, and `db:local` (`supabase migration up --local`).
  Existing scripts are untouched.
- **[README.md](../../README.md)** — Docker-first Setup and Running; the hosted
  Supabase + host Node path moves under an "Alternative" heading; troubleshooting
  gains Docker-not-running, port conflicts (54321–54323, 3000), and the
  `PGSSLMODE` trap. The stale claim that scheduled jobs never fire locally is
  corrected — with the cron sidecar they now do.
- **[.env.local.example](../../.env.local.example)** — a header note pointing at
  the Docker path, and `PGSSLMODE=disable` guidance for a local Postgres.
- **[.gitignore](../../.gitignore)** — add `.env.docker.local`.
- **[.claude/commands/mix-init.md](../../.claude/commands/mix-init.md)** —
  rewritten per decision 8. New shape:

  - **Step 0 — platform gate.** Not macOS → say so, link the manual docs, stop.
  - **Step 1 — survey, don't act.** Check Homebrew, Node 22 (`.nvmrc`),
    `node_modules/`, Docker Desktop + daemon, the two VSCode extensions, and
    whether the Supabase stack is already up. Detection only.
  - **Step 2 — one confirmation.** Present the full list of what will be
    installed and ask once.
  - **Step 3 — install in dependency order.** Homebrew → Node 22 → `npm ci` →
    Docker Desktop → VSCode extensions. Node must precede anything Supabase,
    since the CLI is a devDependency.
  - **Step 4 — first launch.** Docker Desktop's first run needs a GUI
    click-through and license acceptance that cannot be scripted: launch it,
    then poll `docker info` and tell the user exactly what to click while
    waiting. Verify at least ~4GB is allocated to the VM.
  - **Step 5 — boot.** `npm run dev:docker`, then confirm
    `/api/health/ready` returns 200.
  - **Step 6 — hand off.** Print the URL and the seeded admin credentials from
    `.env.docker`, and point at `/mix-help`.

  The existing Step 0 "already set up?" short-circuit is kept, re-pointed at the
  Docker signals.

## Verification

1. `npm run typecheck` — clean (currently 5 errors).
2. `npm run build` — succeeds.
3. **Cold start.** From a clean state (`npm run docker:reset`), run
   `npm run dev:docker`. Expect: stack up, migrations applied, admin seeded,
   http://localhost:3000 serving, login with the `.env.docker` credentials.
4. **Health.** `/api/health/live` and `/api/health/ready` both 200 from inside
   the app container — `ready` proves the container reached Postgres through
   `host.docker.internal` with `PGSSLMODE=disable`.
5. **PostgREST path.** Exercise a page backed by `createServiceClient()` to
   prove the service-role key from `supabase status` authenticates against local
   Kong, not just that the raw `postgres.js` pool works. These are separate
   transports and can fail independently.
6. **Cron parity.** Watch the sidecar log a 200 within 5 minutes; separately
   `curl` `/api/cron` with no header and confirm 401.
7. **Prod profile.** `npm run docker:prod`, then hit an app API route under
   `/api/apps/...` — this is what proves the `apps/` source tree made it into
   the standalone image (see the api-router note above). Load `/apps/guide` to
   prove `docs/` did too.
8. **Host dev still works.** `npm run dev` with `.env.local` pointed at
   `127.0.0.1:54321` / `:54322`, per decision 2.
9. **Restart preserves data.** `docker:down` then `dev:docker` again — the
   seeded admin and any connector config survive.
10. **`/mix-init` on a clean machine.** Ideally a fresh macOS user account. At
    minimum, walk each detection branch with the tool artificially absent.

## Open items to confirm during implementation

- **Homebrew cask name.** Docker Desktop's cask was renamed from `docker` to
  `docker-desktop`; the formula `docker` is the CLI only. Installing the wrong
  one yields a `docker` binary with no daemon and a baffling error. Verify with
  `brew info --cask docker-desktop` before hardcoding it in the skill.
- **Supabase network aliases.** The plan uses `host.docker.internal`, which is
  portable and needs no knowledge of CLI internals. Joining
  `supabase_network_mixos` and addressing `kong:8000` directly would shave a
  hop; only adopt it if the alias is confirmed stable for the pinned CLI version.
- **Disabling `[analytics]`** in some CLI versions affects other services'
  startup. If `supabase start` complains, re-enable it and note the cost.
- **Docker Desktop licensing.** Free for personal use and small companies; paid
  above 250 employees or $10M revenue. Worth a line in the README so nobody is
  surprised. OrbStack is the drop-in alternative if that becomes an issue.
