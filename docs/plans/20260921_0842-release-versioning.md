# Release versioning

**Status:** amended on 10 October 2026. The release process is built:
`/mixos deploy release` and `scripts/release-prep.ts`. Decision 4 is
superseded, and with it the `next.config.ts` change: every build, on every
host, stamps `package.json`'s version into `src/generated/build-info.ts`, and
`MIXOS_RELEASE` is no longer read. The repository-URL lock covers every built
deployment. The commit comes from `MIXOS_COMMIT` or the host's own variable:
see `src/lib/platform/version.ts` and
[`docs/hosting/README.md`](../hosting/README.md#which-build-is-running).
Written on 21 September 2026 as "Release versioning on Vercel".
**Scope:** platform — `scripts/release-prep.ts`, `.claude/skills/mixos/`,
`package.json`, `CHANGELOG.md` (created by the first release), README,
`docs/hosting/`

## Context

When this plan was written, the platform already depended on knowing its own
version, and nothing set it.

- [`src/lib/platform/version.ts`](../../src/lib/platform/version.ts) read
  `MIXOS_RELEASE` to answer `requiresMixOS` floors when an extension was
  installed from the catalogue. Unset, the version was `null` and every floor
  resolved to *unknown → allowed*. That is the right behaviour for a developer
  checkout; in production it made the compatibility gate a no-op.
- [`src/lib/repository/client.ts`](../../src/lib/repository/client.ts)
  `isReleaseBuild()` keyed off the same variable. It was the runtime layer of
  the repository-URL lock (`docs/security-architecture.md` §31): a release
  build ignored any `MIXOS_REPOSITORY_URL` override. Unset, that layer was
  inert in production.
- The admin UI and bug reports had no version to name.

Both were designed around a tag-triggered image build that passed
`--build-arg MIXOS_RELEASE=${{ github.ref_name }}` into the runner stage. That
pipeline was removed when the repository moved to Vercel: Preview per PR,
Production on merge to `main`, [`ci.yml`](../../.github/workflows/ci.yml) as
the only gate. No tag had ever been pushed, and `/mixos deploy` no longer had a
release phase.

The amendment keeps the release PR and the bump rule, and changes three
things. Every build carries its version, not only Vercel production. A release
is published as a GitHub Release as well as a tag, and operators upgrade by
merging the release tag rather than `upstream/main`. Prereleases carry a
suffix, so anything that lists new releases can leave them out by default.

## Decisions

1. **Tags name what is running.** A release is an annotated tag `vX.Y.Z` on
   `main`. It is the unit the catalogue, `requiresMixOS`, and rollback
   conversations refer to. Vercel's instant rollback restores a build; it does
   not tell anyone which version that was. Annotated, because a lightweight
   tag has no date, author or message of its own.
2. **The version lives in `package.json`**, not in a CI variable. Between
   releases it holds the last release's version, and only a release PR
   changes it. The first release is the `0.1.0` it already holds.
3. **Release-PR pattern.** A release is a pull request that sets the version
   in `package.json` and `package-lock.json` and adds the version's section to
   `CHANGELOG.md`, both derived from the Conventional Commits since the last
   release by `scripts/release-prep.ts`. Its one commit is
   `chore(os): release vX.Y.Z`, which later releases don't count. "Never
   commit to `main`" holds.
4. **Superseded.** This decision set `MIXOS_RELEASE` only in Vercel
   production, from `next.config.ts`. Instead, every build now stamps
   `package.json`'s version into `src/generated/build-info.ts`, which
   `src/lib/platform/version.ts` reads, on every host and in every checkout,
   and `MIXOS_RELEASE` is no longer read. One source can't drift from another,
   and `package.json` is in every build context.
5. **Bump rule, 0.x scheme.** Since the last stable release: any breaking
   commit (`!` or a `BREAKING CHANGE:` footer), any `os`-scoped commit, or any
   commit that changes a file outside `apps/`, `connectors/` and `themes/`
   (build plans aside, as Danger counts them) → minor; everything else →
   patch. A commit that changes platform files under another scope counts as
   `os`, and the helper names it. Major stays `0` until the platform is
   declared 1.0; the rule past that is not decided, so the helper refuses
   rather than guess. A maintainer may choose a higher version than the
   rule's, never a lower one.
6. **The tag and the GitHub Release are a person's, after the merge.** From an
   up-to-date `main`, a person tags the commit the release PR put on `main`
   (its merge commit), `git tag -a vX.Y.Z -m "MixOS vX.Y.Z" <commit>`, pushes
   it, and publishes a GitHub Release for it whose notes are the
   `CHANGELOG.md` section: `gh release create vX.Y.Z --verify-tag`. Without
   `--verify-tag`, `gh` creates a missing tag itself, and a lightweight one.
   Pushing a tag is the one sanctioned push to `origin` that is not a branch.
   `/mixos deploy release` prints the commands and checks the result; it never
   runs them.
7. **The notes.** A stable release's section covers the commits since the
   previous stable release, so a reader who skipped the prereleases misses
   nothing; a prerelease's covers the commits since the prerelease before it.
   Breaking changes come first, with their footers, then features, fixes,
   performance and operations. Documentation, tests, refactors and chores are
   left out, and a subject that isn't a Conventional Commit is listed under
   "Other changes" rather than dropped. `<`, `>`, `[` and `]` are escaped
   outside code spans, so a merged pull request's title can't put a link, an
   image or HTML in the notes. The first release lists no commits: with no
   release before it there is nothing to compare with, and its notes point to
   `WHATS-NEW.md`. `WHATS-NEW.md` stays the narrative, by date, and every
   section links to it at the release's tag.
8. **Prereleases.** A prerelease is `vX.Y.Z-rc.N`, cut the same way with
   `--pre` (`--pre beta` gives `-beta.N`), and marked as a prerelease on
   GitHub.
9. **The upgrade unit is the release tag.** An operator merges the newest
   release tag into their fork, not `upstream/main`, which between releases
   holds unreleased work. `docs/hosting/README.md` has the steps, and each
   host's guide links to them.
10. **Only the core repository makes `v*` tags.** A fork's own would collide
    with the core's when it fetches them, so `/mixos deploy release` refuses
    to run anywhere but `mixoshq/mixos`.

## File-level changes

Built with this amendment:

- `scripts/release-prep.ts` — plans the next version (or finds the merged
  release to tag), writes the release PR's files with `--write`, and prints a
  release's notes with `--notes`. Reads local git refs and the working tree;
  never commits, tags or pushes. Tested by `scripts/release-prep.test.ts`.
- `.claude/skills/mixos/actions/deploy.md` — a **Release** section, reached by
  `/mixos deploy release`:
  1. requires `main`, clean, level with `origin/main`, no open release PR,
     local release tags matching `origin`'s, CI green on `HEAD`, and
     `npm run verify:repository-url` passing;
  2. asks the helper where the release stands, and checks that the last
     release has its annotated tag and GitHub Release;
  3. shows the version, why, and the notes, and waits for a yes;
  4. writes the release commit on `release/vX.Y.Z` and opens the PR;
  5. after the merge, a later run: prints the commands for the tag and the
     GitHub Release, reporting any commit that reached `main` between the
     release PR's branch and its merge and so isn't in the notes;
  6. checks the tag and the GitHub Release once a person has run them.
- `.claude/skills/mixos/SKILL.md` — the `deploy` row mentions `release`.
- `README.md` — a "Releases" section. `docs/hosting/README.md` — "Upgrading",
  merging the release tag; each host guide's upgrade section links to it.
- `CONTRIBUTING.md`, `OS-UPDATES.md`, `WHATS-NEW.md` — a line each.
- `CHANGELOG.md` — created by the first release PR.

Still to come, outside this plan: notices of new releases on the admin pages,
a release list on mixos.org built from the annotated tags on `main` and
`CHANGELOG.md`, `requiresMixOS` floors declared when an extension is published,
and mixos.org's own pages on upgrading and releasing.

## Verification

- `npm test` runs `scripts/release-prep.test.ts`: version order, the bump
  rule, footers, the escaping, and whole cycles in scratch repositories. Those
  cover the first release, patch and minor, the merge commit as the tag's
  target with a late commit reported, prereleases, and the refusals.
- `npx tsx scripts/release-prep.ts` on `main` before the first release
  proposes `v0.1.0`, the first release, and writes nothing.
- After the first release, on `main`: `git describe --abbrev=0` names
  `v0.1.0`, `git cat-file -t v0.1.0` prints `tag`, and the GitHub Release's
  notes are the `CHANGELOG.md` section. A fork that runs `git merge v0.1.0`
  gets a `Merge tag 'v0.1.0'` commit, and once deployed its admin pages show
  `MixOS 0.1.0`.
