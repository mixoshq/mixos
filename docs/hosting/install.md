# How to install MixOS

MixOS runs from a copy of its code that's yours: a private repository on
GitHub, which your host deploys and new releases of MixOS merge into. Claude
Code sets it up with you, whether or not you write code.
[Requirements](requirements.md) has the technical details, online and on your
computer.

## What you need

<!-- icons prerequisites -->

- **VS Code**: install [Visual Studio Code](https://code.visualstudio.com/).
  Developers can use another IDE, or a terminal, as
  [For developers](#for-developers) shows.
- **The Claude Code extension**: in VS Code's Extensions view, search for
  **Claude Code**, by Anthropic, and choose **Install**.
- **A GitHub account**, for the private repository that holds your copy of
  MixOS. [Sign up](https://github.com/signup) if you don't have one.
- **A paid Claude plan**: Pro, Max, Team or Enterprise, or a Claude Console
  account billed by API use. The free plan doesn't include Claude Code.
- **A host**, if you'll share your workspace with others. Without one, MixOS
  runs on your own computer. [Install at popular providers](providers/README.md)
  compares them.

On Windows, MixOS runs in WSL. Set that up first, as
[On Windows](development.md#on-windows) says, and work in a VS Code window
connected to WSL.

<!-- /icons -->

<!-- tabs audience -->

## For vibe-coders

Claude downloads MixOS, installs what your computer is missing, and starts it.

1. **Download MixOS.** Paste this into Claude Code, in the desktop app or the
   terminal:

   ```prompt
   Download the newest release of MixOS with git: clone
   https://github.com/mixoshq/mixos.git into ~/MixOS, then put main at its
   newest release tag (the highest vX.Y.Z, not a prerelease like v0.3.0-rc.1),
   tracking no branch, so a pull can't bring in unreleased work. Change nothing
   else. If ~/MixOS already exists or git isn't installed, stop and tell me
   what to do. Then tell me which version I have.
   ```

   Or download **Source code (zip)** from
   [the latest release](https://github.com/mixoshq/mixos/releases/latest), and
   unzip it in your home folder. `/mixos init` connects it to MixOS's history,
   so later releases merge in.

2. **Open the folder in VS Code**: **File > Open Folder**, then `MixOS`, or the
   folder you unzipped.
3. **Sign in to Claude** in the Claude Code panel, which the Claude mark (✻) at
   the top of the editor opens.
4. **Run `/mixos init`** in the Claude Code panel. Claude installs what your
   computer is missing, starts MixOS at
   [http://localhost:3000](http://localhost:3000) and gives you its login. Then
   it offers to put your copy in a private GitHub repository of your own.

## For developers

Clone MixOS yourself, open it in your IDE, and `/mixos init` does the rest.

1. **Clone the newest release**:

   ```bash
   git clone https://github.com/mixoshq/mixos.git MixOS
   cd MixOS
   git switch -C main "$(git describe --abbrev=0 --exclude '*-*' origin/main)"
   git branch --unset-upstream   # so a pull can't bring in unreleased work
   ```

2. **Open the folder with Claude Code**, in your IDE:

<!-- tabs ide -->

#### VS Code

**File > Open Folder**, then `MixOS`. The Claude mark (✻) at the top of the
editor opens the Claude Code panel.

#### Cursor

**File > Open Folder**, then `MixOS`. In the Extensions view, search for
**Claude Code**, by Anthropic, and choose **Install**. The Claude mark (✻) at
the top of the editor opens its panel.

#### JetBrains

Install the [Claude Code CLI](https://code.claude.com/docs/en/setup), then the
**Claude Code [Beta]** plugin, from **Settings > Plugins > Marketplace**. Open
the `MixOS` folder, and press **Cmd+Esc**, or **Ctrl+Esc** on Windows and
Linux. Running `claude` in the IDE's terminal works too.

#### Windsurf

Install the [Claude Code CLI](https://code.claude.com/docs/en/setup). Then open
the `MixOS` folder in Windsurf, and run `claude` in its terminal.

#### Terminal

Install the [Claude Code CLI](https://code.claude.com/docs/en/setup):

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

Then run `claude` in the `MixOS` folder.

<!-- /tabs -->

3. **Sign in to Claude**, if Claude Code asks.
4. **Run `/mixos init`**. Claude installs what your computer is missing, starts
   MixOS at [http://localhost:3000](http://localhost:3000) and gives you its
   login. Then it offers to create your private repository, which
   [Create your own repository](#create-your-own-repository) does by hand.

<!-- details -->

### Advanced: install by hand

Each step by hand, for when you'd rather run them yourself. Three things to
know first:

- **Use your host's page if there is one.**
  [Install at popular providers](providers/README.md) has the exact steps for
  Vercel with Supabase, Render, Railway, and your own server with Docker
  Compose, Coolify or Dokploy. This page is the version for any host.
- **Deploy your own repository**, not `mixoshq/mixos`, so the extensions you
  add are in the build.
- **Keep a copy of the keys.** Three of them encrypt data at rest, and a backup
  of the database is no use without them.

The short version, if you've deployed a web app before:

1. Clone [`mixoshq/mixos`](https://github.com/mixoshq/mixos) at its newest
   release, push it to a private repository of your own, and run `npm ci` in
   it.
2. Create a Postgres database, version 13 or later, on a Postgres server of its
   own, and copy its connection string.
3. Run `npm run keys:generate`, and keep its output somewhere safe.
4. On your host, set `DATABASE_URL`, the keys, `NEXTAUTH_URL` (the address
   people will sign in at), `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD`.
5. Deploy your repository, and run the release step before it takes traffic:
   `node ops/release.cjs` in the Docker image, or `npm run release` from a
   checkout.
6. Have something call `GET /api/cron` every five minutes, with
   `Authorization: Bearer $CRON_SECRET`.
7. Open `/api/health/ready`. Once it answers `{"status":"ok"}`, sign in with your
   admin email and password.

#### Step 1: Get your own copy

Your copy of MixOS is a private repository of your own on GitHub. The apps,
connectors and themes you add are committed there, your host builds from it,
and new releases of MixOS merge into it from `upstream`, MixOS's own
repository. It isn't a fork, because a fork of a public repository can't be
private.

##### Clone the newest release

```bash
git clone https://github.com/mixoshq/mixos.git MixOS
cd MixOS
git switch -C main "$(git describe --abbrev=0 --exclude '*-*' origin/main)"   # the newest release
git branch --unset-upstream   # so a pull can't bring in unreleased work
```

##### Create your own repository

These are the commands `/mixos init` runs, with the
[GitHub CLI](https://cli.github.com) signed in (`gh auth login`). MixOS's
repository becomes `upstream`, and a new private repository of yours becomes
`origin`:

```bash
git remote rename origin upstream
gh repo create <you>/mixos --private --source . --remote origin --push
gh repo set-default <you>/mixos    # so gh opens pull requests there, not on upstream
```

Without the GitHub CLI, create an empty private repository on GitHub, with no
README, licence or `.gitignore`, then:

```bash
git remote rename origin upstream
git remote add origin https://github.com/<you>/mixos.git
git push -u origin main
```

That pushes MixOS's own history and nothing else. Git ignores the `.env` files
and keys you'll make, so they stay on your computer. New releases reach your
repository when you merge their tag: see
[Upgrading MixOS](after-you-install/upgrading.md).

##### Install the dependencies

```bash
npm ci
```

`npm ci` installs exactly what `package-lock.json` pins, so you can run MixOS's
commands, and turns on MixOS's git hooks. Run it once the repository is yours:
in a checkout whose `origin` is still `mixoshq/mixos`, it also has git ignore
every extension the core doesn't carry, and your own are what you commit. If
you ran it before, `npm run prepare` sets that right.

#### Step 2: Generate the keys

In your copy, run:

```bash
npm run keys:generate
```

It prints a fresh value for each key a deployment needs, with a note on what
each protects:

| Key | Protects | Changing it means |
| --- | --- | --- |
| `AUTH_SECRET` | Sessions | Everyone signs in again |
| `CRON_SECRET` | The scheduler endpoint, `/api/cron` | Ticks are refused until the scheduler sends the new value |
| `CONNECTOR_ENCRYPTION_KEY` | Shared connector credentials, at rest | An admin enters every connector's credentials again |
| `USER_OAUTH_ENCRYPTION_KEY` | Each person's own connector grants, at rest | Everyone connects their own accounts again |
| `APP_SETTINGS_ENCRYPTION_KEY` | Apps' `password`-typed settings, at rest | An admin enters each of them again |
| `MCP_TOKEN_KEY` | MCP tokens and authorization codes | Every MCP client authorizes again |
| `APP_API_KEY_SECRET` | App API keys | Every app API key is issued again |
| `APP_UNLOCK_SECRET` | App password-unlock cookies | Visitors enter app passwords again |

Each is 32 random bytes, as 64 hex characters, which is what the command prints,
or as base64, which is what Render generates. The keys are independent, so
changing one never breaks what another protects.
[Environment secrets](../security-architecture.md#5-environment-secrets) says
what each would expose if it leaked.

- **Back up the three data keys**, `CONNECTOR_ENCRYPTION_KEY`,
  `USER_OAUTH_ENCRYPTION_KEY` and `APP_SETTINGS_ENCRYPTION_KEY`. Without them,
  what they encrypted can't be read, whatever database backups you have.
- **Never reuse a value from `.env.docker`.** That file is committed, so its
  keys are public. It's for development copies only.
- **`npm run keys:check`** checks a set: the keys in its environment and in
  your checkout's `.env` files. It exits non-zero when one is missing or
  malformed.
- **`GITHUB_APP_ENCRYPTION_KEY`** is optional, and printed only when you ask:
  `npm run keys:generate -- --github-app`. It turns on the
  [GitHub App](after-you-install/production-updates.md).

Render's Blueprint, a Railway template and `deploy/new-env.sh` generate the keys
for you.

#### Step 3: Create the database

Create a Postgres database that meets
[the requirements](requirements.md#a-postgres-database), and copy its
connection string. [Which database](providers/README.md#which-database)
compares the options.

#### Step 4: Set the environment

Set these where MixOS runs; each host page says how. The release step reports
any required key that's missing.

| Variable | Required | What it is |
| --- | --- | --- |
| `DATABASE_URL` | Yes | The Postgres connection string. `POSTGRES_URL` and the discrete `PG*` fields work too; see [`src/lib/db/pg-options.ts`](../../src/lib/db/pg-options.ts) |
| `PGSSLMODE` | When the connection is plaintext | Unset means TLS is required. `disable` for a database on the same private network, `verify-full` to check its certificate |
| `NEXTAUTH_URL` | Yes, except on Vercel, Render and Railway's own domains | The public address people sign in at, such as `https://mixos.example.com`. OAuth redirect addresses and the MCP resource identifier are built from it. On those three hosts MixOS takes the address the platform sets ([`src/lib/env/origin.ts`](../../src/lib/env/origin.ts)); set it for a custom domain |
| `AUTH_SECRET` | Yes | Signs sessions. Changing it signs everyone out |
| `CONNECTOR_ENCRYPTION_KEY`, `USER_OAUTH_ENCRYPTION_KEY`, `APP_SETTINGS_ENCRYPTION_KEY`, `MCP_TOKEN_KEY`, `APP_API_KEY_SECRET`, `APP_UNLOCK_SECRET` | Yes | The platform keys, from step 2. [`src/lib/env/keys.ts`](../../src/lib/env/keys.ts) says what each protects |
| `CRON_SECRET` | Yes | The token the tick sends. Without it, `/api/cron` refuses every call and scheduled jobs never run |
| `INITIAL_ADMIN_EMAIL`, `INITIAL_ADMIN_PASSWORD` | For the first deploy | The release step creates this account if no account has the email. It never changes an existing one, so they're safe to leave set |
| `INSTALL_APPS`, `INSTALL_CONNECTORS`, `INSTALL_THEMES` | No, default `true` | Whether admins can browse the catalogue for that kind. See [Fixing what an instance runs](after-you-install/README.md#fixing-what-an-instance-runs) |
| `MIXOS_UPDATE_CHECK` | No, default `true` | Whether the instance checks mixos.org once a day for updates to MixOS and its extensions. `false` sends nothing. See [Release and update notices](after-you-install/README.md#release-and-update-notices) |
| `MIXOS_RELEASE_CHANNEL` | No, default `stable` | Which releases of MixOS the admin pages tell you about: `stable`, or `prerelease` to include prereleases, such as `v0.3.0-rc.1` |
| `GITHUB_APP_ENCRYPTION_KEY` | No | Turns on Deployment > Production Updates. See [Production Updates](after-you-install/production-updates.md) |
| `MIXOS_COMMIT` | No | The commit the admin pages show beside the version. See [Which build is running](after-you-install/README.md#which-build-is-running) |
| `ALLOWED_EMAIL_DOMAINS` | No | Comma-separated email domains that accounts may use. Blank means any |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | No | Web Push, for apps that send notifications |

MixOS reads every value while it runs, not when it's built, and none of them
starts with `NEXT_PUBLIC_`, which would build it into the pages browsers
download.

Connector credentials aren't environment variables. An admin enters them at
Admin > Connectors, and they're stored encrypted.

#### Step 5: Deploy

Deploy your repository to your host. Each page under
[Install at popular providers](providers/README.md) says how, and sets up the
release step and the tick as part of it.

##### On another host

On a host that meets [the requirements](requirements.md#a-host), deploy the
Docker image or a Node build:

- **The Docker image.** The repository's [`Dockerfile`](../../Dockerfile) builds
  it. It takes no secrets at build time, and runs `node server.js` on port 3000
  as the unprivileged `node` user, with its files owned by root. Run the release
  step, `node ops/release.cjs`, in the new image before it takes traffic, and
  point the host's health check at `/api/health/ready`. The image's own
  `HEALTHCHECK` asks only whether the process is up. Pass
  `--build-arg MIXOS_COMMIT=$(git rev-parse HEAD)` to show the commit on the
  admin pages.
- **A Node build.** `npm ci && npm run build`, then the release step,
  `npm run release`, then `npm run start`, which is how MixOS's own CI starts a
  build.

Two things to know before you change the build:

- **Standalone output depends on `VERCEL`.** `next.config.ts` turns
  `output: "standalone"` off when a `VERCEL` environment variable is set, so
  don't set one outside Vercel.
- **The build checks its own file tree.** MixOS reads `apps/` from disk while it
  serves, where Next's tracing can't see it, so the Dockerfile fails the build
  if it's missing from the image. See
  [Dev and prod profiles](../local-docker.md#dev-and-prod-profiles).

Put HTTPS in front of it, as [A host](requirements.md#a-host) describes, then
schedule [the tick](requirements.md#a-scheduler). A cron job on the host works,
such as:

```
*/5 * * * * curl -fsS -o /dev/null --max-time 290 -H "Authorization: Bearer <CRON_SECRET>" https://mixos.example.com/api/cron
```

#### Step 6: Run the release step

The release step gets the database ready for the code that's about to serve. Every
host runs it before new code takes traffic:

| Host | How it runs |
| --- | --- |
| Docker Compose, Coolify, Dokploy | The `migrate` service, once per `up`, before the app starts |
| Render, Railway | The pre-deploy command, `node ops/release.cjs`, in the new image |
| Vercel | The production build, after `next build` and before the new deployment takes traffic. Preview builds never run it |
| Any other host | `node ops/release.cjs` in the image, or `npm run release` from a checkout |

[`scripts/release.ts`](../../scripts/release.ts) does five things, in order:

1. **The platform schema**, `supabase/migrations/*.sql`, by
   [`scripts/platform-migrations.ts`](../../scripts/platform-migrations.ts). It
   records each file in the same ledger the Supabase CLI keeps, so a database
   that `supabase db push` migrated counts as migrated, and the other way round.
   Any Postgres works: the ledger only borrows the CLI's name.
2. **The app registry and the app migrations**, as `npm run migrate:apps` does
   in a checkout. Each app with a database gets a schema and a role of its own,
   created here if they're missing, and its migrations run as that role, once
   every pending statement has passed the check on what an app migration may
   contain. One refused statement stops the step before any app's SQL runs: see
   [What a migration may contain](../apps/database.md#what-a-migration-may-contain).
   An app the build no longer carries keeps its data, and one that's a different
   extension than the one recorded under its name is switched off: see
   [After you install](after-you-install/README.md#when-an-app-leaves-the-build).
3. **Where each connector and theme came from**, by
   [`scripts/sync-identities.ts`](../../scripts/sync-identities.ts), which
   `npm run migrate:apps` also runs. A connector that's a different one than the
   one recorded under its name is disabled. One the build no longer has, whose
   credentials the database keeps, is marked missing and keeps them.
4. **What this build carries**: its apps and connectors, which Delete data
   counts on every instance sharing the database. See
   [Deleting an extension's data](after-you-install/README.md#deleting-an-extensions-data).
5. **The first admin**, from `INITIAL_ADMIN_*`, only if that account doesn't
   exist yet.

It's safe to run on every deploy, and safe to run twice at once: each step takes
a lock and checks again what it's about to change. It reads its settings only
from the environment it runs in, never from a checkout's `.env` files, so from a
checkout you name the database in the command:

```bash
DATABASE_URL='<connection string>' npm run release
```

It stops if nothing in its environment names a database. When it finishes, it
lists any required key that isn't set where it ran, and any switch with a value
it doesn't recognise.

The readiness check, `/api/health/ready`, answers 503 until the database has the
platform schema the build expects and every app migration the build carries. On
a host that waits for it, a deploy whose release step was skipped or failed
never takes traffic.

##### The maintenance page

On a host that doesn't wait, a database whose platform schema is behind the
build puts the whole instance on hold. Every page shows a plain "Down for
maintenance" page, and every API route answers 503 with `Retry-After: 30`. That
includes `/api/cron`, so the tick is skipped, and connectors' webhooks, so
senders retry later. Only `/api/health/live` and `/api/health/ready` answer as
usual, and readiness reports `"reason": "schema-behind"`.

The page shows no versions and no instructions, since visitors aren't the people
running MixOS. The server log has both, in a line starting
`Serving the maintenance page:`. To fix it, run the release step against the
database. MixOS serves again within 30 seconds, with no restart.

An app whose own migrations are behind doesn't close the instance: only that app
waits. Its pages show a plain "Being updated" page, and its API routes answer
503 with `Retry-After: 30`, both saying "This app is being updated. Try again
shortly." Its scheduled jobs wait too, and stay due. Readiness reports
`"reason": "app-migrations-behind"`, and the server log names the app and its
files in a line starting `Serving "being updated" for`. The same release step
brings it back. An app an admin has switched off answers as it always does.

#### Step 7: Sign in as the first admin

The release step creates your admin account from `INITIAL_ADMIN_EMAIL` and
`INITIAL_ADMIN_PASSWORD`, once. Sign in at your address, then change the
password on your account page. Then add your team: see
[After you install](after-you-install/README.md#sign-in-and-add-your-team).

#### Step 8: Check it works

MixOS answers two health checks:

| Endpoint | Asks | Answers | Point at it |
| --- | --- | --- | --- |
| `/api/health/live` | Is the process up? | 200, `{"status":"ok"}` | Your restart signal |
| `/api/health/ready` | Can it reach Postgres, with every migration this build expects? | 200, `{"status":"ok"}`, or 503, `{"status":"unavailable"}` with a `reason` when the database is behind | Your load balancer, or the platform's health check |

A blip in the database shouldn't restart MixOS, which is why there are two.

```bash
curl https://mixos.example.com/api/health/ready      # {"status":"ok"}
curl -i https://mixos.example.com/api/cron           # 401: the tick needs its token
```

Then check that the tick runs, in your scheduler's log: each call should get a
200. The admin pages show the version and commit you deployed: see
[Which build is running](after-you-install/README.md#which-build-is-running).

<!-- /details -->

<!-- /tabs -->

<!-- callout online -->

## Put it online

Deploy your repository, and your team can sign in to your workspace from
anywhere. Each host's page under
[Install at popular providers](providers/README.md) says how, and
[installing by hand](#advanced-install-by-hand) works for any host from
[Step 2](#step-2-generate-the-keys).

**At your own domain.** Render, Railway and Vercel give MixOS an address of
theirs. To use your own, either a domain of its own, such as
`mycompanymix.com`, or a subdomain of your company's, such as
`mix.company.com`:

1. **Add the domain to MixOS on your host.** Its dashboard says which DNS
   record to create. On a server of your own, the domain points at the server,
   as [Your own server](providers/self-hosted.md) says, and MixOS gets its
   certificate once the DNS resolves.
2. **Create that record where your domain's DNS is managed**: usually a CNAME
   for a subdomain, and an A or ALIAS record for a domain of its own.
3. **Set `NEXTAUTH_URL` to the new address**, exactly, such as
   `https://mix.company.com`, and redeploy. Signing in sends people there, so a
   mismatch shows up as an endless sign-in loop.
4. **Give each OAuth app the new redirect address.** A connector's redirect
   address is built from `NEXTAUTH_URL`, and Admin > Connectors shows the new
   one.

`/mixos deploy` doesn't put MixOS online: it opens a pull request with your
changes. When a newer release of MixOS is out, `/mixos upgrade` brings your copy
up to date.

<!-- /callout -->

## Common installation problems

<!-- terms -->

**Readiness answers 503, or the deploy never goes live.** With no `reason`,
MixOS can't reach the database: check `DATABASE_URL`, and `PGSSLMODE`. With
`"reason": "schema-behind"` or `"app-migrations-behind"`, the release step
didn't run, or failed. Its output says which migration, and why.

**Every page says "Down for maintenance".** The release step didn't run before
this code started serving. Run it against the database; see
[The maintenance page](#the-maintenance-page).

**The release step says "No database to release to".** It reads only its own
environment, never a `.env` file. Name the database in the command, or in the
host's environment for the step.

**TLS or "self-signed certificate" errors.** The database speaks plaintext and
`PGSSLMODE` is unset, which means TLS is required. Set `PGSSLMODE=disable` for a
database on the same private network.

**Connection timeouts, or "too many clients".** On a serverless host, use the
provider's pooled connection string, such as Supabase's transaction pooler on
port 6543.

**"Cannot resolve the application origin".** Set `NEXTAUTH_URL` to the address
people sign in at.

**Signing in sends you back to the sign-in page.** `NEXTAUTH_URL` doesn't match
the address in the browser, which happens after adding a custom domain. Set it
to that address, exactly.

**The tick gets 401.** The scheduler's `CRON_SECRET` isn't the app's. Copy the
app's value to the scheduler.

**The release step warns that keys are missing or malformed.** Each platform key
must be 32 bytes, in hex or base64. Restore the value from your copy;
`npm run keys:generate` makes a new set only for a fresh install.

**The release step refuses an app's role or schema.** Another MixOS database on
the same Postgres server uses that app's role, or the release step runs as a
different role than the app. See
[A Postgres database](requirements.md#a-postgres-database).

**The build stops: an extension needs a newer MixOS.** See
[When an extension needs a newer MixOS](after-you-install/README.md#when-an-extension-needs-a-newer-mixos).

<!-- /terms -->

Each host's page has the problems particular to it.
