# /mixos upgrade

Takes this copy of MixOS to MixOS's newest release. It finds the release,
shows what's in it, merges it on a branch, checks the result, and hands over
to `/mixos deploy` for the pull request. Merging that pull request is what
ships the upgrade: nothing here pushes to `main`, merges a pull request or
deploys.

The copy is a private repository of the person's own: `origin` is theirs, and
`upstream` is `mixoshq/mixos`, where MixOS's releases are. A release is an
annotated tag `vX.Y.Z` on upstream's `main`. Between releases, `upstream/main`
holds work that isn't released, and this action never merges it.

Below, `vA.B.C` is the release this copy has, and `vX.Y.Z` the newest.

## 0. Ground rules

- Merge only a release tag: never `upstream/main`, another branch or a
  prerelease, a tag with a suffix such as `v0.3.0-rc.1`.
- Merge on a branch, `upgrade-vX.Y.Z`, never on `main`.
- Never resolve a conflict blindly: no `-X theirs` or `-X ours`, and no taking
  one side for every file. Each conflict is decided with the person.
- Never drop the person's own changes, or their own extensions.
- Never use `--force`, `--no-verify`, `git stash` or `git reset --hard`.
  `/mixos deploy`'s ground rules hold too
  (`.claude/skills/mixos/actions/deploy.md`, section 0).
- Never run `npm run db:push`, `npm run db:migrate` or `npm run release`: each
  can reach a production database. The release step applies a release's
  migrations when it deploys.

## 1. Check the copy

```bash
git remote get-url origin
git remote get-url upstream
git status --porcelain
git branch --show-current
git fetch origin main --quiet && git rev-list --left-right --count origin/main...main
```

Stop, and say why, unless all of these hold:

- **`upstream` is `github.com/mixoshq/mixos`**, over https or ssh. With no
  `upstream`, and `origin` their own repository, offer to add it:
  `git remote add upstream https://github.com/mixoshq/mixos.git`.
- **`origin` is their own repository**: there is one, and it isn't
  `mixoshq/mixos`. Otherwise point to `/mixos init`, which sets both remotes up
  at its end (Step 7), as `/mixos deploy` does.
- **The working tree is clean.** If it isn't, offer `/mixos deploy` first, to
  ship what's there, or stop.
- **On `main`, level with `origin/main`.** On another branch with a clean tree,
  offer `git switch main`. Behind (the first count): `git pull --ff-only origin
  main`. Ahead (the second count): stop and show
  `git log --oneline origin/main..main`, since commits on `main` that `origin`
  lacks need sorting out first.

## 2. Find the newest release

```bash
git fetch upstream --tags
git tag -l --merged upstream/main --sort=-v:refname 'v*' | grep -v -- - | head -1
git describe --abbrev=0 --exclude '*-*' HEAD
node -p "require('./package.json').version"
```

- **The newest release** is the second command's: the highest `vX.Y.Z` on
  upstream's `main`, and never a prerelease, the rule the install prompt uses.
  Only tags on upstream's `main` count, so a tag of the person's own doesn't.
  `git cat-file -t vX.Y.Z` prints `tag`: an annotated tag, as releases are.
- **This copy's release** is the third, and `package.json` holds its version.
  If they disagree, say so: `package.json` changed without a release.
- **Already there:** if `git merge-base --is-ancestor vX.Y.Z HEAD` exits 0,
  this copy has the newest release. Say "This copy runs MixOS vA.B.C, the
  newest release." and stop.

## 3. Show what's coming, and ask

Before changing anything:

```bash
git show vX.Y.Z:CHANGELOG.md
git diff vA.B.C vX.Y.Z -- WHATS-NEW.md
git diff --name-status vA.B.C vX.Y.Z -- supabase/migrations/
```

- **The notes**: each `CHANGELOG.md` section above `vA.B.C`'s, newest first.
  They are the GitHub Releases' notes too.
- **Anything breaking**: those sections' **Breaking changes**, with their
  notes, and what `WHATS-NEW.md` gained between the two tags.
- **New platform migrations**: the files added under `supabase/migrations/`
  (`A`). Migrations only go forward.
- **What kind of step it is**, as the release notice says it: a major release,
  or a minor one while MixOS is 0.x, may need changes; a patch release is
  fixes. Several releases at once is fine: say how many.

Then ask, in plain words:

> MixOS vX.Y.Z is out; this copy runs vA.B.C. [The step, the breaking
> changes, and any new migrations.] I'll merge it on a branch,
> `upgrade-vX.Y.Z`, and check that it builds. Nothing reaches your deployment
> until you merge the pull request. Go ahead?

Wait for a yes.

## 4. Merge it on a branch

```bash
git switch -c upgrade-vX.Y.Z
git merge --no-edit vX.Y.Z
```

A clean merge goes on to step 5.

**Conflicts.** List them:

```bash
git diff --name-only --diff-filter=U
```

Then go through them with the person, one file at a time:

1. Show both sides: what MixOS changed in the file, and what they did, each
   since the release this copy had:

   ```bash
   git diff vA.B.C vX.Y.Z -- <file>
   git diff vA.B.C HEAD -- <file>
   ```

2. Explain each in plain words, and propose a version that keeps both, usually
   the release's change with theirs carried over onto it. Edit the file to
   that, with no conflict markers left, and show the result.
3. Once they agree, `git add <file>`.

Three kinds of file need a word:

- **Their own extensions**, anything under `apps/`, `connectors/` or `themes/`
  the core doesn't carry (`scripts/core-extensions.ts`), are theirs. MixOS's
  releases don't carry them, so they don't conflict; leave them as they are.
- **The templates, Wall-E and the built-in themes** are MixOS's. If they
  changed one, show what they changed against the release, and ask whether to
  keep their change or take MixOS's.
- **`package-lock.json`**: take the release's for this one file
  (`git checkout --theirs package-lock.json`), run `npm install` to put back
  any dependency of their own, and `git add package-lock.json package.json`.

When none is left, finish the merge:

```bash
git diff --name-only --diff-filter=U    # prints nothing
git commit --no-edit
```

**To give up**, at any point before that commit:

```bash
git merge --abort
git switch main
git branch -D upgrade-vX.Y.Z
```

`main` is as it was: only the branch ever had the merge.

## 5. Check it

```bash
git diff --name-only main HEAD -- package-lock.json supabase/migrations/
npm ci
npx tsx scripts/generate-project-registry.ts
npm run typecheck
npm run lint
```

- **`npm ci`** only when the first command lists `package-lock.json`.
- **New platform migrations**, when it lists any: on the dev container,
  `npm run db:local` applies them to the local database. The release step
  applies them to each deployment's database when it deploys.
- Report each result. When a check fails, read its reason and help fix it
  before going on: "What breaks" in
  [docs/hosting/after-you-install/upgrading.md](../../../../docs/hosting/after-you-install/upgrading.md#what-breaks)
  lists the usual ones. A fix is a commit on this branch.

## 6. Hand over to /mixos deploy

Follow `.claude/skills/mixos/actions/deploy.md` from its step 1. The branch is
clean and ahead of `origin/main`, which is its case C: it pushes the branch and
opens the pull request against `main`. Two things in it come from here:

- **The title:** `Upgrade MixOS to vX.Y.Z`.
- **The body:** deploy's, with a `## Release notes` section after
  `## Summary`, holding the `CHANGELOG.md` sections from step 3.

Then say:

> The pull request is open: <url>. Back up the database before you merge it
> (step 1 of docs/hosting/after-you-install/upgrading.md). Merging it ships the
> upgrade: each host runs the release step, which applies the new migrations,
> and the admin pages then show vX.Y.Z.

## Notes

The arguments the dispatcher passed — everything after `upgrade` in the invocation. Usually empty.
