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

- **os:** fail the build on an install that needs a newer MixOS (4918d92)

  A checkout or a deploy that carries an extension
  whose floor is above its version no longer builds.

- **os:** switch off an extension that takes a different one's name (8843938)

  Migration 0011 records every app the database knows,
  and every connector with saved credentials, as local. One installed
  from the Registry is switched off once at the first release step that
  carries it, and an app's API keys are revoked.

- **os:** record each install in its folder, and hand back the commit (54f2f4b)

  A pending install made before this has no record, so
  Register refuses it. Discard it and install it again.

- **os:** install into .mixos/pending/ and register with npm run register (a1188e5)

  An app or connector installed from Browse waits in
  .mixos/pending/ until `npm run register -- <kind>/<slug>`. Installs are
  audited as \<kind\>.install and \<kind\>.install.rejected, and
  \<kind\>.register now means registering a pending install.

### Features

- **os:** offer Propose update and Propose removal on a deployment, and list them (e763d62)
- **os:** propose an update or a removal as a pull request through the GitHub App (0f780ef)
- **os:** let a proposal replace or delete an extension's folder, judged against what the build runs (f7cc5f8)
- **os:** offer the update pull request on the notice, and list them on Admin \> GitHub (2fe5478)
- **os:** open an update pull request once GitHub confirms upstream's tag (d815bff)
- **os:** name, scope and body a MixOS update pull request (4b40c54)
- **os:** offer Update on the notices and in Browse (f799f69)
- **os:** empty the generator's public/ copy of an extension before copying it again (a1148eb)
- **os:** put a pending update in place at Register, with a backup (6d4701c)
- **os:** add Propose to Browse, and list the App's pull requests (9a36360)
- **os:** propose an install as a pull request through the GitHub App (1a2fa78)
- **os:** check workflows and previews, and fence the App's writes (475b573)
- **os:** add the update dialog, and say what a pending update is (716c8d5)
- **os:** download another release of an extension as a pending update (ab652a1)
- **os:** add Admin \> GitHub (6c682f4)
- **os:** create, link, check and unlink the GitHub App (b44248b)
- **os:** talk to GitHub as the App, through one client and narrowed tokens (197b119)
- **os:** add GITHUB_APP_ENCRYPTION_KEY, which turns on the GitHub App (585632e)
- **os:** add "Remove code and delete this checkout's data" to Remove (c1f3892)
- **os:** add Delete data under Not in this build (cf302ea)
- **os:** delete an extension's kept data, decided from the database (9ac7f9e)
- **os:** record which builds use a database, and mark connectors a build lacks (fcd3632)
- **os:** add Remove to Admin \> Apps, Connectors and Themes (c530ccf)
- **os:** prune public/ copies the generator no longer makes (d978bd5)
- **os:** remove an extension's code from a checkout (67f650e)
- **os:** announce a newer MixOS at the top of the admin pages (6e6cf66)
- **os:** check mixos.org daily for new releases of MixOS (7f8cf26)
- **os:** smoke-test an app after Register with --smoke (f43c099)
- **os:** check pull requests that change an extension (27d8a7b)
- **os:** show withdrawn and newer releases under admin page headers (0f274a1)
- **os:** check mixos.org daily about extensions installed from it (86933e1)
- **os:** say in the install and review dialogs whether a floor is met (c7eee86)
- **os:** ask for the name before turning on a replacing extension (05a1f12)
- **os:** say in Browse where an installed extension came from (fa5ed99)
- **os:** generate registry-installs.ts, and leave installs unstamped (8a31ae0)
- **os:** lead Browse installs to the review, without Install & Activate (89a28e4)
- **os:** review, register and discard pending installs in Admin (0a61ce1)
- **os:** take turns on a checkout lock, .mixos/lock (a9b5919)
- **os:** label audit rows nobody signed in for as unverified (1eb7a62)
- **os:** read each route's defineRoute options in an install's check (46ad7d7)
- **os:** check a Registry install before it lands, without running it (0814a4a)
- **os:** refuse package paths that would land as something other than they name (2169bba)
- **os:** hold back only the app whose own migrations are behind (8635df7)

### Fixes

- **os:** keep a withdrawn release's reason to one full stop (533e7f9)
- **os:** leave .gitignore and .gitattributes out of installs (0873a31)
- **os:** stack admin page headers on narrow screens (23b218b)
- **os:** leave a local version bump out of /mixos deploy's commits (c0fdabd)
- **os:** follow catalogue redirects only within the catalogue's origin (fde7f67)
- **os:** don't re-stamp lastUpdated on what a merge brings in (a863061)
- **os:** audit an admin connecting a tenant connector (e8c2476)
- **os:** record analytics only for an app the user holds and may run (8ffdf38)
- **os:** keep the app API mounts out of the proxy so bodies arrive whole (4bb118d)
- **os:** cap webhook bodies while reading, and limit webhooks per IP (73340c4)
- **os:** limit failed MCP bearer checks per IP (b27754c)
- **os:** limit password re-checks per user, and hash once per sign-in attempt (36f1263)
- **os:** make the Docker image read-only to the server (c2d1b41)

## v0.1.0 (2026-10-10)

The first tagged release of MixOS. What changed on the way here is in [WHATS-NEW.md](https://github.com/mixoshq/mixos/blob/v0.1.0/WHATS-NEW.md).
