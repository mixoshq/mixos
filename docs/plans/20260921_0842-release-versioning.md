# Release versioning on Vercel

## Context

The platform already depends on knowing its own version, and nothing sets it.

- [`src/lib/platform/version.ts`](../../src/lib/platform/version.ts) reads
  `MIXOS_RELEASE` to answer `requiresMixOS` floors when an extension is
  installed from the catalogue. Unset, the version is `null` and every floor
  resolves to *unknown → allowed*. That is the right behaviour for a
  developer checkout; it is the wrong behaviour for production, where it makes
  the compatibility gate a no-op.
- [`src/lib/repository/client.ts`](../../src/lib/repository/client.ts)
  `isReleaseBuild()` keys off the same variable. It is the runtime layer of
  the repository-URL lock (`docs/security-architecture.md` §31): a release
  build ignores any `MIXOS_REPOSITORY_URL` override. Unset, that layer is
  inert in production.
- The admin UI and bug reports have no version to name.

Both were designed around a tag-triggered image build that passed
`--build-arg MIXOS_RELEASE=${{ github.ref_name }}` into the runner stage
(`Dockerfile` still declares the `ARG`). That pipeline was removed when the
repository moved to Vercel: Preview per PR, Production on merge to `main`,
[`ci.yml`](../../.github/workflows/ci.yml) as the only gate. No tag has ever
been pushed, and `/mixos deploy` no longer has a release phase.

## Decisions

1. **Tags stay, and they name what is running.** A `vX.Y.Z` tag on `main` is
   the unit the catalogue, `requiresMixOS`, and rollback conversations refer
   to. Vercel's instant rollback restores a build; it does not tell anyone
   which version that was.
2. **The version lives in `package.json`**, not in a CI variable. It is the
   one place a Next.js build can read at build time on any host, and it is
   already `0.1.0`.
3. **Release-PR pattern.** A release is a pull request that bumps
   `package.json` and prepends a `CHANGELOG.md` section, both derived from the
   Conventional Commits since the last tag. Merging that PR is the deploy;
   the merge commit is what gets tagged. "Never commit to `main`" holds.
4. **`MIXOS_RELEASE` is set only in Vercel production**, derived from
   `package.json` in `next.config.ts` when `VERCEL_ENV === "production"`.
   Previews and local builds stay unversioned, which is what `version.ts`
   already assumes ("unknown is not a failure").
5. **Bump rule, 0.x scheme.** Any breaking commit (`!` / `BREAKING CHANGE`)
   or any `os`-scoped commit → minor; everything else → patch. Major stays
   `0` until the platform is declared 1.0. The previous `/mixos deploy`
   carried this table; it moves here.
6. **The tag is pushed by a human, after the merge**, from an up-to-date
   `main`, and only ever on the release PR's merge commit. Pushing a tag is
   the one sanctioned push to `origin` that is not a branch.

## File-level changes

- `next.config.ts` — `env.MIXOS_RELEASE = process.env.VERCEL_ENV === "production" ? \`v${pkg.version}\` : undefined`; `MIXOS_COMMIT` from `VERCEL_GIT_COMMIT_SHA` on any Vercel env.
- `package.json` — version becomes meaningful; `CHANGELOG.md` created at the
  first release.
- `.claude/skills/mixos/actions/deploy.md` — a **Release** section, reached by
  `/mixos deploy release`, that:
  1. requires an up-to-date `main` checkout;
  2. computes the next version from `git log <lasttag>..HEAD` by decision 5,
     cross-checking `git diff --name-only` for OS paths a commit forgot to
     scope, and confirms it with the user;
  3. writes the `package.json` bump and the changelog section on a
     `release/vX.Y.Z` branch and opens the PR;
  4. after the PR merges (a later invocation, detected by the open release PR
     being merged and `main` at its merge commit): `git tag -a vX.Y.Z -m
     <changelog>` and `git push origin vX.Y.Z`, then reports.
- `SKILL.md` — the `deploy` row mentions `release`.
- `Dockerfile` — drop the `MIXOS_RELEASE` `ARG` comment that names the removed
  workflow, or keep the `ARG` for `npm run docker:prod` and say so.
- `docs/security-architecture.md` §31 — the runtime lock's source of truth is
  now `package.json` via `next.config.ts` on Vercel production; update the
  layer description.
- `README.md` "Deploying" — a short "Releases" subsection.

## Verification

- A Preview build reports `mixosVersion() === null`; a Production build
  reports the `package.json` version. Check `/api/health/ready` or the admin
  About panel on each.
- With `MIXOS_REPOSITORY_URL` set to a localhost value in a Production
  environment, the override is ignored and the once-per-process warning is
  logged (`isReleaseBuild()` is true).
- Installing an extension whose `requiresMixOS` is above the running version
  is refused on Production and allowed on a Preview.
- `git describe --tags` on `main` after the first release names the merge
  commit of the release PR.
