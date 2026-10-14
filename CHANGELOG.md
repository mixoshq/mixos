# Changelog

Every release of MixOS, newest first. A release's section lists the
Conventional Commits since the release before it, leaving out documentation,
tests and internal changes, and is the notes of its GitHub Release.
[WHATS-NEW.md](WHATS-NEW.md) describes the larger changes in prose.

Releases are made with `/mixos deploy release`; see the Release section of
[.claude/skills/mixos/actions/deploy.md](.claude/skills/mixos/actions/deploy.md).

## v0.2.0 (2026-10-13)

Changes since v0.1.0. The larger ones are described in [WHATS-NEW.md](https://github.com/mixoshq/mixos/blob/v0.2.0/WHATS-NEW.md).

### Breaking changes

- **os:** fail the build on an install that needs a newer MixOS (a593c93)

  A checkout or a deploy that carries an extension
  whose floor is above its version no longer builds.

- **os:** switch off an extension that takes a different one's name (33610a7)

  Migration 0011 records every app the database knows,
  and every connector with saved credentials, as local. One installed
  from the Registry is switched off once at the first release step that
  carries it, and an app's API keys are revoked.

- **os:** record each install in its folder, and hand back the commit (1a871e6)

  A pending install made before this has no record, so
  Register refuses it. Discard it and install it again.

- **os:** install into .mixos/pending/ and register with npm run register (e3870ab)

  An app or connector installed from Browse waits in
  .mixos/pending/ until `npm run register -- <kind>/<slug>`. Installs are
  audited as \<kind\>.install and \<kind\>.install.rejected, and
  \<kind\>.register now means registering a pending install.

### Features

- **os:** offer Propose update and Propose removal on a deployment, and list them (b368e1d)
- **os:** propose an update or a removal as a pull request through the GitHub App (a7688b2)
- **os:** let a proposal replace or delete an extension's folder, judged against what the build runs (4538c85)
- **os:** offer the update pull request on the notice, and list them on Admin \> GitHub (276c6e6)
- **os:** open an update pull request once GitHub confirms upstream's tag (655d95f)
- **os:** name, scope and body a MixOS update pull request (c1735e6)
- **os:** offer Update on the notices and in Browse (edef039)
- **os:** empty the generator's public/ copy of an extension before copying it again (f1231d4)
- **os:** put a pending update in place at Register, with a backup (699a414)
- **os:** add Propose to Browse, and list the App's pull requests (a2cea17)
- **os:** propose an install as a pull request through the GitHub App (629dffa)
- **os:** check workflows and previews, and fence the App's writes (63b54a4)
- **os:** add the update dialog, and say what a pending update is (86ed20f)
- **os:** download another release of an extension as a pending update (fd315ef)
- **os:** add Admin \> GitHub (79ae58b)
- **os:** create, link, check and unlink the GitHub App (8010356)
- **os:** talk to GitHub as the App, through one client and narrowed tokens (5aa6562)
- **os:** add GITHUB_APP_ENCRYPTION_KEY, which turns on the GitHub App (6833c70)
- **os:** add "Remove code and delete this checkout's data" to Remove (d442db6)
- **os:** add Delete data under Not in this build (b98f3ef)
- **os:** delete an extension's kept data, decided from the database (8b8263d)
- **os:** record which builds use a database, and mark connectors a build lacks (03b62fe)
- **os:** add Remove to Admin \> Apps, Connectors and Themes (90018c3)
- **os:** prune public/ copies the generator no longer makes (f252d33)
- **os:** remove an extension's code from a checkout (74cf0f2)
- **os:** announce a newer MixOS at the top of the admin pages (44376d8)
- **os:** check mixos.org daily for new releases of MixOS (23d8587)
- **os:** smoke-test an app after Register with --smoke (637a2b1)
- **os:** check pull requests that change an extension (5cabfb8)
- **os:** show withdrawn and newer releases under admin page headers (c09035f)
- **os:** check mixos.org daily about extensions installed from it (2c6f216)
- **os:** say in the install and review dialogs whether a floor is met (3a08faa)
- **os:** ask for the name before turning on a replacing extension (0f7bd89)
- **os:** say in Browse where an installed extension came from (8d65dac)
- **os:** generate registry-installs.ts, and leave installs unstamped (ad10014)
- **os:** lead Browse installs to the review, without Install & Activate (73761fd)
- **os:** review, register and discard pending installs in Admin (033024c)
- **os:** take turns on a checkout lock, .mixos/lock (4190350)
- **os:** label audit rows nobody signed in for as unverified (823b4af)
- **os:** read each route's defineRoute options in an install's check (466518c)
- **os:** check a Registry install before it lands, without running it (2cf4f47)
- **os:** refuse package paths that would land as something other than they name (8b9f772)
- **os:** hold back only the app whose own migrations are behind (b44b79e)

### Fixes

- **os:** keep a withdrawn release's reason to one full stop (182d650)
- **os:** leave .gitignore and .gitattributes out of installs (42b2d3c)
- **os:** stack admin page headers on narrow screens (0baa17d)
- **os:** leave a local version bump out of /mixos deploy's commits (8b83b03)
- **os:** follow catalogue redirects only within the catalogue's origin (9602b71)
- **os:** don't re-stamp lastUpdated on what a merge brings in (5113092)
- **os:** audit an admin connecting a tenant connector (f02cd78)
- **os:** record analytics only for an app the user holds and may run (6a03c04)
- **os:** keep the app API mounts out of the proxy so bodies arrive whole (b569ecf)
- **os:** cap webhook bodies while reading, and limit webhooks per IP (fa56883)
- **os:** limit failed MCP bearer checks per IP (158b3c6)
- **os:** limit password re-checks per user, and hash once per sign-in attempt (6d9dbbc)
- **os:** make the Docker image read-only to the server (c287fc0)

## v0.1.0 (2026-10-10)

The first tagged release of MixOS. What changed on the way here is in [WHATS-NEW.md](https://github.com/mixoshq/mixos/blob/v0.1.0/WHATS-NEW.md).
