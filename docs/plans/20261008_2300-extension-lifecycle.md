# Extension lifecycle and MixOS updates: what WordPress teaches, built for a vendored platform

**Status:** approved on 10 October 2026, with every recommendation in Owner decisions (D1 to D36)
accepted. Partly built. Merged in the core: ranks 1
([#15](https://github.com/mixoshq/mixos/pull/15)), 2
([#14](https://github.com/mixoshq/mixos/pull/14)), 3
([#16](https://github.com/mixoshq/mixos/pull/16)), 4
([#17](https://github.com/mixoshq/mixos/pull/17)), 5
([#31](https://github.com/mixoshq/mixos/pull/31)), 6
([#33](https://github.com/mixoshq/mixos/pull/33)), 7
([#36](https://github.com/mixoshq/mixos/pull/36)), 8
([#38](https://github.com/mixoshq/mixos/pull/38)), 9
([#41](https://github.com/mixoshq/mixos/pull/41)), 10
([#44](https://github.com/mixoshq/mixos/pull/44)), 11
([#18](https://github.com/mixoshq/mixos/pull/18)), 12
([#20](https://github.com/mixoshq/mixos/pull/20)), 13
([#28](https://github.com/mixoshq/mixos/pull/28)), 14
([#19](https://github.com/mixoshq/mixos/pull/19)), 15
([#45](https://github.com/mixoshq/mixos/pull/45)), 17
([#21](https://github.com/mixoshq/mixos/pull/21)), 18
([#47](https://github.com/mixoshq/mixos/pull/47)), 20
([#46](https://github.com/mixoshq/mixos/pull/46)), 22
([#48](https://github.com/mixoshq/mixos/pull/48)), 23
([#49](https://github.com/mixoshq/mixos/pull/49)), 25
([#22](https://github.com/mixoshq/mixos/pull/22)), 26
([#24](https://github.com/mixoshq/mixos/pull/24)) and 33
([#26](https://github.com/mixoshq/mixos/pull/26)). The first release, v0.1.0, is out
([#25](https://github.com/mixoshq/mixos/pull/25)). Merged on mixos.org: ranks 16 (#15), 19 (#11), 21
(#14) and 34 (#12 and #13). Ranks 24, 27 and 29 are in progress, and ranks 28 and 30 to 32 are not
started; the queue's State column has each. Revised on 9 October 2026 after a security review and a
consistency review (see Review notes, at the end). Replaces two approved plans and keeps every owner
decision in them, except where an owner decision below changes one and says so.
**Scope:** platform (`src/lib/repository/`, the registry generator, `scripts/`, `/api/cron`,
`src/proxy.ts`, the admin pages, the release step, host configs) and mixos.org (Registry API,
site docs).
**Replaces:** `safer-registry-installs.md` and `registry-update-check.md` (both approved on
8 October 2026 and never committed). Their decisions are carried forward below.
**Builds on:** the stack merged as #4 to #11,
[contain-app-migrations](20261007_0158-contain-app-migrations.md) (#12) and the
[app import allowlist](20261007_0153-app-import-allowlist.md) (#13).
**Source:** "What WordPress Teaches MixOS", an unpublished review of 3 September 2026 read against
`feat/platform-foundation`, re-baselined against the code on 8 October 2026. Context summarises
what it found.

`file:line@branch` references are to the code as it was when the plan was written, on the
branches below. IDs like `SB-10` or `RG-22` are internal review IDs.

| Name | Branch |
|---|---|
| core-4 | `feat/any-postgres-hosting`, #4 |
| escapes-5 | `feat/app-escapes`, #5, on #4 |
| isolation-6 | `fix/app-isolation`, #6, on #5 |
| mcp-7 | `fix/mcp-and-network`, #7, on #5 |
| ops-8 | `fix/ops-scripts`, #8, on #4 |
| connectors-9 | `fix/connectors`, #9, on #7 |
| runtime-10 | `fix/app-runtime`, #10, on #5 |
| migrations-wip | `feat/contain-app-migrations`, #12, on #8 |
| allowlist-wip | `feat/app-import-allowlist`, #13, on #6 |
| admin-dialog | `feat/app-admin-dialog`, not merged |
| mixos-org | mixos.org's repository, `main` |

Two more branches sat beside the stack and mattered for sequencing: `fix/themes-and-lint` (#11, on
#5, since it contains `feat/app-escapes`) edits the registry generator, and `fix/deps-audit` (#3,
on `main`) does not touch these files.

---

## Context

The page found MixOS ahead of WordPress on the download path (content hash verified in memory,
commit-pinned fetches, a hostile-by-default tar reader, yanked releases) and behind on
everything before the fetch and after the write. It listed ten lessons, three ways to resolve
the mismatch between a built application and a plugin model (§05), five pieces of a self-update
(§06), three readings of "link to GitHub" (§07) and a ten-item queue (§08).

The owner decided on 8 October 2026:

- Do all ten lessons.
- §05: build option 1 (lean into vendoring), then option 2 (vendoring plus a hosted build through
  a GitHub App on the operator's fork).
- §06: build the five pieces (stamp the build, read GitHub Releases, semver and channel, never
  auto-apply, schema gate at boot).
- §07: build option 1 (a read-only release feed), then option 2 (fork-and-PR integration).
- Never a runtime plugin loader, and never an in-place self-update.
- Follow the §08 priority queue.

Two approved plans cover much of the same ground and collide if built separately. Both edit
`runInstall()` and `preflight()`, both write a provenance record (a pending sidecar and
`.registry.json`), and one of them moves the first run of a package's code from install to a new
Register step. This plan merges them with the page's recommendations into one lifecycle.

### What changed since the page

A lot landed after 3 September. These facts, as of 8 October 2026, change the design:

- **The register lock exists.** Since f64bdf0 (10 Sep) the whole install runs under
  `withPlatformLock("repository.register")`, a row lease with a 15-minute TTL, chosen over
  `pg_try_advisory_lock` because session advisory locks don't survive a transaction pooler
  (`src/lib/repository/install.ts:685@runtime-10`; `src/lib/platform/lock.ts:17-30,46-119@core-4`).
- **Apps have an off switch.** Since eb944ea (23 Sep, on `main`) a new app arrives with
  `apps.is_active = false` and Admin > Apps has an audited Activate and Deactivate
  (`scripts/sync-app-registry.ts:22-25,48-57@core-4`; `src/lib/apps/admin-actions.ts:114-170@core-4`).
  Connectors have no switch.
- **`requiresMixOS` is enforced, but never compared.** `runInstall()` refuses an older instance
  with no override (`install.ts:741-747@runtime-10`), but the version comes from
  `MIXOS_RELEASE`, which no host sets.
- **The schema check exists as a readiness gate.** Migration 0007, `EXPECTED_SCHEMA_VERSION` and a
  503 from `/api/health/ready`; ops-8 adds `app-migrations-behind`. Nothing serves a maintenance
  response, and Vercel goes live without checking readiness.
- **There is no tag workflow, no tag, no GitHub Release and no published image.** Every host
  builds the operator's repository itself (`.github/workflows/ci.yml:1-9@core-4`; `git ls-remote
  --tags origin` is empty). The repository is private, so the page's anonymous
  `GET /repos/<owner>/mixos/releases` returns 404 today.
- **The smoke script tests nothing.** Its method regex can't see `export const GET =
  defineRoute(...)`, which the generator requires, so it sends no requests
  (`scripts/smoke-test-app.ts:213,245@connectors-9`; `scripts/generate-project-registry.ts:517@runtime-10`).
- **The generator doesn't skip dot-prefixed folders**, despite the comment in `writeTree()`
  (`generate-project-registry.ts:1256,1362,1827@runtime-10`; `install.ts:459-461@runtime-10`). A
  crash leftover `apps/.installing-<slug>`, or the page's `apps/.backup-<slug>`, would be imported
  and registered as an app.
- **The release step deletes an app's platform rows when its folder is gone** (grants, user
  installs, password, widgets) and can't tell a removal from a generator skip
  (`scripts/sync-app-registry.ts:29-35,59-69@core-4`; skips at
  `generate-project-registry.ts:1376,1389,1402@runtime-10`). That delete is also what makes a
  returning slug arrive inactive with no grants: the row is re-inserted with `is_active = false`,
  which the conflict clause leaves out on purpose (`sync-app-registry.ts:22-25,48-57@core-4`).
- **The page's root lockfile is superseded** by the approved per-extension `.registry.json`. A root
  file would make every install an OS change (`dangerfile.ts:8,27@core-4`; `OS-UPDATES.md:7,28-31@core-4`).

### Now, or after the current list?

Both, split by what each change touches. (Written before the stack merged; the queue's State
column says what has merged since.)

- **Start now**, on the branch named in the queue: the lock follow-ups, keeping data when an app
  leaves the build, the build stamp, the release process, duplicate migration numbers, the
  maintenance response, Vercel's release step, the smoke script fix, the activation bypasses,
  the connector switch and the read-only image; and, once the site's docs restructure is
  committed, the mixos.org Registry fixes and copy. These still meet open work in four places,
  and the queue is arranged around them:
  - contain-app-migrations is committed and pushed, and it changed `writeBuildInfo()` to
    `writeBuildInfo(apps, report)` and moved its call after `scanApps()`
    (`scripts/generate-project-registry.ts:2165,2200-2204@migrations-wip`). So the stamp,
    duplicate migration numbers, the maintenance response, Vercel's release step and the
    read-only image sit on that branch, not on `fix/ops-scripts`.
  - The activation bypasses (on #6) and the per-app maintenance response (on the #8 chain) gate
    the same module imports (`src/lib/apps/dispatch.ts:169`, `src/lib/apps/call.ts:97`,
    `src/lib/apps/scheduler.ts:275,295@core-4`). The activation PR adds one app gate, and the
    per-app maintenance check joins it after both bases merge (rank 13).
  - The connector switch's refusal to activate an app belongs in
    `getMissingTenantConfigConnectors()` (`src/lib/apps/connector-gates.ts:38@core-4`), which
    the unmerged admin-dialog work rewrites. That part waits until admin-dialog lands.
  - mixos.org's docs restructure (`api.md`, `operating/hosting.mdx`, `upgrading.mdx` and
    `securing.mdx`) is committed first.
- **After the stack (#4 to #10, and `fix/themes-and-lint`) merges:** everything that rewrites the
  install pipeline or the registry generator. Every open branch edits
  `scripts/generate-project-registry.ts`: #5 adds the containment scan, #6, #7, #9 and #10 each
  move or rewrite parts of it (#10 moves `applyWidgetConfigs()` into `scripts/widget-configs.ts`),
  and #8, contain-app-migrations and `fix/themes-and-lint` add to it. A static/code split of
  `scanApps()` on top of any one of them conflicts with the others.
- **One item can't wait:** "keep data when an app leaves the build" must merge before
  `app-import-allowlist`. The allowlist adds new reasons for the generator to skip an app, and
  today a skip makes the next release step delete that app's grants, installs, password and
  widgets. Rank 2 sits on contain-app-migrations (on #8) and the allowlist on #6, so the
  allowlist's merge waits for #8, contain-app-migrations and rank 2.

---

## Decisions carried forward

### From `safer-registry-installs.md` (approved 2026-10-08)

The plan chose "F, with A, and a check that runs nothing". Its decisions, by their lead
sentences:

1. "An installed app waits outside `apps/`." (`.mixos/pending/apps/<slug>/`, git-ignored,
   dot-prefixed.)
2. "Step 9 becomes a check that runs nothing, before the rename." (`--check`, a verdict JSON
   line, no imports, no writes to `src/generated/` or `public/`.)
3. "Registering is a shell command." Amended by owner decision 1 below.
4. "The admin is told what to read."
5. "Connectors and themes still register at install." Amended by owner decision 2 below: only
   themes do.
6. "The generator child gets an allowlist." (`PATH` and `TMPDIR`, nothing else.)
7. "The generator skips dot-prefixed directories."
8. "Builds and dev don't change."

The owner's decisions, verbatim:

> 1. **Registration:** a Register button in the admin UI, after a review prompt, as well as `npm run register -- <slug>`.
> 2. **Connectors wait too:** a connector installed from the Registry also waits in pending until it's registered.
> 3. **Static route reading in the check:** yes. The install-time check reads literal `defineRoute` options and reports bare handlers, undeclared roles and `raw` without its escape; anything it can't read statically is reported as checked at registration.
> 4. **Where pending installs live:** `.mixos/pending/`, as proposed.

### From `registry-update-check.md` (approved 2026-10-08)

Its decisions, by their lead sentences:

- "Provenance lives in the extension's directory." (`.registry.json`: `source`, `kind`, `slug`,
  `version`, `commitSha`, `contentHash`; preflight refuses a package that ships one.)
- "The generator turns provenance into a build constant." (`src/generated/registry-installs.ts`.)
- "Daily, from the scheduler tick, not on admin page load."
- "Only what came from the catalogue being asked."
- "Show, never act."
- "'Newer' only when both versions are dotted."
- "Fail quietly, show the date."
- "`MIXOS_UPDATE_CHECK`, on by default."

The owner's decisions, verbatim:

> 1. **On by default:** yes.
> 2. **Notices without being counted:** not in v1.
> 3. **`POST /installs`:** in the same PR as the update check, using the same instance ID and setting, so publishers see real install counts.
> 4. **Older installs:** document reinstalling; no adopt command.
> 5. **RG-11 (`requiresMixOS` at publish):** separate work.
> 6. **The IP sentence on api.md:** narrow it to what holds: the IP isn't stored in the Registry's database.

### Where a carried decision meets a lesson

- **Lesson 10 against update-check decisions 1 to 3.** The lesson says to send only the slugs
  and versions needed for an answer. The approved plan sends a random instance ID and the MixOS
  version, and adds `POST /installs`. Both were chosen the same day. Decision D1 settles it.
- **Lesson 04's `.backup-<slug>` against safer-installs decision 7.** A backup beside the live
  folder would be imported today. This plan puts backups and staging under `.mixos/`, outside
  every scanned folder, and keeps decision 7 for leftovers.
- **Lesson 03's "smoke test as step 9" against "install runs nothing".** Under the approved plan
  nothing can be smoke-tested at install. The recommendation makes the smoke test a report after
  Register in a checkout, and a gate in CI on the pull request that adds the extension. That drops
  the lesson's "fail the register", which the owner adopted with all ten lessons: decision D14.
- **Lesson 02's root lockfile against `.registry.json`.** The approved file wins; this plan adds
  fields to it (D5).
- **§06's "read GitHub Releases" against a private repository.** An anonymous
  `GET api.github.com/repos/mixoshq/mixos` returns 404 today, so the source the owner chose can't
  be read until the repository is public: decision D28.
- **Lesson 01's instance switches against SB-15** (theme apply, decided docs-only). The
  recommendation audits them: decision D16.

Nothing here reverses an owner decision without saying so. Four recommendations change one, and
each lists the owner's original choice as option A: D1 (the mechanism of update-check decision 3,
not its purpose), D14 (lesson 03's "fail the register"), D16 (SB-15) and D28 (§06's "read GitHub
Releases"). D29 keeps the owner's "semver and channel".

---

## Part 1. The extension lifecycle

### 1.1 What exists already

| Area | On 8 October 2026 | Evidence |
|---|---|---|
| Fetch and verify | Resolve, yank gate, `requiresMixOS`, pinned download, in-memory hash check and preflight, all before any write | `src/lib/repository/install.ts:714-761@runtime-10` |
| Lock | The whole install runs under `repository.register`, a lease: nothing renews it, the holder never re-checks it, and anyone can take it after 15 minutes. A held lock returns code `locked` and is audited | `install.ts:675-688@runtime-10`; `src/lib/platform/lock.ts:32-40,85-94@core-4`; `src/lib/repository/actions.ts:254-282@runtime-10` |
| Lock in the UI | The dialog shows a generic failure for `locked`, with no "try again". No test covers the lock | `src/components/admin/browse/register-dialog.tsx:448-465@runtime-10`; `src/lib/repository/policy.test.ts:83-98@runtime-10` |
| Write | Stages in `.installing-<slug>` beside the target, writes every file 0644, renames once | `install.ts:463-492@runtime-10` |
| Paths | The tar reader refuses absolute, NUL, backslash and traversal paths; the hash refuses only exact duplicates. Paths that differ only in case or Unicode form, and paths with control characters, pass, and on a case-insensitive checkout `writeTree()` writes such a pair into one file | `src/lib/repository/tar.ts:152-165@runtime-10`; `src/lib/repository/content-hash.ts:84-90@runtime-10` |
| First run of the code | Step 9 spawns the generator with the server's whole environment (`spawn` with no `env`). It imports `widgets.ts` and every `route.ts`. `next dev` then loads `hooks.ts` on the next render | `install.ts:557-565@runtime-10`; `scripts/widget-configs.ts@runtime-10`; `src/lib/hooks/loader.ts:35-88@isolation-6` |
| Built deployments | Refused first by a marker check (`VERCEL`, or `server.js` at the root). The copy already says "register on a machine with a writable checkout and deploy what it produces". The not-writable message still blames the filesystem | `install.ts:258-259,308-331@runtime-10` |
| Record of an install | Only the `<kind>.register` audit row, in the checkout's own database. Nothing reads it. Manifests carry no version | `actions.ts:229-247@runtime-10`; `scripts/manifest-schemas.ts:680-692@runtime-10` |
| "Installed" in Browse | True when any extension with that slug is in the build, local or not | `src/components/admin/browse/extension-card.tsx:59,129@core-4` |
| Install & Activate | Activates in the checkout's database after install. Activation refuses a slug the running build doesn't have | `register-dialog.tsx:117-128@runtime-10`; `src/lib/apps/admin-actions.ts:134-136@core-4` |
| App off switch | `apps.is_active`. New apps arrive inactive; every gate refuses an inactive app | `scripts/sync-app-registry.ts:22-25,48-57@core-4`; `src/lib/apps/auth-tier.ts:103-110@core-4` |
| Gaps in it | Admin "Run now" uses `forceClaim()`, which has no `is_active` check. `audience: "app"` services run an inactive provider. `/p` pages ignore deactivation (fixed on #6). Route modules are imported before activation is checked. Every app's `hooks.ts` loads | `src/lib/apps/scheduler.ts:343-354@core-4`; `src/lib/apps/services.ts:126-160@core-4`; `src/lib/apps/public-page.ts:39@isolation-6`; `src/lib/apps/dispatch.ts:169,216@core-4`; `src/lib/apps/call.ts:97,116@core-4`; `loader.ts:35-36@isolation-6` |
| Connector off switch | None. Credentials can't be cleared by design. A declared connector's module is instantiated even when unconfigured | `src/lib/connectors/config.ts:43-46@core-4`; `src/lib/apps/context.ts:187-196,256-279@core-4`; `src/app/(main)/admin/connectors/page.tsx:155-200@core-4` |
| Theme off switch | One applied theme; the rest are inert CSS. Applying isn't audited (SB-15, decided docs-only) | `src/lib/themes/active.ts:47-55@core-4`; `src/app/(main)/admin/themes/page.tsx:23-33@core-4` |
| Update | Refused: "Remove it first, or update it in its own source repo." | `install.ts:706@runtime-10` |
| Removal | No action, UI or CLI for any kind | No `uninstall` or `removeExtension` on any branch |
| A folder leaves the build | The release step deletes the `apps` row (cascading to grants, user installs, password, widgets). Tables, settings, API keys and ledger rows stay. Connectors keep everything. A slug that comes back is inserted inactive with no grants | `sync-app-registry.ts:29-35,48-69@core-4` (`:80-87@migrations-wip`); `supabase/migrations/0001_initial.sql:77,96,113,135,503-536@core-4` |
| Update check | None. The client makes three GETs | `src/lib/repository/client.ts:9-13@core-4` |
| Smoke script | Unwired. Connector apps only, localhost only, needs a DevTools cookie, and finds no routes | `scripts/smoke-test-app.ts:27,121,141,213,245@connectors-9` |
| GitHub | Unauthenticated, commit-pinned tarball downloads only. No token, App or API client | `src/lib/repository/fetch-source.ts:44-48@runtime-10` |
| mixos.org | `POST /updates` and `POST /installs` exist. `/updates` requires an instance UUID; `check_updates` raises without one | `src/pages/api/v1/updates.ts:39-41@mixos-org`; `supabase/migrations/0002_repository_api.sql:453-488@mixos-org` |

### 1.2 The lifecycle

```
            Install                Register                 commit, deploy          Activate
catalogue ──────────► pending ────────────────► in the checkout ─────────► in the build ─────────► active
(mixos.org)  checkout   nothing ran   checkout,   code ran here   (merge)    inactive in   per database,
             only                     under lock                             each database  audited
                │                                      │
             Discard                              Remove code (checkout, under lock), commit, deploy
                ▼                                      ▼
             nothing                       removed from the build ── Delete data (per database) ──► gone
                                           (data kept, marked)
```

| Verb | Who | Where | What it changes | Code that runs | Audit |
|---|---|---|---|---|---|
| Install | Admin, Browse | A checkout | `.mixos/pending/<kind>/<slug>/` for apps and connectors; `themes/<slug>/` for themes | None for apps and connectors (a static check in a child with `PATH` and `TMPDIR`). Themes have no code | `<kind>.install` |
| Discard | Admin or shell | A checkout | Deletes a pending install | None | `<kind>.discard` |
| Register | Admin (button after a review prompt) or shell (`npm run register`) | A checkout | Checks the pending folder against `filesHash`, moves it into `apps/` or `connectors/`, runs the generator | The package's, for the first time | `<kind>.register` |
| Commit and deploy | Operator | git and the host | Ships the folder | The release step applies migrations | git history |
| Activate, Deactivate | Admin | Each database | `apps.is_active`. An app back with different code, or whose identity changed, is flagged first (1.8) | None | `app.activate`, `app.deactivate` (exist) |
| Disable, Enable (connectors) | Admin | Each database | A per-connector switch | None | `connector.disable`, `connector.enable` |
| Apply (themes) | Admin | Each database | `platform_settings.theme` | None | `theme.apply` (D16) |
| Update | Admin | A checkout | A pending update; the swap happens at Register | At Register | `<kind>.update` |
| Remove code | Admin or shell | A checkout | Moves the folder out, regenerates | The generator | `<kind>.remove` |
| Delete data | Admin | Each database | Drops what the platform keyed to the slug, once a release step has marked it gone and no other recent build carries it | None | `<kind>.data.delete` |
| Propose (App linked) | Admin | The deployed instance | Opens a pull request on the operator's repository | None on the instance | `<kind>.propose` |
| Enable, Disable (users) | User | Their dashboard | `user_apps` | None | exists |

The verbs follow the [activation plan](20260923_0230-app-activation.md) (Install, Activate,
Enable) plus the approved Register step
(D2). "Install & Activate" goes: there is nothing to activate in pending.

Everything under `.mixos/` is git-ignored, dot-prefixed, listed in `.dockerignore` and ESLint's
`globalIgnores`, and outside `apps/`, `connectors/` and `themes/`, so the generator,
`app-migrations.ts`, `tsc` and output tracing never see it:

```
.mixos/
  lock                        the checkout lock: pid, hostname, token (1.4)
  checkout-id                 a random id for this checkout, its key in platform_builds_seen (1.8)
  staging/<kind>/<slug>/      written by install, then renamed away or deleted
  pending/<kind>/<slug>/      apps and connectors waiting for Register (includes .registry.json)
  pending/<kind>/<slug>.json  who installed it, when, filesHash, the verdict, what an update replaces
  backup/<kind>/<slug>/       the live copy during an update or removal; deleted on success
  backup/<kind>/<slug>.json   the holder's token and what the backup replaces
```

Every move between these and the live folders is a `rename` on one filesystem, so it is atomic.

### 1.3 Install: pending, check, review

`runInstall()`, in order:

1. The kind's install flag, then `assertInstallable()`, both **before** taking the locks (today
   `assertInstallable()` runs inside the row lock, `install.ts:695@runtime-10`).
2. Under `repository.register` and the checkout lock (1.4): refuse when the slug exists in
   `apps/`, `connectors/`, `themes/` or `.mixos/pending/<kind>/` (`already-installed` covers
   pending, approved decision 4), unless this is an update (1.7).
3. Resolve, yank gate, `requiresMixOS`, pinned download, hash check, `preflight()`.
   `preflight()` also refuses a package that ships `.registry.json`. Review reads the source on
   GitHub, but what runs is what lands on this disk, so `preflight()` also refuses a package with:
   - two paths that are equal after lower-casing, or after NFC normalisation. On a default macOS
     or Windows checkout, `writeTree()` would write both into one file, and whichever came last in
     the archive is what runs (`install.ts:463-492@runtime-10`);
   - a path holding C0 or C1 control characters, DEL, or Unicode bidi controls (U+202A to U+202E,
     U+2066 to U+2069), which can rewrite what the CLI and the dialogs print;
   - a `.git` file or folder at any depth, which makes git treat the folder holding it as a
     repository of its own.

   `.gitattributes` and `.gitignore` at any depth change what the operator's repository records
   and how its review shows the files (`-diff`, `linguist-generated`, or a tracked file the
   operator's `git add` would skip). Most extension repositories have a `.gitignore`, so install
   leaves both out rather than refuse the package (owner decision, 11 October 2026): neither is
   written, nothing else about its path is checked, and mixos.org's publish check skips them too.
   The content hash is checked over the package as published, before they are left out.
4. Compute `filesHash`: the content hash's serialisation over the entries install writes, those
   left out not included, with every file mode read as 644. `writeTree()` writes every file 0644
   while the content hash records the execute bit (`content-hash.ts:97@runtime-10`), so only a
   mode-blind hash can be recomputed from the folder later. Then add `.registry.json` to the
   in-memory tree (1.5).
5. Write the tree to `.mixos/staging/<kind>/<slug>/`, every file 0644.
6. Run `generate-project-registry.ts --check <kind> <dir> --verdict-file <path>` on the staging
   folder, with `env: generatorEnv()` (`PATH` and `TMPDIR`). The check treats the staged folder as
   the extension's own folder. The containment scan and the import allowlist get it as the app's
   folder (the allowlist in progress already resolves `@apps/<own-slug>` from the folder it is
   given, `src/lib/apps/import-policy.mjs:369-389@allowlist-wip`), and the migration lookup takes it
   instead of `apps/` (`appMigrationFiles(APPS_DIR, slug)`,
   `scripts/generate-project-registry.ts:1458-1470@migrations-wip`). The checks that span
   extensions (`validateHookWiring()`, `validateServiceWiring()` and `validateUserScopedUsage()`,
   `generate-project-registry.ts:761,1080,1961@core-4`) run over the registered manifests in
   `src/generated/app-registry.ts` and `connector-registry.ts`, which import only types, plus the
   staged one. On its own, the staged app would fail them for a provider it consumes. The check
   does only what reads text: the schemas, the containment scan from #5 and the import allowlist,
   contain-app-migrations' SQL check, the file and text checks `scanApps()` already has, and, per
   owner decision 3, the literal `defineRoute({...})` options (bare handlers, undeclared roles,
   `raw` without its escape). Anything it can't read statically is listed as "checked at
   registration". It imports no extension code, skips `writeBuildInfo()`, and writes nothing to
   `src/generated/` or `public/`. It writes one verdict,
   `{"verdict":"accepted"|"rejected","problems":[…],"deferred":[…]}`, to the file the parent
   named. `checkExtension()` requires exit 0 and exactly one well-formed verdict in that file, and
   treats stdout and stderr as display only, so a file name or manifest string the check echoes
   can't pose as a verdict (`spawnCapture()` merges the two streams today,
   `install.ts:557-577@runtime-10`). This replaces matching `Skipping <slug>/` (SB-8).
7. Rejected: delete staging, throw `rejected-by-registry` with the problems. Accepted:
   - apps and connectors: rename to `.mixos/pending/<kind>/<slug>/` and write the sidecar, with
     `filesHash`;
   - themes: rename into `themes/<slug>/`, run the full generator, and on a refusal remove it and
     regenerate. If the full run fails after a passing check, show its output and don't say
     "Nothing is wrong with the extension", which install can't know (approved decision 5).
8. Audit `<kind>.install` with `source`, `version`, `gitTag`, `commitSha`, `contentHash`,
   `filesHash`, the pending path and the verdict.

The result tells the admin what to read (approved decision 4): the pending folder, a link to the
source at the installed commit, what will run (`hooks.ts`, `api/`, `widgets.ts`, `jobs/`, and
`migrations/*.sql`, which the release step applies), the publisher's claims next to what the
package's own manifest declares (egress, env, database, connectors, services, hooks, MCP tools),
the `requiresMixOS` verdict, and the Register button and command.

The Apps and Connectors pages list pending installs with Register and Discard (D3). Discard
deletes the pending folder and sidecar under both locks.

Lesson 09's copy rides here, because the same strings change. The refusals stop saying "cannot"
and "not writable" and say "This deployment runs a build. Install and register in a checkout of
your repository, commit, and deploy." in an info tone, not a warning. The writability probe
checks `.mixos/` for Install, `apps/` or `connectors/` for Register, and `themes/` for theme
installs.

Unchanged (approved decision 8): `predev`, `prebuild`, `pretypecheck`, `registry`,
`premigrate:apps` and `release` run the same generator and still import registered code. The
generator also skips dot-prefixed folders in `scanApps()`, `scanConnectors()` and `scanThemes()`
(approved decision 7), for leftovers and hand-made folders.

### 1.4 Register, activate, and hand back the diff

**Register** has two entry points (owner decision 1): a button on the pending list, after a review
prompt that repeats what will run and asks the admin to confirm they read it, and
`npm run register -- <kind>/<slug>` (`<slug>` alone when unambiguous; inside the dev container
under `npm run dev:docker`).

Both take two locks (lesson 07; D4):

- **`repository.register`, fenced and renewed.** The row lock is a lease that anyone can take
  after 15 minutes, and nothing renews it (`src/lib/platform/lock.ts:32-40,85-94@core-4`). That was
  safe while the only holder was a server action bounded by the generator's 120-second timeout; a
  CLI holder can be suspended or put to sleep. So rank 1 gives the holder `assertHeld()`, run before
  each rename, delete or restore (`update _platform_locks set acquired_at = now() where name = $1
  and holder = $2 returning 1`), and renews the lease every minute while the work runs. A holder
  that finds its row gone stops without touching the disk.
- **The checkout lock**, `.mixos/lock`, created with `O_EXCL` and holding the pid, the hostname
  and a random token. Two processes can resolve different databases for "the same" row lock: the
  CLI's `loadEnv()` reads the shell first, then `.env.local`, then the Docker fallback
  (`scripts/load-env.ts:45,56-60@ops-8`), so a CLI on the host and a dev server in a container can
  each hold it in a different database while editing one checkout. Install, Register, Discard,
  Remove, update, `--recover` and the generator itself take the checkout lock, so `predev` and
  `npm run registry` stop racing an install. A holder that spawns the generator passes its token in
  argv (`--lock-token`), because the child's environment is only `PATH` and `TMPDIR`. A lock is
  stale only when its hostname is this host's and its pid isn't running. A lock from another host,
  such as a container, is never broken automatically: `npm run register -- --break-lock` shows the
  holder and asks.

The CLI reaches the database through ops-8's `loadEnv()` for the row lock and the audit row, and
spawns the generator with `generatorEnv()`, not the loaded environment. Under both locks:

1. Re-check that the pending folder exists and the target doesn't (or, for an update, that the
   live folder matches what the sidecar says it replaces). Recompute `filesHash` over the pending
   folder, leaving out `.registry.json`, and refuse on a mismatch ("changed since it was installed;
   discard it and install again"): what runs has to be what was verified and reviewed.
2. Re-check `requiresMixOS` against this checkout's version (1.10).
3. Rename pending into `apps/<slug>/` or `connectors/<name>/`. For an update, first rename the
   live folder to `.mixos/backup/<kind>/<slug>/` (1.7).
4. Run the full generator. This is the first time the package's code runs, as this checkout's
   OS user.
5. Refused: rename it back to pending, restore any backup, regenerate, report the generator's
   output. Accepted: delete any backup and the sidecar.
6. Audit `<kind>.register` (`via: "button"` with the admin, or `via: "cli"`). A shell has no admin
   identity, and `admin_audit_log.actor_email` is `not null`
   (`supabase/migrations/0004_admin_audit_log.sql:22-28@core-4`) while `recordAdminAction()` takes
   an actor with both an id and an email (`src/lib/apps/admin-audit.ts:30-33,60-63@core-4`). So the
   CLI's rows record `actor_id` null and `actor_email` `cli:<os user>@<hostname>`, `AdminActor.id`
   becomes nullable, and the audit page labels such rows unverified. The release step's rows (1.8)
   use `release:<commit, or "unknown">` the same way.

The Register button is refused on built deployments, with the same marker check as install.

**The hand-back** (§05 option 1). The Register result and the CLI's output say plainly that the
extension now runs in this checkout and has to be committed to ship, and give:

- the files added, with sizes (already in memory);
- a prepared commit message whose subject is built only from validated identifiers (`Add app
  files 1.2.0 from mixos.org`: the kind, the slug, and the version, dotted or hex), never from the
  manifest's `name`, which can be any non-empty string (`scripts/manifest-schemas.ts:682@runtime-10`).
  GitHub skips every push and pull request workflow when the head commit's message holds `[skip
  ci]`, `[ci skip]`, `[no ci]`, `[skip actions]` or `[actions skip]`, or a `skip-checks: true`
  trailer. The provenance trailers come from `.registry.json` and are all validated values
  (`Registry-Source`, `Registry-Version`, `Registry-Commit`, `Registry-Content-Hash`,
  `Registry-Files-Hash`, `Registry-Listing`);
- the commands (`git switch -c add-app-<slug>`, `git add apps/<slug>`, `git commit`, `git push -u
  origin HEAD`), or "run `/mixos deploy`", which already branches, commits, pushes and opens a pull
  request;
- a link to `github.com/<owner>/<repo>/tree/<commitSha>/<subpath>`, which shows the bytes the
  hash verified;
- what shipping means on each host: merging into the branch your host deploys ships it on
  Coolify, Dokploy, Render, Railway and Vercel; plain Compose needs `git pull`, build, migrate
  and up on the server.

The server never runs git. A web process committing to its own checkout is what §06 warns about,
and a developer checkout usually has other work on the current branch.

**Activation** (D2). Browse loses "Install & Activate". The Register result and the CLI name the
checkout's database host, and offer "Activate in this checkout" only when that database is local:
loopback, `host.docker.internal`, or the dev stack's own database. The README documents pointing a
checkout at a shared development database (`README.md:261-265@core-4`), and `setAppActive()`
upserts `is_active` (`src/lib/apps/access.ts:191-207@core-4`), so activating there would activate
the app for every instance on that database, including a staging instance that later deploys it.
On a shared database the result points to Admin > Apps on the instance that serves the app. A
deployed instance gets the app inactive, as today, and an admin activates it on that instance's
Admin > Apps. The docs say so; today no page does
(`src/content/docs/docs/operating/hosting.mdx:385-395@mixos-org`).

**Locked.** A `locked` outcome shows "Another administrator is installing or registering. Try
again in a moment." with a retry button. When the checkout lock is what's held, the message names
its holder instead (for example, the registry generator started by `npm run dev`).

### 1.5 The install record and its origin

`.registry.json`, written by install into the staged tree after `preflight()`, so it is in the
pending folder and moves into place at Register (D5):

```json
{
  "source": "https://mixos.org",
  "kind": "app",
  "slug": "files",
  "version": "1.2.0",
  "gitTag": "v1.2.0",
  "commitSha": "<40 hex>",
  "contentHash": "<as published and verified>",
  "filesHash": "<the same entries with file modes ignored>",
  "repository": { "owner": "acme", "name": "mixos-files", "subpath": null },
  "requiresMixOS": "0.4.0"
}
```

- The first six fields are the approved ones. `gitTag` is nullable (website releases have none,
  runtime-10 commit 47886b8). `filesHash` (1.3) lets Register, the generator and CI check the
  folder against what was verified, offline. `repository` comes from the verified `tarballUrl` and
  `subpath`, so a notice can say when a listing's next release comes from a different repository,
  and it is part of the extension's identity (1.8). `requiresMixOS` lets the build enforce the
  floor on every host (1.10). No `installedAt` and no admin identity: the file is committed, and
  the commit and the audit row already answer when and who.
- `source` is `repositoryBaseUrl()`, the same value the fetch used. It is an origin
  (`client.ts:188@core-4`), and requests use absolute `/api/v1` paths, so an origin identifies a
  catalogue.
- One record per pending install: `.registry.json` inside the pending tree. The sidecar
  `.mixos/pending/<kind>/<slug>.json` keeps only what is pending-only and never committed: who
  installed it, when, the check verdict, and for an update what it replaces. Until rank 9 adds
  `.registry.json`, the sidecar carries `filesHash` for Register's check.
- The generator's `scanRegistryInstalls()` writes `src/generated/registry-installs.ts`:
  `{ kind, slug, version, gitTag, commitSha, source, repository, requiresMixOS, modified }[]` for
  accepted extensions whose file's kind and slug match the folder. A bad or mismatched file is a
  warning; the extension loads and isn't checked. Deployments read only this constant.
- **A folder that no longer matches.** Nothing re-checks a folder against its hash after install
  today, so an edited folder would still say "Installed from mixos.org · 1.2.0" and be offered
  updates as if untouched. `scanRegistryInstalls()` recomputes `filesHash` over the folder, leaving
  out `.registry.json`, and sets `modified: true` on a mismatch. Browse, the notices and the update
  dialog then say "modified locally", and the CI check of 1.11 fails a pull request whose vendored
  folder doesn't match its file. A Windows checkout that rewrites line endings (`core.autocrlf`)
  shows vendored folders as modified; the docs say to work in WSL or turn it off for the
  repository.
- **The join key is `(source, kind, slug)`** (lesson 06). A folder with no file is local: never
  sent, never offered an update. An item is sent only when its `source` equals
  `repositoryBaseUrl()` (approved). Installs from another catalogue are never checked; the admin
  pages show a muted line saying so, and the generator warns when a committed file's `source`
  isn't `https://mixos.org` (D6).
- **The pre-commit stamp skips vendored folders.** `scripts/stamp-updated.ts` (run by
  `.githooks/pre-commit:43@core-4`) rewrites `lastUpdated` in any manifest a commit touches, so
  committing a fresh install changes its bytes. It skips folders with a valid `.registry.json`.
- **Browse** shows "Installed from mixos.org · 1.2.0" (with "modified locally" when it is), "A
  local extension uses this name", or "Installed from <origin>; not checked here", instead of a
  slug-only "Installed".
- Extensions installed before this ships are local (owner decision 4: document reinstalling, no
  adopt command).

### 1.6 Enable and disable, for every kind

**Apps** (exists; close the gaps, D7):

- `forceClaim()` gets the same `apps.is_active` condition as `claim()`. The scheduled-jobs page
  shows an inactive app's jobs as "App inactive" with Run now disabled.
- `services.ts` refuses an `audience: "app"` call when the provider is inactive.
- One app gate checks activation before any of the app's modules is imported: `dispatch.ts` step 6
  (`src/lib/apps/dispatch.ts:169@core-4`), `callAppRoute()` (`call.ts:97@core-4`) and the
  scheduler's job and sync imports (`scheduler.ts:275,295@core-4`). An inactive app's top-level code
  then doesn't run on requests or jobs. Rank 13 later adds the per-app maintenance check to the
  same gate, so it is written once.
- `ensureHooksLoaded()` skips inactive apps. A newly activated app's `hooks.ts` loads on the next
  dispatch. The per-dispatch gate from #6 stays as the second line.
- `/p` pages and the unlock action: #6.
- Docs: an app arrives inactive on each deployed instance and is activated there.

**Connectors** (new):

- A per-connector switch stored in the database, not in the connector's files, so a publisher
  can't flip it: `platform_settings` key `connector.disabled.<name>` (value: when). No migration.
- Enforced in `loadTenantConnectors()` (a disabled connector isn't instantiated, and an app's call
  fails with "disabled by an administrator"), the webhook route (refused as an unconfigured one
  is), OAuth start and callback, Test Connection and the MCP read-only connector wrapper.
- Activating an app whose required connector is disabled is refused, as it is today for an
  unconfigured one (`admin-actions.ts:114-170@core-4`). The check belongs in
  `getMissingTenantConfigConnectors()` (`src/lib/apps/connector-gates.ts:38@core-4`), which the
  unmerged admin-dialog work rewrites, so this part lands after admin-dialog does.
  Until then the switch still stops the connector at runtime, and an app activated against it
  fails its connector calls with the switch's message.
- Admin > Connectors gets Disable and Enable, naming the dependent apps
  (`src/lib/connectors/dependents.ts:22-40@core-4`). Audited `connector.disable` and
  `connector.enable`.
- Credentials are kept. Clearing them is part of Delete data after removal (D8).

**Themes:** one applied theme, by design. Applying is audited as `theme.apply` (D16).

### 1.7 Update, with backup and restore

Under vendoring, an update is a diff to the extension's folder, made in a checkout and shipped by
deploying. The backup that matters in production is git and the previous deploy. The backup
below protects the checkout while the new copy proves itself.

**Choose and download** (an update mode in `installExtension`):

- Preconditions: a `.registry.json` whose `source` equals `repositoryBaseUrl()` and whose kind and
  slug match; no pending install of the same slug.
- **Local edits:** compare the folder with the `filesHash` in its `.registry.json` (1.5), which
  needs no download. When they differ, the update needs an explicit "discard my changes" (D12).
  The installed release is downloaded (same pinned fetch and hash check) only to list which files
  changed, ignoring `.registry.json`, file modes, and a manifest change that is only
  `lastUpdated`. After a yank and a deleted repository GitHub may no longer serve it; the dialog
  then says the folder differs without naming the files.
- **Target:** any release the admin picks, refusing yanked ones unless accepted, as install does.
  The direction comes from the versions when both are dotted (approved rule), and otherwise from
  the releases' published dates (`releasedAt`, `src/lib/repository/types.ts:148-160@runtime-10`).
  Website releases use the short commit SHA as their version
  (`src/lib/registry/publishing-store.ts:716-727@mixos-org`), and when a publisher yanks newer
  releases, mixos.org's current release becomes an older one, so a notice's Update link can lead
  to a downgrade. A target older than the installed release needs an explicit "Install an older
  release", audited as `<kind>.update` with `direction: "older"`.
- **The update dialog:** old and new version, commit and published date, a GitHub compare link,
  changes to permissions, egress, env, database, connectors, services, hooks, MCP tools and
  settings, new `migrations/*.sql` files ("forward-only: back up the database first"), yanked state
  and the `requiresMixOS` verdict. For a downgrade, it lists the migrations the installed release
  has and the target lacks, and says the database stays at the newer schema, the older code has
  to cope with it, and restoring a backup may be the better way back.
- The new tree goes to pending, with the sidecar recording what it replaces.

**Swap at Register** (themes: at install):

1. Under both locks (1.4), with the row lock re-checked before each rename: write
   `.mixos/backup/<kind>/<slug>.json` with the holder's token and what the backup replaces, rename
   the live folder to `.mixos/backup/<kind>/<slug>/`, then pending into place.
2. Run the generator.
3. Refused: rename the new copy back to pending, restore the backup, regenerate. Accepted: delete
   the backup and its sidecar.
4. A leftover backup is acted on only by a process that holds the checkout lock, and only when the
   backup's token isn't the live lock's token, so its holder is gone. The next install, Register or
   removal (and `npm run register -- --recover`) then offers to restore or delete it. A holder that
   was suspended and comes back finds its row lock taken or its file lock replaced, and stops
   without touching the disk. Without this, a CLI suspended mid-swap could come back after the
   dev server had treated its live backup as a crash leftover and deleted it.

Also: the generator prunes its `public/` copies (screenshots, branding, theme assets, connector
assets) for extensions no longer on disk or replaced; today it never removes them
(`generate-project-registry.ts:1160-1175@runtime-10`). The smoke report (1.11) can follow
Register. The audit row is `<kind>.update` with from, to and `localChangesDiscarded`.

Activation, grants, settings and connector configuration are keyed by slug, so they survive the
swap. App migrations are forward-only (ops-8, contain-app-migrations): reverting the code never
reverts the schema, and only a database restore does. The next step says: commit the change to
the folder, deploy, and roll back by reverting the commit or with the host's previous deploy.

Entry points: an Update link on a withdrawn or newer notice when the instance is a checkout, and
on browse cards whose provenance matches. A deployed instance links to the docs, or with the App
to Propose update (1.12).

### 1.8 Remove, with a data choice

Removing code is a repository change, like installing. Data lives in each database. So removal
has two phases (D10), and no publisher code runs in either: there is no uninstall hook.

**Phase 1, remove code, in a checkout.** `removeExtension(kind, slug)`, under both locks (1.4),
checkout only:

- Refuses while something depends on it: an app that requires this connector
  (`getConnectorDependents`), an app that consumes this app's services or listens to its hooks, or
  the last theme (the build fails without one, `generate-project-registry.ts:2244-2248@core-4`).
  Warns about optional dependents and the applied theme.
- Moves the folder to `.mixos/backup/`, regenerates, restores on failure, deletes on success.
  Discards a pending install of the same slug.
- A Remove button on the Apps, Connectors and Themes pages and `npm run remove -- <kind>/<slug>`.
  The dialog has two visibly different buttons (lesson 08): "Remove code, keep data" (default) and
  "Remove code and delete this checkout's data" (destructive styling, typed slug). The second
  calls Delete data (Phase 2) with the same checks, so it is refused while another build on the
  checkout's database still carries the slug.
- Audit `<kind>.remove`. The result says: commit the deletion and deploy; each deployed instance
  keeps the data until an admin deletes it there.

**Phase 2, keep or delete data, on each instance.**

- **The release step marks, never deletes** (D9, rank 2). `syncAppRegistry()` sets
  `apps.missing_since` for slugs not in the build, audited `app.missing`, and clears it when they
  return. No cascade. The gates already refuse a slug the build doesn't have. The scheduler stops
  deleting job rows for apps not in the build (`scheduler.ts:196-203@core-4`), so an admin's
  per-job switch survives a revert. This also makes a rollback to an older build safe for apps it
  lacks, and a generator skip (containment, import allowlist, a load error) stops deleting
  anything.
- **A returning app comes back inactive unless its code is unchanged** (D11, rank 2). Today the
  delete is what makes a returning slug arrive inactive with no grants. Keeping the row would
  otherwise hand whatever next uses the slug the old `is_active`, `user_app_grants`, `user_apps`,
  `app_passwords`, `dashboard_widgets`, `app_scheduled_jobs` and, once admin-dialog lands,
  `app_mcp_tool_settings` (`supabase/migrations/0008_app_mcp_tool_settings.sql:21@admin-dialog`).
  For example: an app is removed after its release is yanked, and months later a different app
  with the same name is committed; on its first request it would be active, with every old grant.
  So at every release step, `syncAppRegistry()` records `apps.code_hash` for each app in the
  build: a hash of the paths and bytes under `apps/<slug>/`, modes ignored, dot entries and
  `node_modules/` skipped, read from disk. The release step can read it on every host: the image
  carries `apps/**` through output tracing (`next.config.ts:49-54@ops-8`), and a checkout and
  Vercel's build have the folder. When a missing slug returns with the recorded hash (a rollback,
  or a generator skip that ended), only `missing_since` is cleared. Otherwise the app comes back
  with `is_active = false` and a "back in the build with different code" flag, audited
  `app.returned` with both hashes, and an admin activates it again with one click.
- **Connectors get the same mark** (rank 24). The release step records each configured connector
  its build lacks in `platform_settings` key `connector.missing.<name>` (value: since), and clears
  it when the connector returns.
- **Which builds use this database** (rank 24). One database is often served by more than one
  build. Vercel's Instant Rollback runs no release step, so a rolled-back build that lacks a
  connector would otherwise list it as removed while production needs it again after rolling
  forward, and a checkout can share a development database (`README.md:261-265@core-4`). Each
  running build records what it carries in `platform_builds_seen` (build key, apps, connectors,
  last seen) at its release step, at server start and on the cron tick, at most every ten minutes,
  pruned after 30 days. The build key is the commit with a hash of the extension sets, or for a
  checkout the random id in `.mixos/checkout-id`.
- Each admin page lists "Removed from this build, data kept", with **Delete data…** (destructive,
  typed confirmation). Keeping is the default and needs no action.
- **Delete data** decides from the database, never from the serving build. It runs in one
  transaction under ops-8's migration lock (`scripts/migration-lock.ts@ops-8`), so it can't race a
  release step, and it is refused when the slug is in the serving build, when no release step has
  marked it missing, or when any other build seen in the last 24 hours carries it. The caller's own
  build key doesn't count, so a checkout can delete its own data right after Remove.
  `admin_audit_log` is always kept. Audited `<kind>.data.delete` with counts.
- For an app, after contain-app-migrations: drop schema `app_<slug>` and role `mixos_app_<slug>`,
  delete its `_migrations` rows, `app_settings`, `app_api_keys`, `app_scheduled_jobs`,
  `app_job_runs`, sync state, `telemetry_events` and `app_open_events` rows, then the `apps` row,
  which cascades to grants, installs, password, widgets and MCP tool settings. Never by table-name
  prefix (SA-2 collisions, `admin-actions.ts:58-89@core-4`).
- For a connector: `connector_configs`, every `user_connector_oauth` and `connector_scope_status`
  row, webhook rows, telemetry and its marks.
- **Same slug, different extension** (D11, rank 10). The release step records each extension's
  identity: for one with a valid `.registry.json`, its `source`, kind, slug and repository owner and
  name from `registry-installs.ts`; otherwise "local". It compares at every release step, for every
  slug in the build, not only when a slug returns, so a change of identity is caught whenever it
  happens. A version or commit change within one identity is an update and isn't flagged, so
  updates don't train admins to click through. When the identity differs from the recorded one,
  the app is set inactive and flagged "replaces a different extension", its API keys are revoked,
  and Activate needs the slug typed, audited `app.identity.changed` with both identities. A
  connector whose identity changes is disabled with the switch from 1.6 until an admin re-enables
  it the same way; its credentials are kept. The migration that adds the column records "local"
  for every existing row, so reinstalling an existing local app from the Registry (owner decision
  4) is flagged once.
- mixos.org needs nothing: an instance that stops listing an extension drops out of active
  installs after 30 days (`0002_repository_api.sql:173-188@mixos-org`).

### 1.9 The update check, and what it sends

The approved design stands, with the payload decided by D1:

- **What is checked:** items from `registry-installs.ts` whose `source` equals
  `repositoryBaseUrl()`. Nothing else is ever sent.
- **When:** from `/api/cron`, after the prunes and in its own catch, 21 hours after the last
  success plus up to an hour of random delay, or at once when the installed set changes. Vercel
  Hobby allows only a daily cron (`docs/hosting/vercel.md:45-49@ops-8`) and fires it anywhere
  within its hour, so two ticks can be about 23 hours apart; with "24 hours plus jitter", a daily
  tick would usually arrive before the check was due and it would run every other day. Under
  `withPlatformLock("repository.update-check")` with a two-minute TTL. Failure keeps the last
  answer, retries in an hour or after `Retry-After`, at most 24 hours.
- **Client:** `getJson()` becomes `requestJson()` so a POST keeps the 8-second timeout, the 4 MB
  cap and the https rule. `RepositoryError` gains `retryAfterSeconds`. Redirects:
  `requestJson()` uses `redirect: "manual"`. A 3xx answer to a POST is a failure, since a 307 or
  308 would re-send the instance ID and items and a 301 or 302 would drop the body. A GET follows
  at most three redirects, each only when the new URL has the same origin (scheme, host and port)
  as `repositoryBaseUrl()`. The MixOS release check (2.4) reuses it.
- **State:** `platform_settings`: `registry_instance_id` and `registry_update_check` (JSON: `sent`,
  `results`, `lastSuccessAt`, `lastAttemptAt`, `lastError`, `nextCheckAt`). No migration.
- **What admins see**, under the header of the Apps, Connectors and Themes pages
  (`registry-notices.tsx`; `Notice` moves to `src/components/ui/notice.tsx`):
  - **Withdrawn**, danger tone, every kind on every page: "Files 1.2.0 was withdrawn by its
    publisher: “Data loss on upgrade from 1.0.x”. The current release is 1.2.1." For an app, a
    Deactivate button (D13), which is an admin's act and fits "show, never act". On a checkout, an
    Update link (1.7).
  - **Newer**, neutral, that page's kind, worded per "newer only when both versions are dotted".
  - **No longer listed**, neutral, when the listing isn't `published`.
  - **requiresMixOS:** "It needs MixOS 0.9.0 or newer; this instance runs 0.8.2", which works once
    the build is stamped (2.2).
  - **Modified locally**, muted, when `registry-installs.ts` marks the folder modified (1.5). The
    other notices still show; Update then needs "discard my changes".
  - One muted line: "Checked with mixos.org 3 hours ago", "Couldn't reach mixos.org since 5 Oct",
    "Not checked yet", or "Update checks are off (MIXOS_UPDATE_CHECK)", linking to what is sent.
- **The switch:** `MIXOS_UPDATE_CHECK`, on by default (owner decision 1), parsed by
  `parseInstallFlag()`, reported by the release step when mistyped. Not in `render.yaml`. With it
  off, nothing is sent and no ID is created. It also turns off the MixOS release check (D29).

**Payload.** Approved (owner decisions 1 to 3): daily `POST /api/v1/updates` with `instanceId`,
`mixosVersion` and `items`, plus `POST /api/v1/installs` (`kind`, `slug`, `version`,
`contentHash`, `instanceId`, `mixosVersion`) after each install. Recommended (D1, option D):

```json
POST https://mixos.org/api/v1/updates
{ "instanceId": "<random UUID>", "items": [{ "kind": "app", "slug": "files", "version": "1.2.0" }] }
```

No `mixosVersion`, and no `POST /installs`: mixos.org counts an install when an instance lists an
extension at a real release it hasn't reported before. It does that through the `installs` table's
existing dedupe on (instance, listing, release), so an upgrade counts and a repeat doesn't, which
is today's rule (`0002_repository_api.sql:154-156@mixos-org`), and `install_count` keeps its
meaning. The reasons are in D1. The core release feed is a separate anonymous GET in every option.

**Privacy**, as approved, adjusted for D1:

- Identity: a random UUID, created the first time there is something to check with the setting
  on, kept in `platform_settings.registry_instance_id`. Not derived from the host, URL, keys or
  users. One database is one instance.
- Sent once a day from the server, never from a browser: the ID and the kind, slug and version of
  each extension installed from this catalogue.
- Not sent: local extensions, users, data, settings, the instance's URL, and (under D1-D) the MixOS
  version.
- Stored by mixos.org: one `instance_extensions` row per instance and extension, deleted 30 days
  after the last check that listed it, and under D1-D one `installs` row per instance and release,
  with no MixOS version. The IP isn't stored in the Registry's database (owner decision 6).
- Off: `MIXOS_UPDATE_CHECK=false` sends nothing and creates no ID. Deleting one extension's
  `.registry.json` stops checking it.

**mixos.org, shipped and confirmed before the core release:**
`supabase/migrations/0011_registry_rollup_schedule.sql` (RG-22: reschedule `registry-rollup` to
`select rollup_and_prune()`; 0009 points it at a function that doesn't exist). Under D1-D, a second
migration has `check_updates` insert an `installs` row for each item at a real release (on
conflict, nothing) and increment `listings.install_count` and `install_stats_daily` only for the
rows it inserts. `supabase/tests/30_installs.sql` covers a first check-in, a repeat, an upgrade and
a version that isn't a release.

### 1.10 requiresMixOS

- The install check exists (`install.ts:741-747@runtime-10`) and starts comparing once the build
  is stamped (2.2), because checkouts then know their version.
- `.registry.json` and the pending sidecar carry the floor. Register re-checks it, in the button
  and the CLI.
- The generator fails the build when a vendored extension's floor is above the build's version
  (D15). Failing beats skipping: a skip would quietly drop the extension from that deploy.
- The register and update dialogs show met or unmet, not only "Requires MixOS X or newer"
  (`register-dialog.tsx:331-335@runtime-10`).
- The comment at `install.ts:726-729@runtime-10` says `build-info.ts` carries the release; it will,
  after 2.2.
- **RG-11 on mixos.org:** no publish path writes `requires_mixos`
  (`src/lib/registry/publishing-store.ts:718-728@mixos-org`), so no release carries a floor. The
  owner kept it separate (decision 5); this plan schedules it as its own mixos.org PR (rank 16) so
  the enforcement has something to enforce. The floor can't be a manifest key. The raw manifest
  schemas are strict and have no such key (`scripts/manifest-schemas.ts:680,1163,1349@runtime-10`),
  so a manifest carrying one fails `preflight()` (`install.ts:416-429@runtime-10`) and aborts the
  build of anyone who vendored it (`generate-project-registry.ts:1419-1424@runtime-10`), until every
  instance runs a core release that accepts it. D36 recommends a flag on `mixos publish` and a field
  on the publish form, written to `releases.requires_mixos`. mixos.org refuses a floor that isn't
  `X.Y.Z` or is newer than the newest core release on its list (rank 21). No release exists yet
  (`package.json:3@core-4` says 0.1.0, and the remote has no tags), so rank 16 waits for the first
  one.

### 1.11 Smoke test: a report after Register, a gate in CI

A register-time gate doesn't fit: after Register an app is inactive and ungranted, a `database:
true` app has no tables until the release step runs, and a rollback can't undo migrations or what
the code did. So:

- **Fix the script.** Read routes from the generated registry's route contracts (path, params,
  methods, auth) instead of a regex. Test every app, not only connector apps. Take `--base-url`.
  Accept `SMOKE_COOKIE` or sign in through the normal password flow with `SMOKE_EMAIL` and
  `SMOKE_PASSWORD`. Print a JSON verdict line. An empty 2xx body passes with a note (D14). A unit
  test with a `defineRoute` fixture keeps the regex bug from coming back.
- **Report in dev.** `npm run register -- <slug> --smoke` runs after both locks are released. It
  runs `migrate:apps`, activates the app and grants the signed-in user in the checkout's database,
  then runs the script. It reports and never rolls back. It runs only when the checkout's database
  is local (1.4). On a shared one it refuses unless `--database-is-disposable` is passed, because
  it would apply unreviewed migrations and grants to a database other instances use.
- **Gate in CI.** A job on pull requests that change `apps/**` or `connectors/**`: a Postgres
  service, generated keys, the release step (which seeds a first admin), `npm run build`, the
  server started, the changed apps activated and granted by SQL on that throwaway database, then
  the script per changed app. A bad class fails the check. The same job fails a pull request whose
  vendored folder doesn't match its `.registry.json` (`filesHash`, 1.5). No repository secrets:
  the job sets `permissions: contents: read`, checks out with `persist-credentials: false`, and
  never uses `pull_request_target`. This is §05's "CI validates", and the check that guards the
  App's pull requests (1.12).
- No admin-only bypass of the activation gate: the smoke caller tests after activation (D14).

### 1.12 The hosted build: a GitHub App on the operator's repository (built last)

Built after the install record, the CI smoke check and the update path, because a proposed pull
request carries `.registry.json`, is checked by CI, and reuses the update dialog.

**Whose App.** One private App per operator, created from the instance through GitHub's manifest
flow and installed on one repository (D18). A shared MixOS App would mean mixos.org, or every
instance, holding a key that writes to every operator's repository.

**Setup.** One App at a time: a new manifest flow is refused while an App is still recorded, so
relinking first unlinks (below).

1. A GitHub page under admin settings posts a manifest form to
   `https://github.com/settings/apps/new` (or the organisation's) with `public: false`, the
   permissions below, no events, an inactive webhook, and a `state` bound to the admin's session.
2. The callback calls `POST /app-manifests/{code}/conversions` within the hour and keeps the App
   id, slug and private key; it drops the webhook secret.
3. The admin installs the App on "Only select repositories", choosing the repository this
   instance is built from. GitHub returns `installation_id` to the setup URL.
4. The instance verifies, with a JWT and a first token: `repository_selection` is `selected`,
   exactly one repository, and its id is not `mixoshq/mixos`'s (compared by id). It records the
   repository id, full name, default branch, whether it is a fork, and its parent, and reads the
   default branch's rules (Permissions, below).

**Storage** (D19). Ids and names in `platform_settings`. The private key encrypted with
AES-256-GCM (the scheme in `src/lib/connectors/encryption.ts:7-30@core-4`) under a new,
independent key, `GITHUB_APP_ENCRYPTION_KEY`; keys are independent by policy
(`src/lib/env/keys.ts:17-23@core-4`). With that key unset, the feature is off. The key gets a
`rotationEffect` entry in `keys.ts` and a one-command re-encryption that takes the old and the new
key, so rotating it doesn't push an admin to relink and leave a live App behind.

**Replace private key.** GitHub creates an App's private keys only in its own settings; there is no
API for it. The admin generates a key there and pastes it. The instance checks that a JWT signed
with it gets the same App id from `GET /app`, re-encrypts it, audits the change, and reminds the
admin to delete the old key in GitHub.

**Unlink.** `DELETE /app/installations/{installation_id}` with the App's JWT, which is GitHub's way
for an App to uninstall itself. Then the instance deletes the encrypted key and the ids, audits the
installation id, and links to the App's settings page so the admin can delete the App and its keys.
Deleting only the instance's rows would leave an installed App whose key can still mint
`contents: write` tokens.

**Tokens.** Minted per operation: a JWT signed RS256 with `node:crypto`, then `POST
/app/installations/{id}/access_tokens` with `repository_ids: [<stored id>]` and one of two shapes:
the write shape `{contents: write, pull_requests: write}`, used only for a proposal's writes, or the
read shape `{contents: read, checks: read, statuses: read, pull_requests: read}`, for the Apps
page's status and the checks before a proposal. They expire within an hour and are never stored,
logged or sent to a browser. Every operation first re-reads the installation, and disables Propose,
audited, when `repository_selection` isn't `selected`, it covers more than one repository, or the
repository id has changed. Otherwise an installation widened later to all repositories would
quietly widen what a stolen key reaches.

**Permissions** (D20): `contents: write`, `pull_requests: write`, the mandatory `metadata: read`,
and `checks: read` and `statuses: read` to show CI. Not `workflows`. `contents: write` can push to
any branch and create or move tags, and only the instance's own code keeps it off the default
branch, which every supported host deploys on push. So Propose needs a rule requiring a pull
request on the default branch. The App reads it with `GET /repos/{owner}/{repo}/rules/branches/
{branch}`, which needs only Metadata read and returns the ruleset rules that apply, at link time and
before every proposal. Propose stays off while no `pull_request` rule applies. Classic branch
protection isn't visible there, and private repositories under GitHub Free can't have rulesets, so
an admin can override with an audited confirmation. The docs give the ruleset: pull requests
required on the default branch with the App not on the bypass list, deletions restricted, and tag
creation and updates restricted. Linking doesn't need the rule.

**Never upstream.** Structurally: the App is the operator's and installed on one repository; it
can't be installed on `mixoshq/mixos` without that organisation's approval. In code: refuse an
installation with all repositories, more than one, or the upstream id; build every API path from
the stored owner and name, never from input or a response; write refs only under
`refs/heads/mixos/`; write tree paths only under the extension's folder; never call a merge
endpoint, update the default branch or enable auto-merge.

**Propose an install** (a built deployment, App linked; Browse says "Propose to
<owner>/<repo>"):

1. Steps 2 to 4 of 1.3, in memory: resolve, the yank gate, `requiresMixOS`, the pinned download,
   the hash check, `preflight()` with its path rules, `filesHash`, and adding `.registry.json`.
   Not step 1: `assertInstallable()` refuses built deployments (`install.ts:308-318@runtime-10`).
   Not steps 5 and 6: nothing touches the instance's disk, and there is no `--check` on the
   instance, because the standalone image doesn't carry the generator's toolchain and D22 doesn't
   bundle it. The repository's CI and the production build's generator are the checks.
2. Before the first proposal and again before each one, read `.github/workflows/*` and
   `render.yaml` on the default branch with the read token, and refuse, naming the file, when:
   - a workflow uses `pull_request_target`;
   - a workflow that runs for pull requests into the default branch, or for pushes to `mixos/**`,
     uses a secret other than `GITHUB_TOKEN`, asks for a write permission, or sets no
     `permissions` (so it inherits the repository default, which can be read and write), unless
     every job in it is skipped for App branches with
     `if: ${{ !startsWith(github.head_ref, 'mixos/') }}`. A `branches-ignore` on a `pull_request`
     trigger filters the target branch, so it doesn't exclude App pull requests;
   - `render.yaml` turns previews on.
   Pull requests from branches in the same repository, unlike forks, receive repository secrets.
   For what the App can't read (Render service previews set in the dashboard, Railway PR
   environments, Coolify preview deployments), the admin confirms a checklist, audited.
3. Refuse when the folder exists on the default branch or branch `mixos/install/<kind>-<slug>`
   exists (that fixed name makes a retry fail cleanly).
4. Blobs for binary files only; one `POST /git/trees` on `base_tree` with text inline, every file
   100644; a commit; the ref; a pull request into the default branch. The branch name, the commit
   message and the pull request title are built only from validated identifiers: the kind, the
   slug (`SlugSchema`), the version (dotted or hex), the short commit SHA and the listing URL. The
   title is `Add <kind> <slug> <version> from mixos.org [skip preview]`, where `[skip preview]`
   tells Render not to build a preview in Automatic mode. The manifest's `name` can be any
   non-empty string (`scripts/manifest-schemas.ts:682@runtime-10`). In a commit message, `[skip
   ci]` and its siblings, or a `skip-checks: true` trailer, would turn off the repository's
   workflows for that commit, and so D22's check. In a title, `[render preview]` would start a
   Render preview in Manual mode, and a preview copies the base service's environment, database URL
   included.
5. The body states what was verified (version, commit, hash, `filesHash`, a link to the source at
   that commit), what will run and when, `requiresMixOS`, any accepted yank, and what merging does
   on this host (on Vercel with migrations: the release step, per D33). The publisher's name and
   claims appear only in the body, labelled as claims, inside a fenced block, with newlines
   collapsed and `[`, `]`, `@` and `#` escaped, so they can't trigger mentions or issue-closing
   keywords either.
6. Audit `<kind>.propose` with the pull request number, URL, branch and head commit, or
   `<kind>.propose.rejected`. Linking, unlinking, overrides and checklist confirmations are
   audited too.
7. The Apps page lists open App pull requests with their CI state next to pending installs. A head
   commit with no check run or status after ten minutes shows "No CI ran" in the danger tone, not
   as pending: GitHub disables workflows on a new fork until its owner enables them, so on many
   forks nothing runs at all. A head commit that differs from the one in the `<kind>.propose` audit
   row shows "changed since proposed", because anyone with push access can add a commit to the
   branch after the App opens it. After merge and deploy, the extension is in the build, inactive,
   and in `registry-installs.ts`.

**Propose an update or a removal.** The same, with a tree that replaces the folder (using the
update dialog of 1.7) or deletes it. Rollback is reverting the merge.

**MixOS update pull requests** (§07 option 2, second half), after the release notices (2.4). For
a fork, first verify on GitHub that upstream's tag points at the feed's commit. GitHub resolves any
commit in a fork network through any repository in it, including a commit that exists only in a
stranger's fork, so a 40-hex check on the feed's `commitSha` isn't enough: a wrong local tag, an
edited feed file or a compromised mixos.org deploy would otherwise put an arbitrary commit into an
"Update MixOS to v0.5.0" pull request in every linked repository. `GET
/repos/{fork}/compare/{commitSha}...mixoshq:{tag}` must return `identical`, and `GET
/repos/{fork}/compare/mixoshq:main...{commitSha}` must return `behind` or `identical`, so the
commit is on upstream's `main`. On a mismatch, or when GitHub can't confirm it, refuse, audit, and
fall back to the compare link. Then create `mixos/update-<tag>` in the operator's repository at
that commit (objects are shared across a fork network) and open a pull request with the notes as
plain text, GitHub's compare numbers and the upgrade checklist (back up first; on Vercel, the
release step). A release that changes `.github/workflows/` needs `workflows`, which the App doesn't
have, so it falls back to a compare link. Private copies, which can't be forks of a public
repository, get the link and the `git fetch upstream && git merge <tag>` steps. Never merge.

**Where the proposed code first runs.** In the repository's CI on the pull request (`npm run build`
runs the generator; the smoke job of 1.11), which step 2 keeps free of secrets and write tokens.
On Vercel, every pushed branch also gets a Preview build with Preview variables, so `vercel.json`
sets `git.deploymentEnabled: {"mixos/**": false}` (D22). Render copies the base service's
environment into a preview, so `render.yaml` sets `previews: { generation: off }` (it has no
setting today, `render.yaml:10-27@core-4`) and App titles carry `[skip preview]`. Railway PR
environments and Coolify preview deployments must be off while the App is linked; the host pages
say so, and the checklist asks. Rank 30 also makes the core's own workflows safe for App branches:
`danger.yml` asks for write scopes on `pull_request` (`.github/workflows/danger.yml:7-23@core-4`),
so its job gets the `mixos/` condition, and `ci.yml`, which runs the generator with `contents:
read` and no secrets (`.github/workflows/ci.yml:11-19@core-4`), checks out with
`persist-credentials: false`.

**Limits.** GitHub allows about 80 content-creating requests a minute and 500 an hour; the tar
reader accepts up to 5,000 files and 64 MB (`src/lib/repository/tar.ts:59-65@runtime-10`). Inline
text keeps a package to a handful of requests; the number of binary files on this path is capped.

### 1.13 What each host does differently

| | Compose (plain) | Coolify, Dokploy | Render | Railway | Vercel |
|---|---|---|---|---|---|
| Install, Register, Remove code | Refused on the server (`server.js`); done in a checkout | Same | Same | Same | Refused (`VERCEL`) |
| How the result ships | Commit and push; on the server `git pull`, `docker compose build`, `run --rm migrate`, `up -d` | Merge; deploys on push when auto-deploy is on | Merge deploys; pre-deploy release step; held until `/api/health/ready` passes | Same as Render | Merge puts production live; release step in the production build (D33, rank 14) |
| A newly deployed app | Inactive; activate on Admin > Apps | Same | Same | Same | Same |
| An app removed from the build | Release step marks it missing; data kept | Same | Same | Same | Same, when the release step runs; Instant Rollback runs none, so it marks nothing |
| Update check tick | `cron` sidecar calls `/api/cron` every 5 minutes | Same compose file | Render cron job | Railway cron service | Vercel Cron: every 5 minutes on Pro; once a day, within the hour, on Hobby |
| App pull requests | Merging doesn't deploy; pull and rebuild | Deploys on merge; preview deployments must be off | Deploys on merge; previews off in `render.yaml`, `[skip preview]` in titles | Deploys on merge; PR environments must be off | Production on merge; previews for `mixos/**` turned off in `vercel.json` |
| Repository name for links and the App | A setting | A setting | `RENDER_GIT_REPO_SLUG` | `RAILWAY_GIT_REPO_OWNER`, `RAILWAY_GIT_REPO_NAME` | `VERCEL_GIT_REPO_OWNER`, `VERCEL_GIT_REPO_SLUG` |

### 1.14 Security notes

- **Nothing a package ships runs before Register.** Install's check runs in a child with `PATH` and
  `TMPDIR` only, reads text, and imports nothing. `.mixos/` is never scanned, built, traced,
  migrated or copied into an image. Registering runs the code as the checkout's OS user; the
  generator child still gets only `PATH` and `TMPDIR`, but the dev server then loads the app with
  its full environment, which the review prompt says (owner decision 1 accepted a button for this).
- **What review sees is what runs.** Preflight refuses paths that collide after case folding or
  NFC normalisation, control and bidi characters in paths, and `.git`; install leaves out
  `.gitignore` and `.gitattributes`, which the content hash still covers. Register refuses a
  pending folder whose `filesHash` changed after install. The check's verdict comes from a file
  the parent names, never from the child's output.
- **Provenance can't be forged by a publisher:** preflight refuses a package that ships
  `.registry.json`. A hand-edited file only changes which notices show, and `filesHash` lets
  Register, the generator and CI tell when a folder no longer matches what was verified.
- **Parsing mixos.org's answer:** loose Zod; malformed items dropped; results used only for items
  sent at the version sent; `tarballUrl` and hashes ignored; the withdrawal reason treated as plain
  text (trimmed, control characters removed, at most 500 characters); https only, with no
  plaintext retry (unlike WordPress); 8-second timeout; 4 MB cap; redirects only to the same
  origin, and never on a POST. The answer drives notices only.
- **A slug's data never passes silently to different code.** A returning app with different code
  comes back inactive (rank 2). Rank 10 adds the identity check: an extension whose identity
  changes stays off, loses its API keys and needs a typed confirmation (1.8).
- **Delete data** is admin-only, needs a typed confirmation, works only on slugs a release step has
  marked missing and no other recent build carries, drops by schema and role, never by name
  prefix, runs under the migration lock and is audited.
- **Checkout actions on a shared database:** "Activate in this checkout" and `--smoke` run only
  against a local database.
- **Switches live in the database,** never in an extension's own files.
- **GitHub App:** a private App per operator, one at a time; one repository, verified by id, never
  upstream, and the installation re-checked on every operation; tokens minted per operation in a
  write or a read shape, narrowed to one repository id, never stored, logged or sent to a browser;
  the key encrypted under its own key, the feature off without it, replaceable and rotatable;
  unlink uninstalls the App; Propose only with a pull-request rule on the default branch (or an
  audited override), and only when no workflow would run the proposed code with secrets or a write
  token; branch names, titles and commit messages from validated identifiers only, the publisher's
  text fenced in the body; refs only under `mixos/`, paths only under the extension's folder; no
  merge, no default-branch write, no auto-merge; no `workflows` permission; webhooks off; previews
  off for its branches; update branches only at a commit GitHub confirms is upstream's tag; every
  link, unlink, override and proposal audited; commits by the App's bot with no admin email (D22).
  Every GitHub response is Zod-parsed.
- **Locks:** install, Register, Discard, update, removal and the update swap all take
  `repository.register`, fenced and renewed, and the checkout lock; the generator takes the
  checkout lock; Delete data takes the migration lock.

### 1.15 Tests

Unit (`npm test`):

- `generatorEnv()` passes only `PATH` and `TMPDIR`. `checkExtension()` maps accepted, rejected and
  a check that didn't run; it ignores a verdict-looking line in stdout or stderr and requires
  exactly one verdict in the file.
- `--check` on fixtures: a schema error, a containment finding, a bare handler, an undeclared role,
  `raw` without its escape, a non-literal option (reported as deferred), a `route.tsx`, a SQL
  statement the policy refuses. Each is rejected naming the file, with no pending folder left. A
  staged app that imports `@apps/<own-slug>/…` and consumes a registered app's service is
  accepted.
- `preflight()` refuses `api/report/route.ts` beside `API/report/route.ts`, an NFC and NFD pair, a
  path with a newline, a C1 control or a bidi control, and a `.git` at any depth. A package with a
  `.gitignore` and a nested `.gitattributes`, in any case, installs without them, and its
  `filesHash` matches the folder.
- The generator skips dot folders in all three scans.
- `filesHash`: equal for a tree with and without execute bits; Register refuses a pending folder
  edited after install; `scanRegistryInstalls()` sets `modified` for an edited folder.
- `.registry.json`: schema; preflight refuses a packaged one; install writes the verified values;
  `scanRegistryInstalls()` lists a good file and warns on a bad or mismatched one; the stamp hook
  skips vendored folders.
- `policy.test.ts`: unset is on; `false`, `0`, `off` are off; a typo is off and reported.
- `updates.test.ts`: `describeUpdate()` for withdrawn (with and without a reason, with nothing to
  move to), newer and older dotted versions, SHA versions, an all-digit SHA, `requiresMixOS`
  blocked, met and unknown, an archived listing; scheduling after success, failure, `Retry-After`
  and a changed installed set, with a 5-minute tick, a 24-hour tick and a Hobby tick 23 hours after
  the last; answers for items not sent ignored; the reason cleaned and capped.
- `client.test.ts` against a local `node:http` server: the body holds exactly the D1 fields; a
  timeout, an oversize body, non-JSON, a 503, an off-host redirect, a same-host https-to-http
  redirect and any 3xx to the POST each become the right `RepositoryError`.
- Lock: a try-lock refusal, takeover after the TTL, holder-scoped release
  (`MIXOS_TEST_DATABASE_URL`, the pattern in `src/lib/db/query.integration.test.ts`); a holder
  whose row was taken stops at `assertHeld()` before touching the disk; renewal keeps a long holder
  alive. The checkout lock: `O_EXCL`, stale only for this host and a dead pid, never across
  hostnames; the generator accepts its parent's token; recovery refuses a backup whose holder is
  alive.
- Audit: a CLI row has a null `actor_id` and a `cli:` actor and shows as unverified.
- Removal refuses a required connector, a consumed or listened-to app, and the last theme.
- Activation: Run now refuses an inactive app; an `audience: "app"` call to an inactive provider is
  refused; an inactive app's route and job modules aren't imported; its `hooks.ts` isn't loaded.
  "Activate in this checkout" and `--smoke` refuse a shared database.
- Connector switch: each enforcement point refuses a disabled connector.
- Update: local edits found from `filesHash` with no download; the listed files ignore modes,
  `.registry.json` and a `lastUpdated`-only change; a downgrade by date needs the explicit
  confirmation; a canary that fails registration after the swap restores the old copy; a leftover
  backup is found.
- Smoke script: a `defineRoute` fixture produces requests; the JSON verdict line.
- Release notes: a Markdown link and an autolink render as text.
- GitHub App against a local fake GitHub: manifest conversion, refused while an App is recorded;
  refusing all-repository, multi-repository and upstream installations, at link and when an
  installation is widened later; both token shapes narrowed; unlink calls the uninstall endpoint;
  "Replace private key" refuses a key for another App; Propose refused without a `pull_request`
  rule and allowed after the override; the workflow check refuses `pull_request_target`, a secret, a
  write permission and a missing `permissions`, and accepts the `mixos/` job condition; a manifest
  `name` holding `[skip ci]`, `[render preview]`, a newline and `skip-checks: true` never reaches a
  branch name, commit message or title; tree, commit, ref and pull request calls; refusing an
  existing folder or branch; "No CI ran" and "changed since proposed"; an update branch refused
  when the compare isn't `identical`; no merge endpoint ever called.

Postgres integration:

- The release step marks a missing app and clears the mark when it returns, with no cascade.
- A returning slug with the recorded `code_hash` keeps `is_active`; with a different one it comes
  back inactive, with an `app.returned` row.
- An identity change (local to Registry, or another repository) sets the app inactive and revokes
  its API keys; a new version from the same repository doesn't.
- Delete data refuses a slug no release step marked, and a slug another build seen in the last 24
  hours carries, and allows the caller's own build; it drops the schema, role, ledger rows,
  settings and keys, and keeps the audit log.
- `check_updates` (mixos.org, `supabase/tests/30_installs.sql`): a first check-in counts, a repeat
  doesn't, an upgrade does, and a version that isn't a release doesn't.

End to end, with the site running locally (`astro dev`) and a core dev server on
`MIXOS_REPOSITORY_URL=http://localhost:4321`:

1. A canary app whose `widgets.ts`, `route.ts` and `hooks.ts` each write a marker and record
   whether `DATABASE_URL` is set. Install it: no marker, `src/generated/` unchanged, the dev server
   never loads it, `npm run migrate:apps` skips its migration. Register it: all three markers.
2. A connector installs to pending and registers; a theme installs and registers at install.
3. `npm run registry` lists the canary in `registry-installs.ts`. `/api/cron` with `CRON_SECRET`
   returns `updateCheck: checked`, and the site's `instance_extensions` has a row.
4. `mixos yank <version> --reason "test"`, then `mixos archive`; move `nextCheckAt` back and tick:
   all three admin pages show the reason, and the app's notice offers Deactivate.
5. Stop the site and tick: `failed`, the notice stays, the line says when mixos.org was last
   reached. `MIXOS_UPDATE_CHECK=false`: `off`, nothing changes on the site.
6. Update the canary to a new release with a local edit: the edit is listed; a failing new copy is
   restored.
7. Remove the canary; deploy-equivalent (`npm run release`): the app is marked missing, grants and
   widgets kept. Restore it unchanged and release: it comes back active. Remove it, change one
   file, restore and release: it comes back inactive with an `app.returned` row.
8. Remove it again and release: Delete data from this checkout removes its data, because the only
   other build that carried it is this checkout's own.
9. `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`; `npm run registry` writes the
   same files before and after the change.

### 1.16 Docs to update

Core:

- `docs/security-architecture.md`:
  - §31: the step list (staging, check without running, pending, Register under the lock), the
    `brokenToolchain` paragraph replaced by the verdict, the provenance file, the update check
    (what is sent, shown and never acted on), update with backup, remove code, Delete data, and the
    GitHub App. "Nothing here execs a source file" goes; the approved **What runs, and when**
    subsection replaces it.
  - §24: the scan runs on every build, every registration and in every install's check.
  - §20: Run now refuses an inactive app. §23: an inactive provider's `audience: "app"` services
    are refused. §25: activation is checked before the route import. §19: connector switch.
  - §28: the new audit actions, and that CLI and release-step rows are unverified. §8: Delete
    data drops the app's schema and role, and a returning or swapped slug doesn't inherit its
    activation, grants or API keys.
- `docs/hosting/README.md`: the variables table (`MIXOS_UPDATE_CHECK`, `MIXOS_RELEASE_CHANNEL`,
  `GITHUB_APP_ENCRYPTION_KEY`), "What MixOS sends to mixos.org", "Fixing what an instance runs",
  "Removing an extension", "An app arrives inactive" (and comes back inactive with different
  code), checkout actions on a shared database, and the GitHub App: the ruleset to add, the
  workflows and previews it checks. The four host pages: what a merge does; Vercel, previews of
  `mixos/**` and Hobby's daily cron; Render, previews off and `[skip preview]`; Railway, PR
  environments off.
- `docs/apps/database.md` (data kept on removal), `apps/AGENTS.md`, `connectors/AGENTS.md`,
  `themes/AGENTS.md` (the Register step), `.claude/skills/mixos/actions/app.md` (the smoke script),
  `.claude/skills/mixos/actions/deploy.md` (committing a registered extension).
- `OS-UPDATES.md` (`.registry.json` stays inside the extension's folder), README, `WHATS-NEW.md`,
  `.env.local.example`, `deploy/.env.example`, `docs/plans/README.md`.

mixos.org:

- `extending/publishing.md`: "Installing happens in a source checkout" becomes Install, Register,
  commit, deploy; "Yanking, not deleting" says installs see the reason within about a day unless
  checks are off; updating and removing replace "no in-place upgrade yet" (`:41-42`).
- `extending/cli.md`: the yank row.
- `api.md`: "Staying current", "Turning it off" (`:313-323`), "What we record" per D1, and the IP
  sentence per owner decision 6.
- `operating/hosting.mdx`: the environment table; "Installing from the Registry on a deployment"
  (an app arrives inactive; activate it there); the removal sentence (`:312-313`); the GitHub App.
- `operating/upgrading.mdx` "Extensions and versions": the installer enforces `requiresMixOS`
  (DO-14), the notices, how to update an extension, and that migrations don't roll back.
- `operating/securing.mdx` "What to watch": withdrawn notices, Deactivate and the connector switch
  as incident response.
- `concepts/permissions.md`: activation, the connector switch, removal and data.
- `security/surface.md` follows §31 through `scripts/sync-docs.mjs`.
- `src/pages/extend/[segment]/[slug].astro:60-61` (the `mixos install` command that doesn't exist)
  and `src/pages/extend/index.astro:52-53` ("Install any of it from inside MixOS") (D23).

---

## Part 2. MixOS's own updates

### 2.1 What exists already

| Area | On 8 October 2026 | Evidence |
|---|---|---|
| Version | `mixosVersion()` reads `MIXOS_RELEASE`. Nothing sets it on any host. `package.json` says 0.1.0 and nothing reads it at runtime | `src/lib/platform/version.ts:56-60@core-4`; `Dockerfile:128@core-4`; `package.json:3@core-4` |
| Commit | `mixosCommit()` reads `MIXOS_COMMIT`. Nothing sets it. The hosts' own commit variables are unread | `version.ts:63-66@core-4`; `Dockerfile:141@core-4` |
| Build stamp | `build-info.ts` holds `EXPECTED_SCHEMA_VERSION` (and `EXPECTED_APP_MIGRATIONS` on #8), deliberately no version or commit | `scripts/generate-project-registry.ts:1998-2013@runtime-10` (`:2037@core-4`, `:2053@ops-8`) |
| Shown anywhere | No. `describeBuild()` has no callers | `version.ts:191@core-4` |
| Repository-URL lock | `isReleaseBuild()` means "`MIXOS_RELEASE` is set", so it is inert | `src/lib/repository/client.ts:123-125,158-168@core-4` |
| Tags and releases | No tag workflow, no tag, no GitHub Release, no `CHANGELOG.md`. The repository is private. The release-versioning plan is unbuilt and stamps Vercel production only | `.github/workflows/ci.yml:1-9@core-4`; `docs/plans/20260921_0842-release-versioning.md:20-50@core-4` |
| Schema check | Migration 0007's row, `EXPECTED_SCHEMA_VERSION`, readiness 503 `schema-behind`, and on #8 `app-migrations-behind`. Deliberately at readiness, not in `register()`, which also runs during `next build` | `src/lib/platform/schema-version.ts:20-37,94-172@core-4`; `src/app/api/health/ready/route.ts:44-61@core-4`, `:66-82@ops-8` |
| Request path | Nothing else consults it. Pages, APIs, `/api/cron`, webhooks and MCP run new code against an old schema | `src/proxy.ts:168-179@core-4`; `src/app/api/cron/route.ts:53-60@core-4` |
| Operator message | Still names `db:push` and `db:local` | `schema-version.ts:156@core-4` |
| Duplicate numbers | The runner treats a number as applied if any ledger row has it; Danger checks the bump, not uniqueness. admin-dialog's `0008_app_mcp_tool_settings.sql` collides with #4's `0008`, and both bump the version to 8; migrations-wip adds `0009_app_schemas.sql` | `scripts/platform-migrations.ts:35,55,104-110@ops-8`; `dangerfile.ts:153-204@core-4`; `0008_app_mcp_tool_settings.sql:36@admin-dialog` |
| Release step | Compose `migrate` service; Render and Railway pre-deploy plus readiness; Vercel by hand, and the Vercel page says its build "doesn't run migrations by itself, and shouldn't" | `deploy/docker-compose.yml:95-121@core-4`; `render.yaml:23,26@core-4`; `railway.json:8-9@core-4`; `docs/hosting/vercel.md:51-62@ops-8` |
| Release feed | Nothing reads releases | `client.ts:9-13@core-4` |
| Safe Markdown | `Markdown` drops raw HTML and blanks script URLs. Images load from any https host, which the CSP allows, and any http(s) link stays clickable | `src/components/ui/markdown.tsx:56-67,141-150@escapes-5`; `src/proxy.ts:135@core-4` |

### 2.2 Stamp the build

- **Version** (D24): `writeBuildInfo()` adds `export const MIXOS_VERSION = "<package.json version>"`.
  Every build runs the generator (`prebuild`; the Dockerfile runs `npm run build`), so every host
  and every checkout gets it. It is stable per checkout, so `predev` still rewrites an identical
  file. `mixosVersion()` returns it. `MIXOS_RELEASE` stops being a version source and the
  Dockerfile's `ARG` goes: two sources is what the comment at `version.ts:31-43@core-4` warns
  against, and `package.json` is in every build context, unlike a runner-stage argument.
- **Commit** (D26): `mixosCommit()` takes, at runtime, the first value that is a valid commit SHA
  from `MIXOS_COMMIT`, `VERCEL_GIT_COMMIT_SHA`, `RENDER_GIT_COMMIT` and `RAILWAY_GIT_COMMIT_SHA`.
  Empty counts as unset: the runner stage sets `MIXOS_COMMIT` from an argument that defaults to
  an empty string (`Dockerfile:141-142@core-4`), and Render and Railway build without it, so a `??`
  chain would stop at the empty value and never reach their variables. Compose passes it as a
  build argument (`MIXOS_COMMIT=$(git rev-parse HEAD) docker compose build`), which needs rank 3 to
  add `args: { MIXOS_COMMIT: ${MIXOS_COMMIT:-} }` to the `x-image` build block, which has none
  (`deploy/docker-compose.yml:27-31@core-4`). On Coolify, set `MIXOS_COMMIT=$SOURCE_COMMIT`;
  Coolify provides `SOURCE_COMMIT` at runtime. Elsewhere an unknown commit shows as unknown.
- **Release build** (D25): `isReleaseBuild()` stops meaning "has a version". It becomes "a built
  deployment" (the marker check moves from `install.ts:258-259@runtime-10` to a shared
  `src/lib/platform/build.ts`). A built deployment ignores `MIXOS_REPOSITORY_URL` unless it points at
  loopback or `host.docker.internal`, so `npm run docker:prod` can still test against a local
  catalogue.
- **Shown** on the admin pages only: "MixOS 0.4.2 · commit 3e1f0a2", never on an unauthenticated
  endpoint (security §18). The public readiness JSON stops returning schema numbers in rank 12
  (D31, SB-10); they go to the log.
- The stale comments go: `Dockerfile:113-142@core-4`, `version.ts:31-43@core-4`, the generator's
  build-info header, `install.ts:726-729@runtime-10`.
- The update check's privacy text and the requiresMixOS line follow: every build now knows its
  version.

### 2.3 Releases: tags, GitHub Releases, notes

The [release-versioning plan](20260921_0842-release-versioning.md) holds, amended (D27):

- The version lives in `package.json`. A release is a pull request that bumps it and prepends a
  `CHANGELOG.md` section from the Conventional Commits since the last tag. The 0.x bump rule
  stays: breaking or `os`-scoped means minor; everything else, patch.
- A human pushes the annotated tag `vX.Y.Z` on the merge commit on `main`, then publishes a
  **GitHub Release** for it with that changelog section as notes (`gh release create`). A bare tag
  never appears in the Releases API and has no notes, date or prerelease flag. The release list on
  mixos.org (2.4) accepts only annotated tags on `main`.
- Its "`MIXOS_RELEASE` only in Vercel production" decision is replaced by 2.2's stamp on every
  build.
- `/mixos deploy release` gets the Release section the plan describes, plus the GitHub Release step
  and syncing the site's release list (2.4).
- The upgrade docs move from "merge `upstream/main`" to "merge the release tag".

### 2.4 The release feed: read-only, with semver and a channel

**Source** (D28). The owner chose GitHub Releases
(`GET https://api.github.com/repos/mixoshq/mixos/releases`). That works only once the repository
is public: an anonymous request returns 404 today, and the remote has no tags yet. The
alternative is a list mixos.org generates from the core repository's tags and `CHANGELOG.md` when
the site is synced for a release (rank 21), served as `GET https://mixos.org/api/v1/mixos/releases`.
It works while the repository is private, keeps one outbound host, which already has the https
rule and the release-build lock, avoids GitHub's per-IP limit of 60 an hour on shared host egress,
and records nothing (api.md: GETs record nothing). Rank 22 reads whichever source D28 picks, and
switching later changes a URL and the rate-limit handling. The GitHub Releases from 2.3 are the
human-facing copy of the same notes.

**How mixos.org builds the list** (rank 21, under every option, since floors need it too). From
the GitHub remote, never from a local checkout's tags: `git ls-remote --tags` on the core
repository's remote, peeling `^{}`, keeping only annotated `vX.Y.Z` tags whose commit is on
`main`, and failing the sync when a local tag differs from the remote one. `scripts/sync-docs.mjs`
reads `../mixos` on whatever branch, with whatever local tags it has
(`scripts/sync-docs.mjs:43-47@mixos-org`), and its output is committed, so a local tag on an
unmerged commit would otherwise reach every instance. The sync also writes a page per release on
mixos.org, which the notice links to while the repository is private.

```
GET https://mixos.org/api/v1/mixos/releases
{ "releases": [{ "tag": "v0.5.0", "commitSha": "<40 hex>", "publishedAt": "…",
                 "prerelease": false, "notes": "<markdown>" }] }
```

**Check** (`src/lib/platform/releases.ts`):

- `fetchCoreReleases()` uses rank 20's `requestJson()` with a full URL, a fixed
  `User-Agent: MixOS` (no version), redirects only to the same origin, and a cap of 512 KB.
- Zod: `tag` must match `^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$`; `commitSha` 40 hex; `notes` capped at
  20 KB; unknown keys dropped; a bad entry ignored, not the batch.
- `runReleaseCheck()` from `/api/cron`, in its own catch, under
  `withPlatformLock("platform.release-check")`: due 21 hours after the last success plus up to an
  hour of jitter, so Vercel Hobby's daily tick always finds it due (1.9); after a failure, an hour
  later, or at a rate-limit reset, at most 24 hours.
  State in `platform_settings.mixos_release_check` (`latest`, `lastSuccessAt`, `lastAttemptAt`,
  `lastError`, `nextCheckAt`). Not a per-process cache: on a serverless host that would mean one
  call per warm instance.
- The same switch as the extension check (D29): `MIXOS_UPDATE_CHECK=false` sends nothing.

**Semver and channel:**

- `version.ts` exports a comparison that classifies major, minor and patch. `parseVersion()` drops
  pre-release suffixes today (`version.ts:80-98@core-4`), so the feed uses its own strict tag parse.
- The channel, as the owner decided (D29): `MIXOS_RELEASE_CHANNEL`, `stable` by default, parsed
  like the install flags and reported by the release step when mistyped. Under `stable`, entries
  marked prerelease, or with a suffix, are ignored; `prerelease` includes them.
- Under 0.x, a minor bump is labelled "may need changes" and a patch "fixes", matching the bump
  rule.

### 2.5 Never auto-apply

- The notice, on the admin pages: "MixOS 0.5.0 is available (this instance runs 0.4.2). A minor
  release: it may need changes." Then the notes, collapsed, with links shown as text (D30), and
  two links built here, never from a URL in the payload. The release page, from the validated tag:
  mixos.org's page for the release while the repository is private, since GitHub's would be a 404
  for anyone without access, and `https://github.com/mixoshq/mixos/releases/tag/<tag>` once it is
  public. And `/docs/operating/upgrading`.
- No apply button. Applying is merging the tag into the operator's repository and deploying, which
  is the deploy on four of five paths. A test asserts the check writes nothing but its own state
  row.
- Once the App is linked (1.12), the notice can offer "Open an update pull request", an explicit
  admin act that opens a pull request and never merges.
- Nothing in MixOS runs `git pull`, `npm ci` or a build from the admin UI. That stays rejected.

### 2.6 The schema gate, before any request

"At boot", literally, is `register()` in `src/instrumentation.ts`, which also runs during
`next build`, where there is no database (`schema-version.ts:20-37@core-4`). So the gate runs
before every request instead, from a 15-second cache.

- **`src/lib/platform/maintenance.ts`:** `maintenanceState()` combines `schemaVersionStatus()` and
  ops-8's `appMigrationStatus()` into `{ platformBehind, appsBehind: Set<slug> }`. "Can't tell"
  counts as not behind, as readiness does.
- **The proxy** (D32): when the platform schema is behind, every path except
  `/api/health/live` and `/api/health/ready` gets 503 with `Retry-After: 30`: a plain maintenance
  page for pages (static, no app code, no database), JSON for `/api/*`. That includes `/api/cron`
  (the tick waits), `/api/webhooks` (senders retry) and `/api/mcp`. Next 16's proxy runs on the
  Node.js runtime, so it can call the cached check.
- **Per app** (rank 13): when only an app's migrations are behind, the app gate from rank 25
  (`dispatch.ts`, `call.ts`, the job imports) and its pages answer "this app is being updated"
  (503); the rest of the instance serves. It joins that gate rather than adding a second check
  before the same imports.
- **No version numbers** in any public response; the server log names the versions and files.
- The operator message names the release step (`node ops/release.cjs`, `npm run release`), not
  `db:push`.
- **Duplicate migration numbers** (D34) are refused by the runner (naming both files), by the
  generator's `expectedSchemaVersion()` (the build fails), and by Danger. admin-dialog's `0008`
  becomes the next free number, with the matching `platform_schema_version` bump, when it rebases.

**Holding a rollout.** Render and Railway already hold a new revision until `/api/health/ready`
passes; Compose starts the app only after the `migrate` service exits 0. Vercel goes live on merge
without either (DO-4). D33 runs the release step in Vercel production builds (rank 14): a
`vercel-build` script runs `next build`, then the release step only when `VERCEL_ENV=production`.
After the build, so a compile failure leaves the database untouched. Run before it, where
`prebuild` runs the generator today, a migration followed by a failed compile would leave the old
deployment serving against a migrated schema, which the maintenance gate doesn't catch, since it
guards only a database that is behind. Migrations stay compatible with the deployment that serves
until promotion: add in one release, remove in a later one. The maintenance response is the
backstop. Rollback is the host's previous deploy plus a database restore: no images are
published, so there is no previous image tag. Rolling back runs the older build's release step on
hosts that have one, which after 1.8 marks apps it lacks instead of deleting them. Vercel's Instant
Rollback runs none, so it marks nothing, and Delete data stays refused for what the rolled-back
build lacks (1.8).

### 2.7 What each host does differently

| | Compose (plain) | Coolify, Dokploy | Render | Railway | Vercel |
|---|---|---|---|---|---|
| Version | Stamped at image build | Same | Same | Same | Stamped at `npm run build` |
| Commit | `MIXOS_COMMIT` build argument | Coolify: `MIXOS_COMMIT=$SOURCE_COMMIT`; Dokploy: a variable if it offers the commit, otherwise unknown | `RENDER_GIT_COMMIT` | `RAILWAY_GIT_COMMIT_SHA` (GitHub-triggered deploys) | `VERCEL_GIT_COMMIT_SHA` |
| Release step | `migrate` service before `app` | Same | `preDeployCommand` | `preDeployCommand` | `vercel-build`, after `next build`, in production only (D33, rank 14); today by hand |
| What holds new code back | App waits for `migrate` | Same | `/api/health/ready` | `healthcheckPath` | A failed release step fails the build; nothing today |
| Maintenance response | Backstop | Backstop | Backstop | Backstop | Backstop, and the guard wherever the release step didn't run |
| Release check | `cron` sidecar | Same | Cron job | Cron service | Vercel Cron (Hobby: once a day) |
| Applying a release | Merge the tag in a checkout and push; on the server pull, build, migrate, up | Merge and push; auto-deploy | Merge deploys | Merge deploys | Merge puts production live |
| Rolling back | Rebuild the previous commit; restore the database if migrations ran | Platform rollback plus restore | Render rollback plus restore | Railway rollback plus restore | Instant Rollback (no release step, so nothing is marked) plus restore |

### 2.8 Security notes

- **The release feed** is a GET that sends an IP and `User-Agent: MixOS`, nothing about the
  instance. It never carries the update check's instance ID.
- **Parse, don't trust:** strict tag pattern, Zod with caps, unknown keys dropped, malformed entries
  ignored, size cap, same-origin redirects only. A release build reads only the upstream source
  (the URL lock, 2.2). The list itself is built from the GitHub remote's annotated tags on `main`
  (2.4), and an update pull request is opened only at a commit GitHub confirms is upstream's tag
  (1.12).
- **Rendering notes:** the `Markdown` component from #5 with raw HTML dropped, images dropped (the
  CSP allows `img-src https:`, so a tampered body could put a tracking image in front of every
  admin), and links rendered as plain text: the link text, then the URL in parentheses, not
  clickable. The component keeps any http(s) link clickable today
  (`src/components/ui/markdown.tsx:56-67,144-148@escapes-5`), so the notice passes its own `a`
  component. The notes come from Conventional Commit subjects, so a merged pull request titled
  `fix: [apply the security patch](https://evil.example/…)` would otherwise put a live link in a
  "MixOS 0.5.1 is available" notice on every admin page. Body capped at 20 KB and collapsed (D30).
  The only clickable links are the two built here (2.5). No URL from the payload is ever fetched.
- **Maintenance response:** no version or schema numbers; health endpoints exempt; details in the
  log.
- **The version** shows only to admins; readiness stops exposing schema numbers.
- **The commit** comes from the host's environment, never from a request header.
- **Duplicate migration numbers** fail loudly instead of skipping a file silently.

### 2.9 Tests

- `version.test.ts`: the stamped version; the commit fallbacks in order, including `MIXOS_COMMIT`
  set but empty with `RENDER_GIT_COMMIT` set; the new `isReleaseBuild()` with and without a
  loopback override; `describeBuild()`; `satisfiesMinimum()` (none exist today).
- `releases.test.ts` against a local `node:http` server: timeout, oversize body, non-JSON, 404, a
  rate-limit 403 or 429 with a reset, malformed entries dropped, prerelease and suffixed tags
  ignored under `stable` and kept under `prerelease`, notes capped, an off-host redirect and a
  same-host https-to-http redirect refused; scheduling after success and failure, including a
  Hobby tick 23 hours after the last; the check writes only its own row.
- mixos.org's release list: a local tag that differs from the remote fails the sync; a
  lightweight tag and a tag on a commit off `main` are left out.
- The semver classifier: major, minor, patch, equal, older.
- Notes rendering: images, raw HTML and `javascript:` links removed; a Markdown link and an
  autolink render as text; the two links built here, from the tag.
- The gate: platform behind gives 503 with `Retry-After`, HTML for pages and JSON for APIs, no
  numbers; health exempt; "can't tell" serves; app migrations behind affect only that app. End to
  end, a database one migration behind with the release step not run, in `next start`, the
  standalone image and a Vercel preview.
- Duplicate numbers refused by the runner, the generator and Danger.
- Per host, by hand: Compose shows the commit from the build argument; Render, Railway and Vercel
  from their variables, and Coolify from `SOURCE_COMMIT`; a Vercel production build runs the
  release step after `next build` and a preview doesn't; a production build that fails to compile
  leaves the database untouched.

### 2.10 Docs to update

Core:

- `docs/security-architecture.md` §18 (the maintenance response; readiness without numbers), §31
  (the URL lock's rule: built deployments), and a short section on the release check (what it
  sends: nothing but an IP and a user agent).
- `docs/hosting/README.md` (`MIXOS_COMMIT`, `MIXOS_RELEASE_CHANNEL`, the release check, the
  maintenance page) and the four host pages: the commit, the release step, applying a release,
  rolling back. `docs/hosting/vercel.md`'s Upgrades section is rewritten: it says the build
  "doesn't run migrations by itself, and shouldn't" (`:60-62@ops-8`), and after rank 14 the
  production build runs the release step after `next build`, previews don't, and migrations stay
  compatible with the deployment that serves until promotion. Its cron paragraph (`:45-49@ops-8`)
  says the update and release checks still run daily on Hobby.
- `docs/plans/20260921_0842-release-versioning.md`: marked partly superseded (stamping, GitHub
  Releases).
- `.claude/skills/mixos/actions/deploy.md` (Release, with the GitHub Release and the site sync),
  README "Releases", `OS-UPDATES.md` (a release tag is the unit of an upgrade), `WHATS-NEW.md`,
  `CHANGELOG.md` (created at the first release), the Dockerfile comments, the `.env` examples.

mixos.org:

- `operating/upgrading.mdx`: merge the release tag; the release notice; the maintenance page;
  rolling back per host; the `requiresMixOS` text at `:202-207`.
- `operating/hosting.mdx`: the release check, the maintenance page, the commit per host.
- `development/releasing.mdx`: GitHub Releases and the changelog; annotated tags on `main`; the
  release list synced from the remote; floors at publish (D36).
- `api.md`: `GET /api/v1/mixos/releases` (if D28 picks mixos.org).
- A page per release (rank 21), linked from the notice while the repository is private.
- `operating/securing.mdx` "What to watch": release notices.

---

## Priority queue

Rank is merge priority. It follows §08's order: 1 lock, 2 stamp, 3 install record, 4 schema gate,
5 requiresMixOS, 6 smoke, 7 release check, 8 uninstall, 9 enable/disable, 10 update path; then §05
and §07 option 2. §08's items keep that order. Four entries sit where §08 alone wouldn't put them,
each for a stated reason:

- **Rank 2** (keep data when an app leaves the build, from §08 #8) moves up because it has to merge
  before app-import-allowlist, which adds reasons for the generator to skip an app.
- **Rank 4** (releases) is the "tag" in §08 #2's "stamp tag and SHA". A stamped version means
  nothing until versions are released, and floors (rank 16) and the release check (ranks 21 and
  22) need a real release to name.
- **Rank 10** (same slug, different extension) is §08 #3's "not overwriting hand-authored apps".
  It needs the install record (rank 9).
- **Ranks 19 and 20** (the extension update check, from the approved update-check plan, which §08
  doesn't list) come right before the release notices, because rank 22 reuses rank 20's client,
  tick and notice component. They are also the security channel for withdrawn releases.

"Start" says whether work can begin before the stack merges. Where a higher rank is blocked, lower
ranks whose base is ready go ahead without changing rank. "State" is as of 11 October 2026.

| Rank | PR | Closes | Base | Depends on | Size | Start | State |
|---|---|---|---|---|---|---|---|
| 1 | Register lock follow-ups: "try again" on `locked`; the lease fenced and renewed (`assertHeld()` before each disk change, renewed every minute); a lock integration test; the flag and built-deployment checks before the lock; §31's step list | §08 #1 (rest); lesson 07 | `fix/app-runtime` (#10) | none | S | Now | Merged, [#15](https://github.com/mixoshq/mixos/pull/15) |
| 2 | Keep an app's data when it leaves the build: `apps.missing_since`, no cascade, job rows kept; a returning app comes back inactive unless its code is unchanged (`apps.code_hash`), audited `app.missing` and `app.returned` | §08 #8 (part); D9; D11 (returning slugs); rollback safety | `feat/contain-app-migrations` (on #8, committed) | contain-app-migrations | M | Now; merges before app-import-allowlist | Merged, [#14](https://github.com/mixoshq/mixos/pull/14) |
| 3 | Build identity: `MIXOS_VERSION` stamped on every build; the commit from the first valid source; Compose build arguments; the URL lock on built deployments; the version on admin pages | §08 #2; §06 piece 1; lesson 05 (stamp) | `feat/contain-app-migrations` | none | S | Now | Merged, [#16](https://github.com/mixoshq/mixos/pull/16) |
| 4 | Releases: the release PR, an annotated tag on `main`, a GitHub Release with the changelog section; the versioning plan amended | §08 #2 (the tag); §06 piece 2 prerequisite | `feat/any-postgres-hosting` (#4) | none | XS | Now | Merged, [#17](https://github.com/mixoshq/mixos/pull/17) |
| 5 | A check that runs nothing, part 1: `--check` with the staged folder as the extension's folder, the verdict file, `generatorEnv()`, `checkExtension()`, the static/code split of `scanApps()`, cross-extension checks against the registered manifests, the dot-folder skip; `preflight()` refuses colliding paths, control characters and git control files | §08 #3 prerequisite; safer-installs decisions 2, 6, 7; SB-8; SB-5 (the generator's environment) | `main`, after the stack | the stack, contain-app-migrations, app-import-allowlist | M | After the stack | Merged, [#31](https://github.com/mixoshq/mixos/pull/31) |
| 6 | A check that runs nothing, part 2: the static `defineRoute` reader (bare handlers, undeclared roles, `raw` without its escape; the rest deferred to Register) | owner decision 3 | rank 5 | 5 | S | After the stack | Merged, [#33](https://github.com/mixoshq/mixos/pull/33) |
| 7 | Pending installs and `npm run register`: install to `.mixos/pending/`, the sidecar with `filesHash`, the checkout lock (which the generator also takes), Register, `--discard`, `--recover` and `--break-lock` in the CLI under both locks, the re-checks at Register, the CLI's audit actor, the ignore entries | §08 #3; lessons 01, 07; SB-5; safer-installs decisions 1, 3, 5, 8; owner decisions 1 (CLI), 2, 4; D3, D4 | rank 6 | 1, 6 | M | After the stack | Merged, [#36](https://github.com/mixoshq/mixos/pull/36) |
| 8 | Register and Discard in the admin UI: the review prompt; pending lists on Apps and Connectors; honest refusal copy; Install & Activate removed; "Activate in this checkout" on a local database only | §08 #3; lesson 09; §05 option 1 (copy); owner decision 1 (button); D2 | rank 7 | 7 | S | After the stack | Merged, [#38](https://github.com/mixoshq/mixos/pull/38) |
| 9 | The install record and the hand-back: `.registry.json` (with `filesHash`), `registry-installs.ts` with `modified`, the stamp-hook skip, "Installed from", a commit message built from identifiers, the source link | §08 #3 (lockfile with origin); lessons 02, 06; §05 option 1 (diff); D5, D6 | rank 8 | 8 | S | After the stack | Merged, [#41](https://github.com/mixoshq/mixos/pull/41) |
| 10 | Same slug, different extension: identity recorded at every release step; a change keeps the extension off, revokes the app's API keys and needs a typed confirmation | §08 #3 (local work not overwritten); lesson 06; D11 | rank 9 | 2, 9; 26 for connectors | S | After the stack | Merged, [#44](https://github.com/mixoshq/mixos/pull/44) |
| 11 | Duplicate migration numbers refused by the runner, the generator and Danger | §08 #4 (part); D34 | `feat/contain-app-migrations` | none | XS | Now | Merged, [#18](https://github.com/mixoshq/mixos/pull/18) |
| 12 | Maintenance response while the platform schema is behind: the proxy gate, the operator message, readiness without numbers | §08 #4; §06 piece 5; D31, D32; SB-10 | `feat/contain-app-migrations` | none | S | Now | Merged, [#20](https://github.com/mixoshq/mixos/pull/20) |
| 13 | Per-app maintenance: rank 25's app gate answers 503 while that app's migrations are behind | §08 #4 (per app); D32 | `main`, after #8 and rank 25 merge | 12, 25 | XS | After rank 25 | Merged, [#28](https://github.com/mixoshq/mixos/pull/28) |
| 14 | Vercel's release step: `vercel-build` runs `next build`, then the release step in production only | §08 #4 and §06's health-gated rollout, on Vercel; D33; DO-4 | `feat/contain-app-migrations` | none | XS | Now | Merged, [#19](https://github.com/mixoshq/mixos/pull/19) |
| 15 | requiresMixOS at Register and at build, met or unmet in the dialogs | §08 #5; lesson 05; D15; DO-14 | rank 9 | 3, 9 | S | After the stack | Merged, [#45](https://github.com/mixoshq/mixos/pull/45) |
| 16 | mixos.org: a floor declared at publish (a CLI flag and a form field), written to `releases.requires_mixos`, checked against the core release list | §08 #5 (RG-11); D36 | mixos-org `main` | 4, 21 | S | After rank 21 | Merged, mixos.org #15 (the CLI flag shipped earlier, in mixos.org #9) |
| 17 | A smoke script that tests real routes: routes from the registry, every app, base URL, sign-in, JSON verdict | §08 #6 (part); lesson 03 | `fix/connectors` (#9) | none | S | Now | Merged, [#21](https://github.com/mixoshq/mixos/pull/21) |
| 18 | Smoke after Register (`--smoke`, local database only) and CI checks on pull requests that change extensions: the smoke run, and each vendored folder matching its `.registry.json` | §08 #6; lesson 03; D14 | `main`, after ranks 9 and 17 | 7, 9, 17 | M | After the stack | Merged, [#47](https://github.com/mixoshq/mixos/pull/47) |
| 19 | mixos.org: check-in counting through the `installs` dedupe (D1), the rollup schedule fix, api.md | update-check plan (mixos.org half); owner decision 6; RG-22 | mixos-org `main`, after its docs restructure is committed | D1 | S | Now, once D1 is decided; deployed before rank 20 | Merged, mixos.org #11 (the rollup schedule fix shipped earlier, in mixos.org #9) |
| 20 | Extension update check and notices: `requestJson()`, the tick, the notices, `MIXOS_UPDATE_CHECK`, the D1 payload, Deactivate on a withdrawn notice | update-check plan; lesson 10 (per D1); owner decisions 1 to 3; RG-4, RG-5 | rank 9 | 9, 19 deployed; 3 for the requiresMixOS line | M | After the stack | Merged, [#46](https://github.com/mixoshq/mixos/pull/46) |
| 21 | mixos.org: the core release list from the GitHub remote's annotated tags on `main`, a page per release, and under D28 B or C, `GET /api/v1/mixos/releases` | §07 option 1 (the source, per D28) | mixos-org `main` | 4 (a first release) | S | After rank 4's first release | Merged, mixos.org #14 |
| 22 | MixOS release notices: the source per D28, semver tiers, the channel (D29), notes with links as text, no apply button | §08 #7; §06 pieces 2 to 4; §07 option 1 | rank 20 | 3, 4, 20; 21 under D28 B or C | S | After the stack | Merged, [#48](https://github.com/mixoshq/mixos/pull/48) |
| 23 | Remove code: `removeExtension`, dependency refusals, the Remove button and `npm run remove`, the generator pruning `public/` copies | §08 #8 (code half); lesson 08 | rank 9 | 7, 9 | M | After the stack | Merged, [#49](https://github.com/mixoshq/mixos/pull/49) |
| 24 | Delete data on each instance: the release step's connector marks, the record of builds seen, the "removed from this build" lists, Delete data per kind | §08 #8 (data half); lesson 08; D10 | `main`, after ranks 2 and 23 | 2, 23, contain-app-migrations | M | After the stack | In progress |
| 25 | Close the activation bypasses: one app gate before the route import (gateway, `callAppRoute`, job imports), Run now, `audience: "app"` services, `hooks.ts` only for active apps, scheduled-job audits, activation docs | §08 #9 (apps); lesson 01; D7, D16 | `fix/app-isolation` (#6) | none | S | Now | Merged, [#22](https://github.com/mixoshq/mixos/pull/22) |
| 26 | Connector on/off switch, with dependents named and audited; `theme.apply` audited. The refusal to activate an app whose connector is off waits for admin-dialog | §08 #9 (connectors, themes); lesson 01; D8, D16; SB-15 | `fix/connectors` (#9) | none | M | Now | Merged, [#24](https://github.com/mixoshq/mixos/pull/24). The refusal to activate an app whose connector is off still waits for admin-dialog |
| 27 | Update, part 1: update mode, local edits from `filesHash`, the target picker with dates and an explicit downgrade, the update dialog | §08 #10; lesson 02 (headline); D12 | `main`, after ranks 20 and 23 | 9, 20, 23 | M | After the stack | In progress |
| 28 | Update, part 2: the swap at Register with backup and restore under both locks, crash recovery that checks the backup's holder, the theme swap at install | §08 #10; lesson 04 | rank 27 | 1, 7, 27 | M | After the stack | Not started |
| 29 | GitHub App, part 1: link the operator's repository (manifest flow, encrypted key, installation checks on every operation, two token shapes, unlink that uninstalls, key replacement and rotation, the branch rule read, audit) | §05 option 2; §07 option 2; D18, D19, D20 | `main`, after ranks 9 and 18 | 9, 18 | M | After the stack | In progress |
| 30 | GitHub App, part 2: propose an install as a pull request (names from identifiers, workflow and preview checks, the branch-rule precondition); App pull requests on the Apps page ("No CI ran", "changed since proposed"); previews off in `vercel.json` and `render.yaml`; Danger and CI hardened for App branches | §05 option 2; D20, D22 | rank 29 | 29 | M | After the stack | Not started |
| 31 | GitHub App, part 3: propose updates and removals | §05 option 2; lessons 04, 08 | rank 30 | 23, 28, 30 | S | After the stack | Not started |
| 32 | MixOS update pull requests, with upstream's tag verified on GitHub and the compare-link fallback | §07 option 2 (second half); D21 | rank 30, with rank 22 merged | 22, 30 | M | After the stack | Not started |
| 33 | Read-only image: root-owned files, only `.next/cache` writable; `read_only` with `tmpfs` in `deploy/docker-compose.yml` | lesson 09 (the hazard); D17 | rank 3 | 3 | S | Now, if D17 is yes | Merged, [#26](https://github.com/mixoshq/mixos/pull/26) |
| 34 | mixos.org: honest listing and hub copy; no `mixos install` command | §05 option 1 (copy); D23 | mixos-org `main`, after its docs restructure is committed | none | XS | Now | Merged, mixos.org #12 and #13 |

### Already done, and dropped from the queue

- **§08 #1, the register lock.** Done in f64bdf0 (10 Sep): a row lease, not an advisory lock, by
  design. Rank 1 is the rest; Register's use of it rides in rank 7.
- **Lesson 01 and §08 #9 for apps.** `apps.is_active` since eb944ea (23 Sep, on `main`). Rank 25
  closes the bypasses.
- **Lesson 01 for themes.** One applied theme, by design.
- **§08 #5's refusal.** `runInstall()` already refuses an incompatible release with no override;
  it starts comparing after rank 3.
- **§08 #4's comparison.** Migration 0007, the stamp and the readiness 503 exist; ops-8 adds app
  migrations. Ranks 11 to 14 add the rest.
- **§06's health-gated rollout,** on Render, Railway and Compose (#4, #8). Vercel is rank 14.
- **Lesson 09's built-deployment refusal and the docs' framing.** Rank 8 finishes the copy.
- **The permissions list** is already labelled as the publisher's claim
  (`register-dialog.tsx:302-310@runtime-10`).
- **`/p` pages and per-dispatch hook gating** are in #6.
- **The SQL statement check in the generator** (D22's "also run it in the generator"):
  contain-app-migrations calls `checkAppMigrationSql()` from `validateAppDatabase()` in `scanApps()`
  (`scripts/generate-project-registry.ts:1458-1510,1627@migrations-wip`), so a bad pull request
  fails in CI rather than at the release step.

### Coordination

As planned on 8 to 10 October 2026. #4 to #13 have since merged; admin-dialog has not.

- **Migration numbers.** #4 has `0008_connector_scope_status_user_fk.sql`; contain-app-migrations
  adds `0009_app_schemas.sql` and bumps `platform_schema_version` to 9
  (`supabase/migrations/0009_app_schemas.sql:155@migrations-wip`). admin-dialog's
  `0008_app_mcp_tool_settings.sql` does bump the row, to 8 (`:36@admin-dialog`), the value #4's
  own `0008` sets (`0008_connector_scope_status_user_fk.sql:38@core-4`). It takes the next free
  number, with the matching bump, when it rebases. Ranks 2, 10 and 24 add platform migrations and
  take the next free numbers when they rebase; rank 11 catches a collision. Ranks 25 and 26 need no
  migration (`platform_settings` keys).
- **The generator** is edited on every open branch, which is why ranks 5 to 10 wait. Rank 3 edits
  `writeBuildInfo()`, which contain-app-migrations changed to `writeBuildInfo(apps, report)` and
  moved after `scanApps()` (`scripts/generate-project-registry.ts:2165,2200-2204@migrations-wip`;
  `:2053,2083@ops-8` before), so ranks 3, 11, 12, 14 and 33 sit on that branch. Rank 17 reads the
  generated registry and doesn't touch the generator.
- **contain-app-migrations** (#12) changes `listAppMigrations()` to take only the apps the
  registry accepted (`scripts/app-migration-files.ts@migrations-wip`), which also keeps dot folders
  out of the release step, and runs `syncAppRegistry(sql, appRegistry)` in one transaction under
  the migration lock (`scripts/sync-app-registry.ts:57-91@migrations-wip`). Rank 2 builds on both.
- **app-import-allowlist** (#13, on #6) lives in `scanAppContainment()`, so rank 5's check picks
  it up with no extra call, provided `--check` passes the staged folder as the app's folder. The
  work in progress already resolves `@apps/<own-slug>` from the folder it is given
  (`src/lib/apps/import-policy.mjs:369-389@allowlist-wip`), and that has to stay so. Its merge
  waits for rank 2, which waits for #8 and contain-app-migrations. If the allowlist
  is ready first, hold its merge, or rebase rank 2 onto `fix/ops-scripts` and take the small
  conflict in `sync-app-registry.ts`. It also edits comments in `src/lib/apps/call.ts` and
  `.github/workflows/ci.yml`; ranks 25 and 30 change other lines of both.
- **The app gate.** Rank 25 (on #6) adds one activation check before the module import in
  `dispatch.ts:169`, `call.ts:97` and the scheduler's job imports (`scheduler.ts:275,295@core-4`).
  Rank 13 adds the per-app migrations check to that gate after rank 25 and #8 merge, so the gate
  isn't written twice from two bases.
- **#7 and #9** edit `/api/cron/route.ts` (webhook prunes); ranks 20 and 22 add calls after the
  prunes, a trivial merge. #7 and #9 also change `src/lib/apps/services.ts`, which rank 25 (on #6)
  edits; expect a small conflict.
- **admin-dialog** rewrites `getMissingTenantConfigConnectors()`
  (`src/lib/apps/connector-gates.ts@admin-dialog`) and edits `admin-actions.ts`. Rank 26's
  refusal to activate an app whose required connector is off goes into that function after
  admin-dialog lands. Until then the switch still stops the connector at runtime. admin-dialog
  also shows publisher-declared `lastUpdated` and authors in the app details
  footer (`src/components/admin/app-details-dialog.tsx:520-536@admin-dialog`); "From mixos.org ·
  1.2.0" belongs there once rank 9 lands.
- **mixos.org's docs restructure** (`api.md`, `scripts/sync-docs.mjs`, `operating/hosting.mdx`,
  `upgrading.mdx` and `securing.mdx`) is committed before ranks 19, 21 and 34, and before the docs
  edits in 1.16 and 2.10.

---

## Owner decisions

The owner accepted the recommendation for every decision below on 10 October 2026, with no
changes. Each decision's recommendation is therefore what the plan builds.

Each has options and a recommendation. Four recommendations change something the owner already
decided, and each lists the original choice as option A: D1 (the mechanism of update-check
decision 3), D14 (lesson 03's "fail the register"), D16 (SB-15, decided docs-only) and D28 (§06's
"read GitHub Releases"). D29 keeps the owner's "semver and channel". D36 is new.

**D1. Lesson 10 against the approved instance ID, `mixosVersion` and `POST /installs`** (changes
the mechanism of update-check decision 3).
- A. Keep the approved plan; rewrite lesson 10 as a disclosure rule (no users, URLs, hosts or
  environment; one switch; the admin page links to what is sent). `POST /installs` fires at
  Register, not at download, with the checkout's database ID.
- B. Anonymous by default (items only); the ID, `mixosVersion` and `/installs` behind an opt-in.
  Needs mixos.org to accept `/updates` without an ID. Reverses decision 2 in effect and makes 3
  opt-in.
- C. Strict lesson 10: items only, no `/installs`. Publishers get no counts from MixOS.
- D. Count from check-ins: the ID and items on `/updates`; no `mixosVersion`; no `/installs`.
  `check_updates` writes an `installs` row for each item at a real release, through the existing
  dedupe on (instance, listing, release), and counts only the rows it inserts.
- **Recommendation: D.** Under the approved flow, `/installs` would fire from a developer checkout
  at download, with that checkout's database ID, so it counts downloads, including installs that
  are discarded or never deployed. Check-ins come from every instance that runs the extension, so
  they are the real counts decision 3 asked for. Counting through the `installs` dedupe keeps
  `install_count`'s meaning: an upgrade counts and a repeat doesn't
  (`0002_repository_api.sql:154-156@mixos-org`). The answer doesn't need `mixosVersion` (the client
  compares floors itself), and once every build is stamped every instance would report it daily.
  Decisions 1 and 2 stand. The trade: mixos.org loses `installs.mixos_version`, the column its
  schema says answers "can we drop support for 0.3 yet" (`0002_repository_api.sql:145-147@mixos-org`);
  an opt-in can bring it back later.

**D2. Verbs, and "Install & Activate".**
- (a) Install (catalogue to pending, in a checkout), Register (pending to the build), Activate (per
  database), Enable (per user), Deploy; "Propose to <repo>" when the App is linked. Browse drops
  Install & Activate; the Register result offers "Activate in this checkout" when the checkout's
  database is local.
- (b) Rename Install to "Add to repository".
- (c) Keep Install & Activate, running Register in the same click.
- **Recommendation: (a).** It keeps the activation plan's words, adds the approved Register stage,
  and (c) would undo the review the owner chose. "Activate in this checkout" is offered only on a
  local database (loopback, `host.docker.internal`, or the dev stack's own), and the result names
  the database host either way: a checkout on a shared development database would otherwise
  activate the app for every instance on it.

**D3. Discard for pending installs.** Add a Discard button and `npm run register -- <kind>/<slug>
--discard`, or leave deletion to the shell. **Recommendation: add it,** under both locks and
audited. The approved plan lists pending installs but has no way to drop one.

**D4. How checkout operations are serialised.** (a) The database row lock in the button and the
CLI. (b) A checkout file lock, `.mixos/lock`, that every checkout operation and the generator take.
**Recommendation: both.** The row lock is a lease anyone can take after 15 minutes, and a CLI
holder can be suspended, so it is fenced (re-checked before each disk change) and renewed every
minute. Two processes can also resolve different databases for "the same" row lock
(`scripts/load-env.ts:45,56-60@ops-8`): a CLI on the host and a dev server in a container. The file
lock covers that, and `predev` and `npm run registry`, which take no lock today.

**D5. `.registry.json` fields, one record, and the stamp hook.** Approved fields only, or add
`gitTag` (nullable), `repository`, `requiresMixOS` and `filesHash`; `installedAt` or not; one record
or two; stamp hook skip now or later. **Recommendation:** add `gitTag`, `repository`,
`requiresMixOS` and `filesHash` (the content hash with file modes ignored, so a folder can be
checked offline against what was verified); no `installedAt` or admin identity in a committed
file; one record, inside the pending tree, with the sidecar holding only pending-only facts; the
stamp hook skips vendored folders in the same PR, so every committed install keeps matching its
hash.

**D6. Installs from a catalogue other than the one running.** Never checked with a muted line and a
generator warning; a CI failure for a non-mixos.org `source`; or checked against the recorded
source, as the page proposed for mirrors. **Recommendation: never checked, a muted line, a
warning.** The override is a development affordance, and a built deployment always asks mixos.org.

**D7. What deactivating an app stops.** Close Run now and `audience: "app"` services; also check
activation before importing a route or job module; also load `hooks.ts` only for active apps.
**Recommendation: all three,** through one app gate that rank 13 later extends. Deactivate is the
incident response, and an inactive app's top-level code shouldn't run. #6's per-dispatch gate
stays as the second line.

**D8. The connector switch and credentials.** A disable switch that keeps credentials; an audited
"clear credentials" action; or both. **Recommendation: the switch now; clearing only through
Delete data after removal.** An admin who suspects a leak revokes at the provider and enters new
credentials, which replaces them.

**D9. When an app leaves the build.** Keep the release step's automatic delete of grants, installs,
password and widgets, or mark the app missing and keep everything until an admin chooses.
**Recommendation: mark, and bring a returning app back inactive unless its code is unchanged.**
Today a generator skip looks the same as a removal, and the import allowlist adds skip reasons.
Today's delete is also what makes a returning slug arrive inactive with no grants; keeping the row
has to keep that property.

**D10. The removal model.** Confirm two phases (remove code in a checkout; delete data on each
instance after that deploy), no uninstall hook, what Delete data removes, and how it knows a slug
is gone. **Recommendation: two phases, no hook, delete everything keyed to the slug except
`admin_audit_log`, and decide "gone" from the database:** a mark set by a release step, for apps
and connectors, and no other build seen on this database in the last 24 hours carrying the slug.
One database is often served by more than one build: Vercel's Instant Rollback runs no release
step, and a checkout can share a development database (`README.md:261-265@core-4`).

**D11. Kept data and a new extension with the same slug.** Allow it, refuse it, or record and
flag. **Recommendation: record and flag, in two checks.** A returning app whose code differs from
what was recorded comes back inactive (rank 2). An extension whose identity changes (its source,
kind, slug and repository, or "local") stays off, has its API keys revoked and needs a typed
confirmation (rank 10), checked at every release step and not only on return. A version or
commit change within one identity is an update and isn't flagged, so updates don't train admins
to click through.

**D12. Update rules.** Backup at `.mixos/backup/<kind>/<slug>/` or beside the live folder; refuse or
allow an update over local edits; any non-yanked release or only the latest; how a downgrade is
shown; migrations forward-only. **Recommendation:** `.mixos/backup/`; allow after an explicit
"discard my changes", with local edits found from `filesHash`; any release the admin picks, with
the direction from the versions when both are dotted and from the published dates otherwise; a
downgrade needs an explicit "Install an older release", audited with `direction: "older"`, and the
dialog names the migrations the target lacks; confirm forward-only migrations and a backup step.
Website releases use the short commit SHA as their version, and a publisher's yank can make
mixos.org's current release an older one.

**D13. A Deactivate button on a withdrawn-release notice.** **Recommendation: yes,** for apps. It is
an admin's act, so "show, never act" holds.

**D14. The smoke test** (changes lesson 03's "fail the register").
- A. Lesson 03 as written, which the owner adopted with "do all ten lessons": `npm run register --
  <slug> --smoke` on a local database fails the Register on a bad class and moves the folder back
  to pending; the migrations it applied stay.
- B. Report in dev after Register, migrations and activation, on a local database only; gate in CI
  on pull requests that change extensions.
- C. A post-deploy check.
- Also: how the caller gets in (forward the admin's session, a smoke credential, or test after
  activation), and whether an empty 2xx passes.
- **Recommendation: B,** testing after activation with no bypass; an empty 2xx passes with a note.
  After Register an app is inactive and ungranted, a `database: true` app has no tables until its
  migrations run, and moving the folder back can't undo migrations or what the code did. CI is
  where a bad result should block, before the code reaches any deploy.

**D15. requiresMixOS policy.** Enforce in checkouts against `package.json`'s version or not; check
at install, Register and build, or fewer; an unmet floor at build fails the build or skips the
extension; RG-11 now or later. **Recommendation:** enforce in checkouts; check at all three; fail
the build; RG-11 after the first release (rank 16), declared as D36 recommends. A core developer on
unreleased `main` who needs a newer floor bumps `package.json` locally.

**D16. Audit theme apply and the scheduled-job actions** (changes SB-15).
- A. SB-15 as decided: document them, don't audit.
- B. Audit them.
- **Recommendation: B.** They are instance switches like Activate.

**D17. Lesson 09's hazard, the writable image.** Root-owned files with only `.next/cache` writable,
and `read_only: true` with `tmpfs` in `deploy/docker-compose.yml`; or leave it. **Recommendation:
do it (rank 33).** The server can rewrite its own code today (`Dockerfile:163-178@core-4`); only the
install path refuses.

**D18. Whose GitHub App, and which instance links it.** One private App per operator through the
manifest flow, or a shared MixOS App; link from the deployed instance or from every instance.
**Recommendation: one private App per operator, linked from the deployed instance.** Checkouts keep
the vendoring flow.

**D19. Where the App's private key lives, and how it is replaced.** Encrypted in the database under
a new independent key, or only in host variables. **Recommendation: the database, under
`GITHUB_APP_ENCRYPTION_KEY`, with the feature off while that key is unset.** One App at a time:
unlink uninstalls it from the repository through GitHub's API before the instance forgets it, and a
new manifest flow is refused while one is recorded. "Replace private key" checks a key pasted from
GitHub against the App id, and rotating `GITHUB_APP_ENCRYPTION_KEY` re-encrypts the stored key with
one command. A compromised server reads the key either way. GitHub has no API to create or revoke an App's private key, so
that happens in GitHub's settings, which the instance links to.

**D20. App permissions, `workflows`, and the branch rule.** **Recommendation:** `contents: write`,
`pull_requests: write`, `metadata: read`, `checks: read` and `statuses: read`; tokens narrowed per
operation to a write shape (contents and pull requests) or a read shape; no `workflows` (update pull
requests that touch workflows fall back to a compare link); Propose needs a rule requiring pull
requests on the default branch. The App reads ruleset rules with Metadata read alone
(`GET /repos/{owner}/{repo}/rules/branches/{branch}`). Classic branch protection isn't visible
there, and private repositories under GitHub Free can't have rulesets, so an admin can override
with an audited confirmation.

**D21. Which repositories.** Public forks only, or private copies too. **Recommendation: both for
extension pull requests; MixOS update pull requests for forks only,** with a link and commands for
private copies, and only after GitHub confirms that upstream's tag points at the feed's commit.
Forks of a public repository can't be private, and internal-tools operators will often want
privacy.

**D22. Checks, previews, names and identity for App pull requests.** **Recommendation:** the
repository's CI is the check (don't bundle the static check into the image); branch names, titles
and commit messages built only from validated identifiers, with the publisher's text only in the
body, fenced and escaped; before each proposal, refuse when a workflow would run the proposed code
with secrets or a write token, or `render.yaml` turns previews on; `vercel.json` turns off previews
for `mixos/**`, `render.yaml` sets previews off, titles carry `[skip preview]`, and the admin
confirms a checklist for what the App can't read; commits by the App's bot, with the audit log
recording the admin. The SQL statement check already runs in the generator (contain-app-migrations).

**D23. mixos.org's listing command.** Show a new terminal installer, a `mixos install` in the
publisher CLI, or no command. **Recommendation: no command;** point to Browse in a checkout (or
Propose with the App). A terminal installer is out of scope here.

**D24. The version source.** `package.json` stamped into `build-info.ts` on every build;
`MIXOS_RELEASE` only; or both. **Recommendation: `package.json` only,** dropping `MIXOS_RELEASE` as a
source. It reaches every host and checkout; two sources drift.

**D25. What counts as a release build for the repository-URL lock.** An explicit environment
marker; any built deployment, with a loopback catalogue allowed; or Vercel production only.
**Recommendation: any built deployment, loopback allowed.**

**D26. The commit source.** Host variables at runtime plus a Compose build argument, or a commit
written into `build-info.ts` during `prebuild`. **Recommendation: runtime host variables plus the
Compose argument, taking the first value that is a valid commit SHA;** `predev` output stays
stable. The image sets `MIXOS_COMMIT` to an empty string when no argument is passed
(`Dockerfile:141-142@core-4`), which is how Render and Railway build it.

**D27. Releases and the upgrade unit.** **Recommendation:** a release PR, an annotated tag on `main`
pushed by a human, and a GitHub Release with the `CHANGELOG.md` section as notes; the docs say to
merge the release tag rather than `upstream/main`.

**D28. Where the release feed comes from, and will `mixoshq/mixos` be public when the release
notices ship?** (changes §06's "read GitHub Releases" under B or C)
- A. GitHub Releases directly, as the owner decided. Works only once the repository is public: an
  anonymous `GET /repos/mixoshq/mixos/releases` returns 404 today. Shared host egress can hit
  GitHub's limit of 60 requests an hour per IP.
- B. A mixos.org list generated from the core's tags (rank 21), served as
  `GET /api/v1/mixos/releases`.
- C. mixos.org now, GitHub once the repository is public.
- **Recommendation: B, unless the repository will be public by the time rank 22 ships; then A, as
  decided.** While it is private, B is the only way the notices can work. B also keeps one
  outbound host, with the lock and https rule already in place, and records nothing. Under A, rank
  21 still builds the release list (floors need it) but serves no feed.

**D29. Channel, and one switch or two.**
- A. A channel, as decided: `MIXOS_RELEASE_CHANNEL`, `stable` by default, `prerelease` to include
  pre-releases.
- B. Stable releases only until 1.0, with no setting.
- **Recommendation: A,** as decided; it is a few lines. `MIXOS_UPDATE_CHECK=false` stops both
  checks, so "off" means nothing is sent.

**D30. Release notes.** Allow images and links, or drop them. **Recommendation: drop images and raw
HTML, render links as plain text, cap at 20 KB and collapse.** The only clickable links are built
locally: the release page from the validated tag, and `/docs/operating/upgrading`. The notes come
from Conventional Commit subjects, so a merged pull request's title is enough to put a link in front
of every admin.

**D31. Where the version shows.** Admin pages only, or also public endpoints; and the readiness
JSON's schema numbers (SB-10). **Recommendation: admin pages only, and remove the numbers from the
public readiness response.**

**D32. The maintenance response's scope.** The whole instance for both checks; admin pages only
(what WordPress's `admin.php` does); or the whole instance for the platform schema and the affected
app for app migrations. **Recommendation: the last.** One app's pending migration shouldn't take the
instance down.

**D33. Vercel's release step.** Keep it manual and rely on the maintenance response; run it in
production builds only (`VERCEL_ENV=production`, needs `DATABASE_URL` at build); or a CI job with
Vercel deployment checks (needs a production database secret in GitHub). **Recommendation:
production builds, after `next build` succeeds** (a `vercel-build` script, rank 14), with the
maintenance response as the backstop. A compile failure then leaves the database untouched, a
failed migration fails the build and the old deployment keeps serving, and the release step's lock
serialises concurrent builds. Migrations have to stay compatible with the deployment that serves
until promotion: add in one release, remove in a later one.

**D34. Duplicate migration numbers.** **Recommendation:** refuse them in the runner, the generator
and Danger; admin-dialog's `0008` takes the next free number, with the matching bump, when it
rebases.

**D35. Now, or after the current list.** **Recommendation:** start ranks 1, 2, 3, 4, 11, 12, 14, 17,
25 and 26 now on the branches named, and 33 if D17 is yes; ranks 19 and 34 once mixos.org's docs
restructure is committed (19 also needs D1); rank 21 after the first release, then rank 16; rank 13
after rank 25 and #8 merge; build ranks 5 to 10, 15, 18, 20, 22 to 24 and 27 to 32 after the stack
merges, in rank order. Hold app-import-allowlist's merge until rank 2 has merged, and agree rank 5's
staged-folder rule with its author now.

**D36. Where a publisher declares `requiresMixOS`.** (a) A flag on `mixos publish` and a field on
the website's publish form, written to `releases.requires_mixos`. (b) An optional `requiresMixOS` in
all three manifest schemas, read at publish, shipped first in a tagged core release.
**Recommendation: (a).** The raw manifest schemas are strict
(`scripts/manifest-schemas.ts:680,1163,1349@runtime-10`): until every instance runs a core release
that accepts the key, a manifest carrying it fails `preflight()` and aborts the build of anyone who
vendored it. mixos.org refuses a floor that isn't `X.Y.Z` or is newer than the newest core release
on its list (rank 21).

---

## Review notes

A security review and a consistency review raised 31 findings on 9 October 2026. Each was checked
against the code, and all were accepted and fixed above. Parts of eight proposed fixes were
changed, for these reasons:

- **Returning and swapped slugs.** The proposals disagreed on the fingerprint: a code tree hash,
  the commit SHA, or a hash of `app.json`. A commit SHA flags every update, and a manifest hash
  can be copied. Rank 2 records a hash of the app's files, computed by the release step from disk,
  so it needs no generator change and can start now. The identity check (rank 10) uses source,
  kind, slug and repository, without the commit. It needs the install record, so it can't move
  into rank 2.
- **Workflows that run App pull requests.** A `branches-ignore` on a `pull_request` trigger
  filters the target branch, not the source, so it can't exclude `mixos/**`; the exclusion is a
  job condition on `github.head_ref`. A blanket refusal of write permissions would also refuse the
  core's own `danger.yml` (`.github/workflows/danger.yml:14-23@core-4`), which asks for write
  scopes but runs no extension code; rank 30 adds the condition to it.
- **Check timing.** Vercel Hobby fires a daily cron anywhere within its hour, so two ticks can be
  about 23 hours apart and "23 hours plus jitter" would still skip days. Both checks are due 21
  hours after the last success, plus up to an hour.
- **Rank 5's check outside `apps/`.** The in-progress allowlist resolves `@apps/<own-slug>` from
  the folder it is given (`src/lib/apps/import-policy.mjs:369-389@allowlist-wip`), not through
  `tsconfig.json`'s `@apps/*` path, so that half needs only the staged folder passed in. The
  cross-extension checks and the migration-file lookup do assume `apps/`, and are fixed.
- **The checkout lock.** A pid can't show whether a holder in another container is alive, so a
  lock from another hostname is never broken automatically.
- **Floors at publish.** The plan didn't say "a manifest field read at publish". The gap was real:
  the plan didn't say where publishers declare a floor. D36 decides it.
- **Branch rules.** Private repositories under GitHub Free can't have rulesets, so the audited
  override also covers operators who can't add one.
- **Delete data and recent builds.** Counting the caller's own build would refuse a checkout's
  Delete data right after Remove, so the check skips the caller's own record.
