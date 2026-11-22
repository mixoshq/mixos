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

- **os:** a switch and an icon for each search object, and drag-only ordering (b72ab93)
- **os:** global search, opened from the menu bar or ⌘K, and a search field for apps (96232e7)
- **os:** a connector's scope can include others, so a held scope isn't reported refused (fbcb0bf)
- **os:** the welcome tour ends on "is yours", and I'm ready spells the name in confetti (e290109)

### Fixes

- **os:** search handlers load through a generated map too (499dfd5)
- **os:** MCP tools, syncs, jobs and services load through generated maps (3500ab0)
- **os:** a select's caret sits in from the right border (02b3efc)
- **deps:** Next.js 16.4.3 to 16.4.6, for seven security advisories (62fc358)
- **os:** a route added under next dev answers without a restart (4193de4)
- **os:** a new app's page renders without restarting next dev (fcd4b00)

## v0.10.0 (2026-11-15)

Changes since v0.9.0. The larger ones are described in [WHATS-NEW.md](https://github.com/mixoshq/mixos/blob/v0.10.0/WHATS-NEW.md).

### Features

- **os:** Check now asks mixos.org for new releases from the admin footer (37ccfae)

### Fixes

- **os:** a configured connector's tile isn't tinted green, since its pill says so (460a058)

## v0.9.0 (2026-11-15)

Changes since v0.8.0. The larger ones are described in [WHATS-NEW.md](https://github.com/mixoshq/mixos/blob/v0.9.0/WHATS-NEW.md).

### Features

- **os:** each connector method names the scopes it needs, and a Methods tab shows them (84b2242)
- **os:** registry tiles end in their dialog's provenance band, and Delete moves into the dialog (185e174)

### Fixes

- **os:** removing an extension shows no build error in a dev server (3036968)
- **os:** an extension renamed can be removed (ce1bf6d)

## v0.8.0 (2026-11-14)

Changes since v0.7.0. The larger ones are described in [WHATS-NEW.md](https://github.com/mixoshq/mixos/blob/v0.8.0/WHATS-NEW.md).

### Breaking changes

- **os:** an extension names itself as registryId, and its folder after it (5b7498a)

  app.json, connector.json and theme.json require
  "registryId", equal to the extension's folder, and connector.json's
  "name" is now "registryId". Create extensions with `npm run new`; give an
  existing one an id with `npm run rename -- <kind>/<folder>`.

## v0.7.0 (2026-11-10)

Changes since v0.6.0. The larger ones are described in [WHATS-NEW.md](https://github.com/mixoshq/mixos/blob/v0.7.0/WHATS-NEW.md).

### Breaking changes

- **os:** every extension JSON file names its shape with $schema (e700a637)

  app.json, connector.json, theme.json,
  release-notes.json and .registry.json must start with
  "$schema": "https://mixos.org/schemas/\<file\>/v1.json", and
  release-notes.json is an object, { "$schema", "notes": \[...\] }. The
  build refuses a file without it and says what to add.

### Features

- **os:** Wall·E and the built-in themes get ids (3b10901b)
- **os:** npm run rename, and the release step carries an extension's data to its new slug (d35a7829)

## v0.6.0 (2026-11-08)

Changes since v0.5.0. The larger ones are described in [WHATS-NEW.md](https://github.com/mixoshq/mixos/blob/v0.6.0/WHATS-NEW.md).

### Features

- **os:** Production Updates' Tech Talk, as mixos.org's pill (cb7a04a)
- **os:** Production Updates, in place of the GitHub App (75db98b)
- **os:** the confetti covers the screen evenly, in the mark's colours (db78c28)
- **os:** the menu bar marks Dashboard while you're on it (923f638)
- **os:** the confetti bursts from behind the card, at the screen's centre (282e1c7)
- **os:** Setup Complete's box ticks itself under the pointer (f22b89b)
- **os:** 1983 pieces of confetti (c284a6d)
- **os:** the confetti bursts as the mark finishes drawing (25b2956)
- **os:** "MixOS is yours.", with the mark drawing itself on (1cd3dd5)
- **os:** Skip tour outlined only under the pointer (1262d41)
- **os:** right-clicking a dashboard with widgets offers Edit Dashboard (1a41b35)
- **os:** no ring around the celebration's mark (a375205)
- **os:** the guide shows the Apps icon, and Skip as an outline, bottom left (ab88f55)
- **os:** the first Enter keycap a second after the welcome line (e286325)
- **os:** the settings sidebar's group headings in the text colour (371ea63)
- **os:** the settings menus as My Account, Administration, Deployment (cf82f4e)
- **os:** the celebration's mark animates in, once (fdd9cfb)
- **os:** the GitHub App under a Developers group, saying what it's for (0a4ab3e)
- **os:** the settings sidebar's group headings in bold (9d079b6)
- **os:** an empty dashboard with nothing to add points to App Manager (7c0d2f6)
- **os:** no Skip tour while the dashboard is being edited (35e39dd)
- **os:** the tour ends on "MixOS is installed!" after the first edit (f60fd47)
- **os:** the guide says Apps → App Manager, with Skip in its own corner (9a53276)
- **os:** the guide waits on what you do, with only Skip tour in its bubble (2d2c09c)
- **os:** the dashboard picture at a laptop's 16:10, the keycap still by it (b63a815)
- **os:** the dashboard picture plays, and the tagline gets its own screen (fdc83bf)
- **os:** the Enter keycap blinks like a text cursor (f64258c)
- **os:** the welcome line alone under the mark, the keycap blinking (4bb98ad)
- **os:** show MixOS Launcher's icon in its window header (aa57059)
- **os:** the welcome line waits on Enter, under the mark alone (6a62df4)
- **os:** release notices in the admin accent, the banner over the bar (f258f93)
- **os:** guide visits App Manager and ends on the first widget (164b532)
- **os:** welcome tour sends the logo home and shows a dashboard (9d1a13d)
- **os:** sign-in page says when there's no database, with Try again (dcd31c2)
- **os:** show each copy's folder in MixOS Launcher (b3b0c55)
- **os:** MixOS Launcher finds running copies itself, and keeps its window in view (e7bff67)
- **os:** give MixOS Launcher an installer window (204252e)
- **os:** MixOS Launcher, a Mac app that runs, watches and sets up local copies (b1f5e91)
- **os:** give every local checkout its own instance, and so its own database (2e8b771)
- **os:** say when local MixOS is up, and offer the next port when 3000 is taken (4ae169b)
- **os:** connect Claude, ChatGPT or Copilot from My MCP Connections (d5bce24)
- **os:** MixOS's notes lead the popover without a heading of their own (7cc5f0c)
- **themes:** release notes for mixos and mixos-dark (4c91e3c)
- **wall-e:** release notes, back to the first release (4468291)
- **os:** App Manager's Release Notes page, with a filter by extension (7dd7211)
- **os:** a gift in the menu bar with what changed in the last 14 days (daf016a)
- **os:** release notes beside each extension's manifest, and MixOS's own (c496440)
- **os:** install only releases mixos.org signed (f70f6ad)
- **os:** Browse shows active installs, as mixos.org does (7df49e2)

### Fixes

- **os:** Tech Talk lives with the admin components, not in app API (d2e1b7a)
- **os:** an app uninstalled mid-tour stays uninstalled (8a16310)
- **os:** quiet Turbopack's warnings for extension parts nothing installed has (6bf98cb)

## v0.5.0 (2026-10-25)

Changes since v0.4.0. The larger ones are described in [WHATS-NEW.md](https://github.com/mixoshq/mixos/blob/v0.5.0/WHATS-NEW.md).

### Fixes

- **deps:** Next.js 16.4.3 and zod 4.6.7, for four security advisories (11d8859)

## v0.4.0 (2026-10-20)

Changes since v0.3.0. The larger ones are described in [WHATS-NEW.md](https://github.com/mixoshq/mixos/blob/v0.4.0/WHATS-NEW.md).

### Breaking changes

- **os:** hold connectors to a versioned contract, and allow their writes per install (145122ad)

  connector.json needs "version", and an "operation" on
  each telemetry entry. A connectors or optionalConnectors entry is
  { "name", "version" }, and a bare name fails the build. An app can call
  only a connector's declared methods, and one declared "mutates" only
  with "access": "write" on its entry, once an admin allows the connector
  to change data: every connector starts read-only.

## v0.3.0 (2026-10-20)

Changes since v0.2.0. The larger ones are described in [WHATS-NEW.md](https://github.com/mixoshq/mixos/blob/v0.3.0/WHATS-NEW.md).

### Breaking changes

- **os:** send a FormData to a raw route with call(), and drop the untyped client (fd96fd8)

  createAppClient() has no get, post, put, patch or
  delete; use call(). An app.json with apiVisibility fails the build.

- **os:** squash the platform migrations into one baseline schema (5857d65)

  The release step refuses a database built by migrations
  0001-0014 until its ledger and schema are repaired to the baseline.

- **os:** switch each MCP tool on or off per app, off by default (20a7a76)

  Every MCP tool starts off, including tools in use.
  After upgrading, turn on the ones you want on each app's MCP tab.

### Features

- **os:** /mixos upgrade, and a banner for admins when a release is out (a54458a)
- **os:** stop /mixos deploy until origin is a repository of your own (f5ae1fa)
- **os:** end /mixos init by offering a private repository of your own (32fc1e1)
- **os:** ignore the extensions the core doesn't carry, in a core checkout alone (9799d5d)
- **os:** /mixos remix, to abstract a component of one app into another (6f87122)
- **os:** manage who can reach an app from its Access tab (e7e6fcc)
- **os:** show an app's egress on a Reach tab in its admin dialog (5668c40)

### Fixes

- **os:** say what to check when no CI ran, without assuming a fork (5db79b8)
- **os:** link the admin to the install guide's new pages (41dbc11)
- **os:** name the moved self-hosting guide in the hand-back (7f272f9)
- **os:** Danger fails a PR that adds an extension to the core (6606a03)
- **os:** Danger fails a version bump outside a release PR (0493cdd)

### Operations

- **os:** run the database tests in CI against a throwaway Postgres (30a2efb)

### Other changes

- Update Buy Me a Coffee username in FUNDING.yml (314e8b6)
- added logo to readme (ba559b3)

## v0.2.0 (2026-10-13)

Changes since v0.1.0. The larger ones are described in [WHATS-NEW.md](https://github.com/mixoshq/mixos/blob/v0.2.0/WHATS-NEW.md).

### Breaking changes

- **os:** fail the build on an install that needs a newer MixOS (2b3584e)

  A checkout or a deploy that carries an extension
  whose floor is above its version no longer builds.

- **os:** switch off an extension that takes a different one's name (9ebd174)

  Migration 0011 records every app the database knows,
  and every connector with saved credentials, as local. One installed
  from the Registry is switched off once at the first release step that
  carries it, and an app's API keys are revoked.

- **os:** record each install in its folder, and hand back the commit (7dbd014)

  A pending install made before this has no record, so
  Register refuses it. Discard it and install it again.

- **os:** install into .mixos/pending/ and register with npm run register (d4b9ef1)

  An app or connector installed from Browse waits in
  .mixos/pending/ until `npm run register -- <kind>/<slug>`. Installs are
  audited as \<kind\>.install and \<kind\>.install.rejected, and
  \<kind\>.register now means registering a pending install.

### Features

- **os:** offer Propose update and Propose removal on a deployment, and list them (c91aadb)
- **os:** propose an update or a removal as a pull request through the GitHub App (52f2ba2)
- **os:** let a proposal replace or delete an extension's folder, judged against what the build runs (f0dd3ea)
- **os:** offer the update pull request on the notice, and list them on Admin \> GitHub (7fc3c4e)
- **os:** open an update pull request once GitHub confirms upstream's tag (8df6769)
- **os:** name, scope and body a MixOS update pull request (a3fa573)
- **os:** offer Update on the notices and in Browse (0322c7d)
- **os:** empty the generator's public/ copy of an extension before copying it again (0b8d5d8)
- **os:** put a pending update in place at Register, with a backup (6dee7ed)
- **os:** add Propose to Browse, and list the App's pull requests (96c4259)
- **os:** propose an install as a pull request through the GitHub App (f4ccb8b)
- **os:** check workflows and previews, and fence the App's writes (8cc4e9d)
- **os:** add the update dialog, and say what a pending update is (bc6e884)
- **os:** download another release of an extension as a pending update (a71fced)
- **os:** add Admin \> GitHub (e61a256)
- **os:** create, link, check and unlink the GitHub App (4182781)
- **os:** talk to GitHub as the App, through one client and narrowed tokens (7c90dc1)
- **os:** add GITHUB_APP_ENCRYPTION_KEY, which turns on the GitHub App (75f159d)
- **os:** add "Remove code and delete this checkout's data" to Remove (8a28787)
- **os:** add Delete data under Not in this build (ecf6156)
- **os:** delete an extension's kept data, decided from the database (64f4a69)
- **os:** record which builds use a database, and mark connectors a build lacks (b0456ea)
- **os:** add Remove to Admin \> Apps, Connectors and Themes (8d6e29d)
- **os:** prune public/ copies the generator no longer makes (af01edc)
- **os:** remove an extension's code from a checkout (b5a917c)
- **os:** announce a newer MixOS at the top of the admin pages (481d9cb)
- **os:** check mixos.org daily for new releases of MixOS (f4bd191)
- **os:** smoke-test an app after Register with --smoke (2cb6866)
- **os:** check pull requests that change an extension (9fefc89)
- **os:** show withdrawn and newer releases under admin page headers (9c78fd2)
- **os:** check mixos.org daily about extensions installed from it (5b4d9f6)
- **os:** say in the install and review dialogs whether a floor is met (d5d3bbc)
- **os:** ask for the name before turning on a replacing extension (32ed73a)
- **os:** say in Browse where an installed extension came from (528b20d)
- **os:** generate registry-installs.ts, and leave installs unstamped (88ed790)
- **os:** lead Browse installs to the review, without Install & Activate (3f7321c)
- **os:** review, register and discard pending installs in Admin (c755436)
- **os:** take turns on a checkout lock, .mixos/lock (df8062f)
- **os:** label audit rows nobody signed in for as unverified (59e7632)
- **os:** read each route's defineRoute options in an install's check (e54abd1)
- **os:** check a Registry install before it lands, without running it (6ee4779)
- **os:** refuse package paths that would land as something other than they name (ef66943)
- **os:** hold back only the app whose own migrations are behind (490fa1f)

### Fixes

- **os:** keep a withdrawn release's reason to one full stop (cb80ff8)
- **os:** leave .gitignore and .gitattributes out of installs (7a42231)
- **os:** stack admin page headers on narrow screens (fb14949)
- **os:** leave a local version bump out of /mixos deploy's commits (66e32e2)
- **os:** follow catalogue redirects only within the catalogue's origin (97f1f15)
- **os:** don't re-stamp lastUpdated on what a merge brings in (c245382)
- **os:** audit an admin connecting a tenant connector (2b5af52)
- **os:** record analytics only for an app the user holds and may run (a16c306)
- **os:** keep the app API mounts out of the proxy so bodies arrive whole (c5290d5)
- **os:** cap webhook bodies while reading, and limit webhooks per IP (c351abf)
- **os:** limit failed MCP bearer checks per IP (9f913bd)
- **os:** limit password re-checks per user, and hash once per sign-in attempt (29ec2c2)
- **os:** make the Docker image read-only to the server (1b579bc)

## v0.1.0 (2026-10-10)

The first tagged release of MixOS. What changed on the way here is in [WHATS-NEW.md](https://github.com/mixoshq/mixos/blob/v0.1.0/WHATS-NEW.md).
