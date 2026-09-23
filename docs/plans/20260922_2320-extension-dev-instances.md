# Extension development in a real instance

## Context

Apps, connectors and themes live in this repository next to the OS that runs
them. That is right for the ones the platform ships — `wall-e`, `themes/mixos`,
`themes/mixos-dark`, the three `_template` scaffolds — and wrong for everything
an outside developer builds. A person writing their own apps needs somewhere to
write them that is not the platform's git history, and a way to decide, per
extension, whether it appears in the mixos.org catalogue.

Most of that already exists. A mixos.org listing is **repo-driven**: the
publisher picks a repository, a path inside it and a slug, and every listing
field is read out of `app.json` at a commit
(`mixos-org/supabase/migrations/0006_repo_driven_apps.sql`). The installer
fetches a GitHub tarball pinned to that commit, verifies a content hash, and
extracts the subpath into `apps/`, `connectors/` or `themes/`
(`src/lib/repository/install.ts`). "Your extensions live in your own repository"
is the model this platform was *built* for. What is missing is a place to
**develop** them, and the ability to run more than one instance on one machine.

### What was tried first, and why it cannot work

The obvious idea — keep extensions in a sibling repository and symlink each one
into a platform checkout — is a dead end. Recorded here so it is not
rediscovered:

| Step | Result |
|---|---|
| Symlink `apps/career` → sibling repo, run the generator | Silently skipped. `Dirent.isDirectory()` is `false` for a symlink, and `scripts/generate-project-registry.ts` filters on it in ten places |
| Patch the generator to follow symlinks | Fails: route modules are imported by their **real** path, so `zod` resolves against the sibling repo's absent `node_modules` |
| Add a `node_modules` symlink in the sibling repo | Generator passes; `tsc --noEmit` clean |
| `npm run build` | `Module not found: Can't resolve '@apps/career/pages/Main.tsx'` |
| Same, sibling under a shared root + `turbopack.root` | Turbopack panic: `reading file ".../apps/career" → Is a directory` |

The blocker is the bundler, not the generator. **An extension has to be a real
directory inside a real instance.** Everything below follows from that.

### The shape

Three trees on the machine:

| Tree | What it is | What it holds |
|---|---|---|
| `~/git/mixos` | the platform repository | the OS, `wall-e`, both themes, the `_template` scaffolds |
| `~/mixos-dev` | an **installed instance**, not a repository | the developer's extensions, each one its own git repository at `apps/<slug>` / `connectors/<slug>` / `themes/<slug>` |
| `~/mixos-test` | an **installed instance**, not a repository | nothing of the developer's — the tree where installs from mixos.org are exercised for real |

## Decisions

1. **`mixos-dev` is an instance, not a fork.** It is a copy of the platform tree
   with no `.git` at its root and without `.github/` or `.githooks/`, which are
   apparatus of the repository rather than of an install. It is updated by hand
   from the platform repo; it never sends commits back. `.claude/` stays, so
   `/mixos` works where the extensions are written.

2. **Each extension is its own git repository, nested in place.** `apps/career`
   in `mixos-dev` *is* a clone of `italianst4/career`. The extension directory
   is a real directory to the generator and to Turbopack, and a repository root
   to git. Nothing is copied, synced or symlinked.

3. **A listing's `subpath` is therefore null** — the repository root is the
   extension. Downloads are the extension's own files and nothing else, and a
   release's content hash cannot be invalidated by an unrelated sibling.

4. **Published extension repositories must be public.** `fetch-source.ts`
   authenticates nothing; a private repository 404s at install. An extension
   that should not be public simply has no listing — being absent from the
   catalogue is the whole of "unpublished".

5. **The platform repo keeps `wall-e` and both themes; `career` and
   `connectors/gmail` leave with their history**, via `git subtree split`
   (`git-filter-repo` is not installed; subtree is built in and sufficient for
   a clean directory-to-root extraction). `inbox-actions` is **not** extracted —
   it is being dropped outright, and its removal is already done on disk.

6. **Install verification happens in a third instance.** A slug cannot be both
   source and install target: registration refuses when the directory already
   exists — *"already exists on this instance. Remove it first, or update it in
   its own source repo"* (`src/lib/repository/install.ts:691`). `mixos-test`
   exists so the download → hash → extract → regenerate path is exercised
   against an instance that has never seen the code.

7. **Instance identity becomes environment-driven — an OS change.** Today the
   compose project name is frozen (`scripts/docker-up.ts`: `const
   COMPOSE_PROJECT = "mixos"`, *"Frozen: docker-down.ts and the docs assume it
   too"*), `docker-compose.yml` declares `name: mixos` and publishes
   `127.0.0.1:3000:3000`, and `supabase/config.toml` pins `project_id = "mixos"`
   with ports 54321–54329. Two checkouts are therefore not two instances — they
   are the same compose project fighting over the same named volumes and the
   same Supabase containers. Parameterising this is the change that unblocks
   everything else, and by `OS-UPDATES.md` it is an OS change: branch, PR,
   `os-change` label.

8. **Defaults do not move.** Every value introduced in decision 7 defaults to
   what it is today, so an existing checkout and the documented commands behave
   exactly as before.

9. **The catalogue adopts `mixos-tree-v1`.** mixos.org and this repo implement
   two mutually incompatible serialisations today, and no install of a published
   extension can succeed until one moves. mixos.org moves: it hashes file bytes
   per the contract already written down in `src/lib/repository/content-hash.ts`,
   keeping SHA-256 as the only thing the trust boundary rests on. Nothing in
   this repository changes. Both schemes and the reasoning are kept in §D.

## File-level changes

### A. Multi-instance identity — OS change, this repository

- `scripts/docker-up.ts` — `COMPOSE_PROJECT` becomes
  `process.env.MIXOS_INSTANCE ?? "mixos"`. The script already derives the real
  Supabase ports from `supabase status -o json` rather than from constants, so
  `.env.docker.local` generation adapts with no further change. It must also
  **export the instance variables into the environment it spawns `supabase`
  with**, since that is what makes the next item resolve.
- `scripts/docker-down.ts` — same value, read the same way.
- `docker-compose.yml` — `name: ${MIXOS_INSTANCE:-mixos}`; both published ports
  become `127.0.0.1:${MIXOS_PORT:-3000}:3000` (the dev service and the
  prod-parity service, which must stay identical to each other).
- `supabase/config.toml` — `project_id = "env(MIXOS_INSTANCE)"` and the port
  fields likewise. **Verified against the pinned CLI (2.115.0):**
  `project_id = "env(MIXOS_INSTANCE_ID)"` with the variable set resolves — the
  CLI looked for container `supabase_db_mixos-dev`. A `port` field given the
  same `env(...)` form also parses past config loading; the effective value
  still wants confirming at a real `supabase start`.
- **Resolved at implementation:** with `env(...)` in `config.toml`, a bare
  `supabase …` gets an empty `project_id`. `scripts/supabase.ts` is the wrapper
  — it resolves the instance, pins the repo-local CLI, and is what `db:push`,
  `db:reset` and `db:local` now run. `npm run supabase -- <command>` is the
  documented way to reach the CLI by hand.
- Per-instance values live in a gitignored file at the instance root
  (`.env.instance`, already covered by the `.env*` ignore rule):
  `MIXOS_INSTANCE`, `MIXOS_PORT`, and a Supabase port base. `scripts/load-env.ts`
  loads it; absence means today's defaults.
- Docs: `docs/local-docker.md` and the README quick start gain the
  second-instance path.

### B. Extensions leave the platform repository

- Extract with history, one repository each:
  `git subtree split -P apps/career -b split/career` → push to
  `italianst4/career`; the same for `connectors/gmail`.
- `git rm -r apps/career connectors/gmail`, on a branch, as a PR. The same
  branch commits the already-performed deletion of `apps/inbox-actions`, which
  is retired rather than extracted — nothing is pushed anywhere for it, and its
  history stays where it is, in this repository's past.
- **Expected, destructive, and local only:** on the next boot
  `scripts/sync-app-registry.ts` deletes every `public.apps` row whose slug is
  no longer in the registry, and the foreign keys cascade to `user_app_grants`,
  `user_apps`, `app_passwords` and `dashboard_widgets`. In this checkout's dev
  database that is career and inbox-actions data. Dump first if any of it
  matters.
- `connectors/gmail` loses its only consumer when `inbox-actions` goes, so it
  moves on its own account rather than as a dependency. Nothing in the platform
  references it outside `src/generated/`.
- No code depends on the departing slugs. The only references outside
  `src/generated/` are prose: `src/lib/apps/admin-actions.ts:58-61` and
  `src/components/admin/app-details-dialog.tsx:158` use `career` to illustrate
  table prefixing, and `docs/apps/app-shell.md:120` cites its library UI. They
  become references to an app that is no longer in the tree — reword or point
  them at `wall-e`.
- `.claude/skills/mixos` scaffolds new extensions into `apps/<slug>`. In an
  instance, a newly scaffolded extension needs `git init` and its own remote to
  become publishable; the relevant actions should say so.

### C. Instance setup — no code in this repository

- Create: clone the platform, then strip the repository apparatus —
  `.git`, `.github`, `.githooks` — leaving `.claude` in place. `npm ci`, write
  `.env.instance`, `npm run dev:docker`.
- Populate `mixos-dev`: clone each extension repository into its slug directory
  (`git clone git@github.com:italianst4/career.git apps/career`). The generator
  picks them up on the next `predev`.
- Update by hand: re-clone the platform tree, then carry across the instance's
  own state — `apps/*`, `connectors/*`, `themes/*` and the gitignored env
  files. Worth a small script once the procedure has been done once by hand;
  it does not belong in the platform repo until it has earned its place.
- `mixos-test` is the same procedure with no extensions cloned into it.

### D. Content hash — the blocker, and the two candidates

The installer verifies a downloaded tree against the hash the catalogue
published, before anything is written (`install.ts`, step 5 of its order of
operations). The two ends implement different serialisations, so **every honest
publish currently fails verification, indistinguishably from an attack.**

**Scheme 1 — `mixos-tree-v1`, what the installer implements**
(`src/lib/repository/content-hash.ts`):

```
sha256( "mixos-tree-v1\n"
        then per regular file, sorted by UTF-8 bytes of path:
          <mode> " " <path> "\0" <byte length> "\0" <file bytes> )
→ "sha256-" + base64
```

Hashes file **contents**. SHA-256 end to end. Carries the executable bit; length
prefixes make the encoding unambiguous; a domain prefix versions it. Costs the
publisher one tarball download per release — with per-extension repositories
(decision 3) that is a few hundred kilobytes, well inside a Cloudflare Worker's
budget. Costs the installer nothing new: it is already written and already runs.

**Scheme 2 — blob-SHA form, what the catalogue implements**
(`mixos-org/src/lib/registry/extension-source.ts`):

```
sha256( join("\n", sorted( "<path>\0<git blob sha>" )) )
→ "sha256-" + base64
```

Hashes git blob **identities**. Free at publish — the blob SHAs arrive with the
recursive tree listing the catalogue already fetches for its file counts. Costs
the installer a per-file `sha1("blob " + len + "\0" + bytes)` recompute, which is
cheap. Two properties argue against it: a git blob SHA is **SHA-1**, so file
identity inside the trust boundary rests on SHA-1 collision resistance —
chosen-prefix collisions are demonstrated and priced, and a plain recompute in
the installer would have none of git's `sha1dc` hardening — and the blob SHA
does not cover file **mode**, so the executable bit is outside the hash.

**Decided: the catalogue adopts `mixos-tree-v1`.** It keeps SHA-256 as
the only thing the trust boundary depends on, it is the scheme whose definition
is already written down as the contract, and its one real cost — a download at
publish time — shrank to near nothing the moment extensions became their own
repositories.

**What adopting it costs mixos.org, concretely.** Not storage and not
bandwidth: the catalogue never holds the code. It fetches
`https://codeload.github.com/<owner>/<repo>/tar.gz/<sha>` once at publish,
hashes it, discards the bytes, and stores the resulting string on the release
row. The installing instance fetches that same URL for itself, and
`assertAllowedTarballUrl` would in any case reject a download URL on any host
but GitHub's. The cost is code: today the catalogue reads only GitHub's tree
API, so it needs a tar reader it does not have. `wrangler.jsonc` already
enables `nodejs_compat`, which should make porting `src/lib/repository/tar.ts`
and `content-hash.ts` close to a copy.

**The normalisation must match, not just the algorithm.** The installer strips
the archive's top-level `<repo>-<sha>/` directory, applies `subpath`, rejects
symlinks, and enforces 5,000 files / 64 MB total / 16 MB per file. A catalogue
that hashes before applying the same steps and the same refusals publishes
releases that can never install — the exact failure this reconciliation exists
to remove. Note also that the hash covers every file in the repository, so a
`.gitignore`, a `README.md` or a `.github/` directory in an extension repo is
part of the installed tree and part of the hash.

**Rollout is one-sided, which is why this is cheap.** MixOS instances already
compute `mixos-tree-v1` and already refuse a placeholder
(`isVerifiableHash`), so no instance needs updating, no version floor is
involved, and an instance in the field starts succeeding the moment the
catalogue publishes a hash it can verify. The work is entirely in mixos-org,
and lands there under its own branch-and-PR flow.

**Still version the field.** Add an explicit algorithm identifier to the install
manifest and to the catalogue's release rows, so a future change is a new value
rather than a silent reinterpretation of an old one. That is the one piece
touching both repositories — `InstallManifestSchema` in
`src/lib/repository/types.ts` gains an optional algorithm field, absent meaning
`mixos-tree-v1`, so old and new catalogue responses both parse.

**Backfill.** Seeded rows carry `sha256-PLACEHOLDER-<slug>` and are already
refused, so they need nothing. Any release row written by the real publish path
(`publishRelease` in `mixos-org/src/lib/registry/publishing-store.ts`) carries a
scheme-2 hash and must be recomputed or re-published — check the production
`releases` table for rows whose `content_hash` is not a placeholder before
shipping.

## Verification

- **A** — `MIXOS_INSTANCE=mixos-dev MIXOS_PORT=3001 npm run dev:docker` in one
  tree and plain `npm run dev:docker` in another, both healthy at once, two
  compose projects, two Supabase stacks, two databases, neither recreating the
  other's containers. Then `npm run docker:down` in each, and confirm it takes
  down only its own.
- **B** — in this repo after the removals: `npm run registry` lists two apps and
  no connectors; `npm run typecheck`; `npm run lint`; the dev server boots and
  the Apps page is coherent. In `mixos-dev` with the extension repositories
  cloned in: the same three commands, plus each app's pages rendering and
  `connectors/gmail` appearing in the connector registry.
- **C** — in `mixos-dev`, `git status` inside `apps/career` shows that
  repository and nothing of the platform's; the instance root is not a
  repository at all.
- **D** — the end-to-end proof, once the hash is reconciled: publish one
  extension from its own repository through mixos.org, register it in
  `mixos-test`, and watch it download, verify, extract and appear in the
  registry. Then move the listing's tag and confirm the pinned commit makes that
  a no-op.

## Open questions

1. Whether the hand-update procedure for an instance eventually becomes a
   script in this repository, and if so whether it is an OS concern at all.
