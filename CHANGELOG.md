# Changelog

Every release of MixOS, newest first. A release's section lists the
Conventional Commits since the release before it, leaving out documentation,
tests and internal changes, and is the notes of its GitHub Release.
[WHATS-NEW.md](WHATS-NEW.md) describes the larger changes in prose.

Releases are made with `/mixos deploy release`; see the Release section of
[.claude/skills/mixos/actions/deploy.md](.claude/skills/mixos/actions/deploy.md).

## v0.11.0 (2026-11-22)

**v0.11.0 is the first public release of MixOS.**

Changes since v0.10.0. The larger ones are described in [WHATS-NEW.md](https://github.com/mixoshq/mixos/blob/v0.11.0/WHATS-NEW.md).

### Features

- **os:** a switch and an icon for each search object, and drag-only ordering (19c2d2e)
- **os:** global search, opened from the menu bar or ⌘K, and a search field for apps (7773992)
- **os:** a connector's scope can include others, so a held scope isn't reported refused (109faa3)
- **os:** the welcome tour ends on "is yours", and I'm ready spells the name in confetti (ca18635)

### Fixes

- **os:** search handlers load through a generated map too (ce94a56)
- **os:** MCP tools, syncs, jobs and services load through generated maps (df02572)
- **os:** a select's caret sits in from the right border (8b159fa)
- **deps:** Next.js 16.4.3 to 16.4.6, for seven security advisories (7edb530)
- **os:** a route added under next dev answers without a restart (6561c33)
- **os:** a new app's page renders without restarting next dev (af5274e)

## v0.10.0 (2026-11-15)

Changes since v0.9.0. The larger ones are described in [WHATS-NEW.md](https://github.com/mixoshq/mixos/blob/v0.10.0/WHATS-NEW.md).

### Features

- **os:** Check now asks mixos.org for new releases from the admin footer (51af5f4)

### Fixes

- **os:** a configured connector's tile isn't tinted green, since its pill says so (537c6bf)

## v0.9.0 (2026-11-15)

Changes since v0.8.0. The larger ones are described in [WHATS-NEW.md](https://github.com/mixoshq/mixos/blob/v0.9.0/WHATS-NEW.md).

### Features

- **os:** each connector method names the scopes it needs, and a Methods tab shows them (d009925)
- **os:** registry tiles end in their dialog's provenance band, and Delete moves into the dialog (f9f0251)

### Fixes

- **os:** removing an extension shows no build error in a dev server (c3fe77c)
- **os:** an extension renamed can be removed (8f66f9d)

## v0.8.0 (2026-11-14)

Changes since v0.7.0. The larger ones are described in [WHATS-NEW.md](https://github.com/mixoshq/mixos/blob/v0.8.0/WHATS-NEW.md).

### Breaking changes

- **os:** an extension names itself as registryId, and its folder after it (79a6f75)

  app.json, connector.json and theme.json require
  "registryId", equal to the extension's folder, and connector.json's
  "name" is now "registryId". Create extensions with `npm run new`; give an
  existing one an id with `npm run rename -- <kind>/<folder>`.

## v0.7.0 (2026-11-10)

Changes since v0.6.0. The larger ones are described in [WHATS-NEW.md](https://github.com/mixoshq/mixos/blob/v0.7.0/WHATS-NEW.md).

### Breaking changes

- **os:** every extension JSON file names its shape with $schema (77ccce01)

  app.json, connector.json, theme.json,
  release-notes.json and .registry.json must start with
  "$schema": "https://mixos.org/schemas/\<file\>/v1.json", and
  release-notes.json is an object, { "$schema", "notes": \[...\] }. The
  build refuses a file without it and says what to add.

### Features

- **os:** Wall·E and the built-in themes get ids (a46386f3)
- **os:** npm run rename, and the release step carries an extension's data to its new slug (9ad74876)

## v0.6.0 (2026-11-08)

Changes since v0.5.0. The larger ones are described in [WHATS-NEW.md](https://github.com/mixoshq/mixos/blob/v0.6.0/WHATS-NEW.md).

### Features

- **os:** Production Updates' Tech Talk, as mixos.org's pill (197c62e)
- **os:** Production Updates, in place of the GitHub App (7aac302)
- **os:** the confetti covers the screen evenly, in the mark's colours (d6629ff)
- **os:** the menu bar marks Dashboard while you're on it (2181c30)
- **os:** the confetti bursts from behind the card, at the screen's centre (b6fe9f2)
- **os:** Setup Complete's box ticks itself under the pointer (0a7f0a8)
- **os:** 1983 pieces of confetti (cfd066f)
- **os:** the confetti bursts as the mark finishes drawing (e21280f)
- **os:** "MixOS is yours.", with the mark drawing itself on (30dab78)
- **os:** Skip tour outlined only under the pointer (8cdaebb)
- **os:** right-clicking a dashboard with widgets offers Edit Dashboard (97fd1cf)
- **os:** no ring around the celebration's mark (013b5fe)
- **os:** the guide shows the Apps icon, and Skip as an outline, bottom left (adf3de9)
- **os:** the first Enter keycap a second after the welcome line (52279a0)
- **os:** the settings sidebar's group headings in the text colour (90a280f)
- **os:** the settings menus as My Account, Administration, Deployment (66fefd4)
- **os:** the celebration's mark animates in, once (8d5adda)
- **os:** the GitHub App under a Developers group, saying what it's for (7c50c64)
- **os:** the settings sidebar's group headings in bold (028e7fe)
- **os:** an empty dashboard with nothing to add points to App Manager (ad04897)
- **os:** no Skip tour while the dashboard is being edited (6964c2f)
- **os:** the tour ends on "MixOS is installed!" after the first edit (4e1a1c2)
- **os:** the guide says Apps → App Manager, with Skip in its own corner (e231035)
- **os:** the guide waits on what you do, with only Skip tour in its bubble (2711664)
- **os:** the dashboard picture at a laptop's 16:10, the keycap still by it (59b83df)
- **os:** the dashboard picture plays, and the tagline gets its own screen (0d9b981)
- **os:** the Enter keycap blinks like a text cursor (ecafd54)
- **os:** the welcome line alone under the mark, the keycap blinking (7be27ad)
- **os:** show MixOS Launcher's icon in its window header (0097de0)
- **os:** the welcome line waits on Enter, under the mark alone (3fcca3c)
- **os:** release notices in the admin accent, the banner over the bar (f67974c)
- **os:** guide visits App Manager and ends on the first widget (a7ce0c8)
- **os:** welcome tour sends the logo home and shows a dashboard (0fe1266)
- **os:** sign-in page says when there's no database, with Try again (49f3558)
- **os:** show each copy's folder in MixOS Launcher (d0ef22b)
- **os:** MixOS Launcher finds running copies itself, and keeps its window in view (97bb7c7)
- **os:** give MixOS Launcher an installer window (f3cbb3a)
- **os:** MixOS Launcher, a Mac app that runs, watches and sets up local copies (68f83de)
- **os:** give every local checkout its own instance, and so its own database (2344544)
- **os:** say when local MixOS is up, and offer the next port when 3000 is taken (ce1efab)
- **os:** connect Claude, ChatGPT or Copilot from My MCP Connections (5234626)
- **os:** MixOS's notes lead the popover without a heading of their own (1f22b79)
- **themes:** release notes for mixos and mixos-dark (e831155)
- **wall-e:** release notes, back to the first release (59d6f11)
- **os:** App Manager's Release Notes page, with a filter by extension (582ef43)
- **os:** a gift in the menu bar with what changed in the last 14 days (a5596ab)
- **os:** release notes beside each extension's manifest, and MixOS's own (7ae11f9)
- **os:** install only releases mixos.org signed (6198a5b)
- **os:** Browse shows active installs, as mixos.org does (46fb2f1)

### Fixes

- **os:** Tech Talk lives with the admin components, not in app API (ec05beb)
- **os:** an app uninstalled mid-tour stays uninstalled (afe18f2)
- **os:** quiet Turbopack's warnings for extension parts nothing installed has (6a9aa97)

## v0.5.0 (2026-10-25)

Changes since v0.4.0. The larger ones are described in [WHATS-NEW.md](https://github.com/mixoshq/mixos/blob/v0.5.0/WHATS-NEW.md).

### Fixes

- **deps:** Next.js 16.4.3 and zod 4.6.7, for four security advisories (8c3b508)

## v0.4.0 (2026-10-20)

Changes since v0.3.0. The larger ones are described in [WHATS-NEW.md](https://github.com/mixoshq/mixos/blob/v0.4.0/WHATS-NEW.md).

### Breaking changes

- **os:** hold connectors to a versioned contract, and allow their writes per install (d9870121)

  connector.json needs "version", and an "operation" on
  each telemetry entry. A connectors or optionalConnectors entry is
  { "name", "version" }, and a bare name fails the build. An app can call
  only a connector's declared methods, and one declared "mutates" only
  with "access": "write" on its entry, once an admin allows the connector
  to change data: every connector starts read-only.

## v0.3.0 (2026-10-20)

Changes since v0.2.0. The larger ones are described in [WHATS-NEW.md](https://github.com/mixoshq/mixos/blob/v0.3.0/WHATS-NEW.md).

### Breaking changes

- **os:** send a FormData to a raw route with call(), and drop the untyped client (e705fd1)

  createAppClient() has no get, post, put, patch or
  delete; use call(). An app.json with apiVisibility fails the build.

- **os:** squash the platform migrations into one baseline schema (d174588)

  The release step refuses a database built by migrations
  0001-0014 until its ledger and schema are repaired to the baseline.

- **os:** switch each MCP tool on or off per app, off by default (fcedd7f)

  Every MCP tool starts off, including tools in use.
  After upgrading, turn on the ones you want on each app's MCP tab.

### Features

- **os:** /mixos upgrade, and a banner for admins when a release is out (f413521)
- **os:** stop /mixos deploy until origin is a repository of your own (d0e056b)
- **os:** end /mixos init by offering a private repository of your own (733e73b)
- **os:** ignore the extensions the core doesn't carry, in a core checkout alone (2f05f96)
- **os:** /mixos remix, to abstract a component of one app into another (36f5e17)
- **os:** manage who can reach an app from its Access tab (28a9952)
- **os:** show an app's egress on a Reach tab in its admin dialog (d7ff138)

### Fixes

- **os:** say what to check when no CI ran, without assuming a fork (ff57512)
- **os:** link the admin to the install guide's new pages (2a2b1e0)
- **os:** name the moved self-hosting guide in the hand-back (9360858)
- **os:** Danger fails a PR that adds an extension to the core (9347c79)
- **os:** Danger fails a version bump outside a release PR (ebc9c8e)

### Operations

- **os:** run the database tests in CI against a throwaway Postgres (72301f3)

### Other changes

- Update Buy Me a Coffee username in FUNDING.yml (5aeca24)
- added logo to readme (64bab30)

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
