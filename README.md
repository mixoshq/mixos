<p align="center">
  <img src="public/logo.png" alt="MixOS" width="96" height="92">
</p>

<h1 align="center">MixOS</h1>

<p align="center">
  A self-hostable platform for building small internal apps —
  each one a folder, not a project.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MPL 2.0" src="https://img.shields.io/badge/license-MPL--2.0-brightgreen.svg"></a>
  <img alt="Next.js 16" src="https://img.shields.io/badge/Next.js-16-black.svg">
  <img alt="Node 22+" src="https://img.shields.io/badge/node-22%2B-brightgreen.svg">
</p>

---

MixOS gives a team one place to sign in, one set of roles, one look, and one
set of credentials for the outside world — and then lets each small tool live as
a folder inside it. Drop a directory under `apps/`, declare a manifest, and it
shows up in the launcher with authentication, permissions, its own database
tables, scheduled jobs, notifications, and an MCP surface already wired up.

It is built with [Next.js](https://nextjs.org) and backed by Postgres — any
Postgres 13 or later, from a container on your own server to Supabase, Neon or
RDS. **Locally the whole system — app, Postgres, and the scheduler tick — runs
in Docker on your machine**, so you don't need a cloud project to get started,
and [hosting it](docs/hosting/) is one Compose file, one Render Blueprint, or a
Railway template.

Three extension points, in increasing order of scope:

|                | What it is                                            | Lives in             | Guide                                        |
| -------------- | ----------------------------------------------------- | -------------------- | -------------------------------------------- |
| **Apps**       | A tool people use: pages, API routes, tables, jobs    | `apps/<slug>/`       | [apps/AGENTS.md](apps/AGENTS.md)             |
| **Connectors** | A shared, credentialed link to an external service    | `connectors/<name>/` | [connectors/AGENTS.md](connectors/AGENTS.md) |
| **Themes**     | The colours, type, and logo every app renders through | `themes/<slug>/`     | [themes/AGENTS.md](themes/AGENTS.md)         |

## Quick start

Three steps, which [How to install](docs/hosting/install.md#for-vibe-coders)
has in full:

1. **Download MixOS**: paste that page's prompt into Claude Code, and it clones
   the newest release into `~/MixOS`.
2. **Open the folder in Claude Code**: start a session in it in the
   [Claude app](https://claude.com/download)'s **Code** tab, or open it in VS
   Code with the Claude Code extension, signed in to Claude.
3. **Run `/mixos init`** in Claude Code:

   ```prompt
   /mixos init
   ```

That skill is the setup. It surveys what your machine is missing, asks once
before changing anything, installs Node / Docker (and Homebrew on a Mac, and the
VS Code extensions if you work in VS Code), boots the whole stack in Docker,
applies every migration, seeds an admin, and hands you a login for
[http://localhost:3000](http://localhost:3000). Budget 5–15 minutes on a first
run — most of it is Docker pulling images. Then it offers to put your copy in a
private GitHub repository of your own: that's what you deploy, and where new
releases merge in.

From there, `/mixos help` explains how apps, connectors, and themes relate and
recommends what to build first.

The guided installer covers **macOS**, **Linux**, and **Windows via WSL 2**. On
Windows, the stack runs inside WSL: clone the repository there, under your Linux
home directory — run `/mixos init` anywhere else on Windows and it walks you
through setting WSL up first. Not using Claude Code, or want to know what the
skill actually does? The same steps by hand, and everything else about running
MixOS on your computer, are in
[Running a development copy](docs/hosting/development.md).

## Contents

- [Quick start](#quick-start)
- [Installing and hosting MixOS](#installing-and-hosting-mixos)
- [Extending MixOS](#extending-mixos)
- [Authentication](#authentication)
- [Connectors](#connectors)
- [Connecting Claude (MCP)](#connecting-claude-mcp)
- [Developing](#developing)
- [Releases](#releases)
- [Licence](#licence)

## Installing and hosting MixOS

The install guide is in [`docs/hosting/`](docs/hosting/), in five parts:

1. **[How to install](docs/hosting/install.md)**: what you need, then a way for
   vibe-coders and a way for developers, both with Claude Code, and the install
   by hand: your own repository, keys, database, environment, deploy, the
   release step, the first admin, and checking it works.
2. **[Requirements](docs/hosting/requirements.md)**: what MixOS needs online,
   from the host, the database and the scheduler, what it doesn't provide yet,
   and what your computer needs.
3. **[Running a development copy](docs/hosting/development.md)**: MixOS on your
   own computer, with `/mixos init` or by hand: what you need, the dev
   container, `npm run dev`, installing from the Registry in a checkout, the
   tests, and common problems.
4. **[Install at popular providers](docs/hosting/providers/README.md)**: where
   to host, which database, and how extensions get in; then
   [Vercel with Supabase](docs/hosting/providers/vercel-supabase.md),
   [Render](docs/hosting/providers/render.md) ([`render.yaml`](render.yaml)),
   [Railway](docs/hosting/providers/railway.md) ([`railway.json`](railway.json)),
   and [Self-hosted](docs/hosting/providers/self-hosted.md): Docker Compose on
   your own server, Coolify or Dokploy.
5. **[After you install](docs/hosting/after-you-install/README.md)**: the first
   admin, backups, the release and update notices, and installing, updating and
   removing extensions; with
   [Upgrading MixOS](docs/hosting/after-you-install/upgrading.md),
   [Securing your install](docs/hosting/after-you-install/securing.md) and
   [Production Updates](docs/hosting/after-you-install/production-updates.md).

A deployment is the server, a Postgres 13+ database from any provider, and a
five-minute tick against `/api/cron`. MixOS connects to the database with one
`DATABASE_URL` and needs nothing from it but Postgres: no PostgREST, no Supabase
API keys. Every host runs the same release step before new code takes traffic:
the platform schema, the app migrations, and the first admin. Deploy your own
repository, so the apps you add are in the build.

## Extending MixOS

Everything you build lives in one of three top-level folders. Nothing is
registered in a central file: the registry is generated from the folders
themselves (`npm run registry`, which `dev` and `build` run for you), so adding
a directory with a valid manifest is the whole installation step.

**From the Registry.** In a checkout, Admin > Apps, Connectors and Themes can
browse [mixos.org](https://mixos.org) and install from it. An app or a connector
waits in `.mixos/pending/`, where nothing runs it, until you register it: with
**Review and register**, or `npm run register`. To ship it, commit its folder,
with the `.registry.json` record install wrote in it, and deploy.
[Installing from the Registry](docs/hosting/development.md#installing-from-the-registry)
has the commands, and [After you install](docs/hosting/after-you-install/README.md#extensions)
covers shipping, updating and removing an extension, and deleting what it kept.

Each guide below is the authoritative spec — file layout, manifest fields, APIs,
and the invariants that are easy to get wrong. Read the relevant one in full
before writing code; don't infer conventions from surrounding code alone.

### Apps → [`apps/AGENTS.md`](apps/AGENTS.md)

An app is a folder under `apps/<slug>/` with an `app.json` manifest. The folder
name _is_ the slug. From the manifest an app can declare pages, API routes,
its own Postgres tables (in a schema of its own, `app_<slug>`), scheduled jobs, web push
notifications, MCP tools, role requirements, and public or password-protected
surfaces. The platform supplies auth, navigation, theming, telemetry, and
per-app data isolation; the app supplies the parts that are actually specific to
it. Start from [`apps/_template/`](apps/_template/).

Deep dives live in [`docs/apps/`](docs/apps/): [architecture](docs/apps/architecture.md),
[pages](docs/apps/pages.md), [API routes](docs/apps/api-routes.md),
[database](docs/apps/database.md), [roles](docs/apps/roles.md),
[scheduled jobs](docs/apps/scheduled-jobs.md), [notifications](docs/apps/notifications.md),
[widgets](docs/apps/widgets.md), [MCP](docs/apps/mcp.md), and [UX](docs/apps/ux.md).

### Connectors → [`connectors/AGENTS.md`](connectors/AGENTS.md)

A connector is a folder under `connectors/<name>/` with a `connector.json`
manifest, wrapping one external service (Gmail, Slack, GitHub, …). It owns the
credential handling, the scopes it may request, retry and failure semantics, and
the typed client apps call — so several apps can share one authenticated link
instead of each rolling its own. Credentials are entered in the admin UI and
encrypted at rest, never committed. Start from [`connectors/_template/`](connectors/_template/)
or [`connectors/_template-oauth/`](connectors/_template-oauth/).

Deep dives live in [`docs/connectors/`](docs/connectors/): [architecture](docs/connectors/architecture.md),
[implementation](docs/connectors/implementation.md), [credentials](docs/connectors/credentials.md),
[scopes](docs/connectors/scopes.md), [webhooks](docs/connectors/webhooks.md),
[failure handling](docs/connectors/failure-handling.md), and
[usage in apps](docs/connectors/usage-in-apps.md).

### Themes → [`themes/AGENTS.md`](themes/AGENTS.md)

A theme is a folder under `themes/<slug>/` holding a `theme.json` of design
tokens plus its own logo, icons, and fonts. Every app renders through the active
theme, so a single switch restyles the whole system — apps never hard-code
colour. Contrast is checked, not assumed. Start from [`themes/_template/`](themes/_template/)
and compare against the shipped [`mixos-4dea07f5`](themes/mixos-4dea07f5/) and
[`mixos-dark-d666638f`](themes/mixos-dark-d666638f/).

Deep dives live in [`docs/themes/`](docs/themes/): [architecture](docs/themes/architecture.md),
[tokens](docs/themes/tokens.md), [authoring](docs/themes/authoring.md),
[assets](docs/themes/assets.md), and [contrast](docs/themes/contrast.md).

### The guided path

If you're working in Claude Code, in the Claude app or VS Code, the `/mixos`
command scaffolds any of the three for you and reads the right guide first. Run
`/mixos` on its own for the list of actions; add `-q` to any action to have
Claude ask clarifying questions before it starts.

- **`/mixos help`** — new here or unsure what to build? It explains how apps,
  connectors, and themes relate, asks what you're trying to do, and recommends
  what to build and which docs to read.
- **`/mixos app`** — create, update, or design-review an app under `apps/`.
- **`/mixos convert`** — turn an existing application (a local folder, a git URL,
  or code you've staged here) into a MixOS app. It inventories the original,
  writes a conversion plan to `apps/<slug>/plans/`, stops for your approval, then
  builds the first slice.
- **`/mixos connector`** — create or update a connector under `connectors/`.
- **`/mixos theme`** — create or update a theme under `themes/`.
- **`/mixos deploy`** — commit what you have in sensible commits, push, and
  open the pull request (branching first if you are on `main`). `--reset`
  brings you back to a fresh `main` after the PR merges. `release` cuts a
  version of MixOS, for maintainers (see [Releases](#releases)).
- **`/mixos upgrade`** — take your copy to MixOS's newest release: it shows
  what changed, merges the release on a branch, runs the checks, and hands the
  pull request to `/mixos deploy`.

## Authentication

Uses [NextAuth (Auth.js)](https://authjs.dev) with email and password as the only
sign-in method. The first account comes from `INITIAL_ADMIN_EMAIL` and
`INITIAL_ADMIN_PASSWORD`: a deployment's release step creates it, and
`npm run seed-admin` does in a checkout. After that an admin creates and manages
people at
[/admin/users](http://localhost:3000/admin/users). Setting
`ALLOWED_EMAIL_DOMAINS` restricts sign-in to a comma-separated list of email
domains; left blank, any provisioned address may sign in.

Sessions are JWTs, but admin status and a per-user session version are re-read
from the database on every session resolution rather than trusted for the
token's lifetime — so a demotion, a deletion, or an explicit revocation takes
effect on the next request instead of at token expiry. Apps declare which roles
they require, enforced per request; see [docs/apps/roles.md](docs/apps/roles.md).

## Connectors

Connectors integrate MixOS with external services (monday.com, Slack, GitHub, etc.).
Their API keys are **not** environment variables — an admin enters them in the UI
at [/admin/connectors](http://localhost:3000/admin/connectors), and MixOS encrypts
them in the database with `CONNECTOR_ENCRYPTION_KEY`.

You obtain each credential from that service's own developer console (an API key,
or an OAuth client for connectors that use it), following the setup guide shown on
the connector's tile in the registry. Because they are entered through the UI and
stored encrypted, no external credential ever belongs in this repo, in
`.env.local`, or in a deployment's environment variables.

Connectors marked `userScoped` are different: each person connects their own
account at [/account/connections](http://localhost:3000/account/connections), and
those grants are encrypted under a separate key. See
[docs/connectors/credentials.md](docs/connectors/credentials.md).

## Connecting Claude (MCP)

MixOS runs an MCP server so Claude can answer questions using data from your apps.
In Claude, add a custom connector pointing at:

```
https://<your-mixos-domain>/api/mcp    # or http://localhost:3000/api/mcp in dev
```

You'll be sent to MixOS to sign in and tick which apps the connection may read.
Access is **read-only** and never exceeds your own permissions — a connection can
only ever see apps you already have. Review or revoke connections at
[/account/mcp](http://localhost:3000/account/mcp).

Apps opt in by declaring tools; see [`docs/apps/mcp.md`](docs/apps/mcp.md) to add
them to yours.

## Developing

Work from a feature branch; `/mixos deploy` creates one if you are still on
`main`, commits your work, and opens the pull request (with a detailed
description). It stops at opening the PR,
since merging is what deploys to production. Without GitHub / `gh` access it
hands you a ready-to-open PR link and body to paste.

Checks that gate a pull request — run them before pushing:

```bash
npm run lint
npm run typecheck
npm run build
npm run verify:connectors   # connector manifests match their implementations
```

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) gates every pull request
with lint, `npm audit` (high advisories in what ships, critical ones anywhere),
the repository-URL check, typecheck, the tests and build. The tests include the
database suites, against a throwaway Postgres the job starts. Locally those skip
unless `MIXOS_TEST_DATABASE_URL` names a throwaway server:
[Running the tests](docs/hosting/development.md#running-the-tests) shows how to
start one. `verify:connectors` is a local check; run it after touching a
connector manifest.

There is no publish step. `.githooks/pre-commit` runs
[`scripts/stamp-updated.ts`](scripts/stamp-updated.ts), which stamps `lastUpdated`
on every app, connector, or theme with a file in the commit and re-stages the
manifest — so the date shown in the App Manager and Connector Registry always
matches the last commit that changed it. A merge doesn't re-stamp what it only
brings in from the other branch, so merging `main` into a pull request adds no
date changes. An extension installed from the Registry is never stamped: its
`.registry.json` records the files that were verified, and its date is its
publisher's. Preview what would be stamped with
`npx tsx scripts/stamp-updated.ts --dry-run`.

Recent, developer-facing changes are summarized in [WHATS-NEW.md](WHATS-NEW.md);
its newest section is printed automatically after you `git pull`.

### Formatting

Formatting is handled by [Prettier](https://prettier.io) with its default
config. The committed [.vscode/settings.json](.vscode/settings.json) sets
Prettier as the default formatter and turns on format-on-save, so once the
**esbenp.prettier-vscode** extension is installed (see Prerequisites) it just
works.

## Releases

A release of MixOS is an annotated tag on `main`, `vX.Y.Z`, with a
[GitHub Release](https://github.com/mixoshq/mixos/releases) whose notes are
its section of `CHANGELOG.md`: breaking changes first, then features and
fixes. Until 1.0, a release with a breaking change or any change to the
platform is a minor version (`v0.2.0` → `v0.3.0`), and any other release is a
patch (`v0.3.0` → `v0.3.1`). Prereleases have a suffix, such as
`v0.3.0-rc.1`, and GitHub marks them as prereleases.

**To upgrade a deployment,** run `/mixos upgrade` in Claude Code, or merge the
newest release tag into your own repository by hand, not `upstream/main`, which
holds work that hasn't been released yet. The steps are in
[Upgrading MixOS](docs/hosting/after-you-install/upgrading.md).

**To cut a release** (maintainers), run `/mixos deploy release` on an
up-to-date `main`. It opens a release PR that sets the version in
`package.json` and adds the `CHANGELOG.md` section, both worked out by
[`scripts/release-prep.ts`](scripts/release-prep.ts) from the Conventional
Commits since the last release. Once the PR merges, run it again: it gives you
the commands that tag the merge commit and publish the GitHub Release, and a
person runs them.

A version release is not the release step, `npm run release`, which applies
a deployment's database migrations.

## Licence

MixOS is licensed under the **Mozilla Public License 2.0** ([`LICENSE`](LICENSE)).

The platform is copyleft; **what you build on it is yours.** Apps, connectors
and themes under `apps/`, `connectors/` and `themes/` are not Covered Software
and may be licensed however you like, including proprietary — importing
platform code does not change that. The scaffolding templates are public domain
(CC0) so a copied template never carries obligations into your work. The
documentation in `docs/` is licensed under CC BY 4.0.

See [`LICENSING.md`](LICENSING.md) for the boundary in detail and why MPL was
chosen over GPL and AGPL. Contributions are made under the Developer
Certificate of Origin — see [`CONTRIBUTING.md`](CONTRIBUTING.md). The MixOS name
and logo are covered separately by [`TRADEMARK.md`](TRADEMARK.md).
