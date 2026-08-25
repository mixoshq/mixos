---
description: Start a feature branch, open a deploy PR, or cut a production release tag
argument-hint: [deploy|release] [notes]
---

You are managing git branches, pull requests, and production releases for a
developer building on **MixOS**, so they don't have to do it by hand. One
call does the right thing based on where they are in the workflow: start work on a
fresh branch; commit, push, and open a PR when they're ready; or cut a versioned
production release tag from `main`.

## Golden rules (never break these)

- **Never commit to, push to, or merge `main`.** All work goes through a feature
  branch and a PR. The one sanctioned push to `origin` is a **release tag** in the
  Release phase — a `vX.Y.Z` *tag* (never a commit to `main`), and only after an
  explicit go-ahead.
- **Open the PR only — never merge it, and never enable auto-merge.** Merging a PR
  into `main` triggers the production build-and-deploy (`.github/workflows/build-push-and-deploy.yml`,
  un-gated), so merging is the human's decision. Stop once the PR is open.
- **A stale branch must not merge.** A branch behind `origin/main` has to be updated
  before its PR merges — the merge-CD path builds the *branch head*, so merging
  stale code reverts everything merged since the branch's base (root cause of
  issue #85). The Deploy phase enforces this as a warning.
- **Never cut a release tag on a CI-skip commit.** If the tagged commit's message
  carries `[skip ci]` (or `[ci skip]` / `[no ci]` / `[skip actions]` /
  `[actions skip]`), the tag-triggered build never fires and the release is a silent
  no-op. The Release phase walks back to the newest non-skip commit.
- **Confirm the branch name** with the user before creating it, and **confirm the
  version number** before cutting a release tag.
- Checks **warn, they don't block** — surface failures and let the user decide.
- **Review the manifest before you commit an app or connector.** `lastUpdated`
  stamps itself in the pre-commit hook, so the date is never the thing you forget
  — but the date is a claim that the manifest is current, and only you can check
  that it is. See the manifest review in the Deploy phase.

## How code reaches prod (two paths)

1. **Merge to `main` → `build-push-and-deploy.yml` (un-gated CD).** Fires on every
   merged PR and rolls out immediately with no approval. ⚠️ It builds the **PR
   branch head**, so merging a branch that is behind `main` reverts everything
   merged in the interim (issue #85). The Deploy phase's stale-base guard is the
   command-level defense until "require branches up to date" branch protection and
   the upstream `mixactions` checkout fix land.
2. **`vX.Y.Z` tag → `build-and-push.yml` → `deploy.yml` (gated `production`).** What
   the Release phase uses. A tag build checks out the tagged commit (`github.sha`),
   so it is **immune to the stale-head bug**, it pauses for a reviewer if the
   `production` environment has one, and it leaves an **immutable version to roll
   back to**. This is the safe promotion path.

## Commit message discipline (drives versioning)

Every commit this command writes — and every one it asks the developer to write —
follows Conventional Commits, so the Release phase can infer the version bump and
assemble the changelog from history instead of guessing.

**Format:** `<type>(<scope>): <summary>`

- **type** — `feat` (new user-facing behavior), `fix` (bug fix), `ops` (infra /
  deploy plumbing), or `refactor` / `perf` / `test` / `docs` / `chore` (no behavior
  change / housekeeping). These mirror the branch-name prefixes.
- **scope** — the app or connector slug the change lives in, or **`os`** for
  anything platform-wide (outside `apps/` and `connectors/`: `src/`, `scripts/`,
  `.github/`, `supabase/migrations/`, root config). Use `deps` for dependency
  bumps.
- **breaking change** — append `!` before the colon (`feat(<slug>)!:`) **and** add a
  `BREAKING CHANGE: <what breaks + how to migrate>` footer.
- **summary** — imperative mood, ≤ ~70 chars, no trailing period.

**How the type/scope maps to a version bump (0.x scheme):**

| Highest-ranking change since the last tag | Bump | Example |
|---|---|---|
| any breaking (`!` / `BREAKING CHANGE`), **or** any `os`-scoped / OS-path change | **minor** | `v0.1.3 → v0.2.0` |
| everything else (`feat`/`fix`/… inside an app or connector, `docs`) | **patch** | `v0.1.3 → v0.1.4` |

Major stays `0` while the platform is pre-1.0, so a breaking change bumps the minor.

When the command commits, it writes the message in this form — inferring
`type`/`scope` from the changed paths — and confirms the wording. Prefer **one commit
per scope** when a branch spans unrelated areas, so the changelog stays legible.
Always end with the required trailer on its own line:

```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

## Phase detection

Read git state and pick a phase:

- `git branch --show-current` and `git status --porcelain`.
- If `$ARGUMENTS` contains **`release`** → **Release phase** (must run from an
  up-to-date `main`; the phase enforces that itself).
- If the current branch is **`main`** (and `$ARGUMENTS` says neither `deploy` nor
  `release`) → **Branch phase**.
- If on a **feature branch** (anything but `main`), or `$ARGUMENTS` contains
  **`deploy`** → **Deploy phase**.
- Detached HEAD or an unexpected state → stop and explain; don't guess.

---

## Branch phase — start work on a new branch

1. **Base off the freshest `main`.** Run `git fetch origin main`. If local `main`
   is behind `origin/main`, say so and offer to fast-forward it first
   (`git merge --ff-only origin/main`) so the branch isn't based on stale code.
   Any uncommitted changes in the working tree carry over to the new branch, so
   they're safe.
2. **Infer a branch name.** Prefer the slug of a matching plan file in
   `docs/plans/` if one exists for this work. Choose the type prefix by the nature
   of the change: `fix/` for a bug fix, `ops/` for infra (`.github/`, `vercel.json`,
   `scripts/`), otherwise `feat/`. Kebab-case the rest (mirrors the
   `docs/plans/README.md` slug convention). Example: `feat/deal-radar`.
3. **Confirm before creating.** Show the proposed name and let the user accept or
   edit it. Then create it: `git switch -c <name>` (this keeps any uncommitted
   changes).
4. Tell them the branch is ready — keep developing, and run **`/mix-deploy`** again
   (or `/mix-deploy deploy`) when they're ready to open the PR.

---

## Deploy phase — commit, push, open the PR

1. **Guards.**
   - Refuse if the current branch is `main`.
   - **Stale-base guard (issue #85):** `git fetch origin main`, then
     `git rev-list --count HEAD..origin/main`. If the branch is behind `origin/main`,
     **warn prominently** — the merge-CD path builds this branch's *head*, so merging
     it as-is reverts the commits added to `main` since your base. Offer to update
     the branch (`git merge origin/main`, or rebase) and continue only once the user
     decides. This is the command-level stand-in for "require branches up to date"
     until that branch protection is enabled.
2. **Run the MixOS verification suite** and capture pass/fail for each:
   - `npx tsx scripts/generate-project-registry.ts` (registry)
   - `npm run typecheck`
   - `npx eslint <changed dirs>` (scope to the directories that changed)
   - `npm run build` (also regenerates the registry)
   - `npm run db:local` **only if** `supabase/migrations/*.sql` changed, and
     `npm run migrate:apps` **only if** any `apps/*/migrations/*.sql` changed.
     Both run against the local Docker stack, which is what a pre-PR check
     should prove. Do **not** run `npm run db:push` here — it targets the
     *linked hosted* project, so on a feature branch it would push unreviewed
     schema straight at production. Pushing to a hosted database is a deploy
     step, not a verification step (see the README's Deploying section).

   If anything fails, summarize it clearly and **ask whether to open the PR anyway**
   (warn, don't block).
3. **Update the "what's new" notes.** If this branch adds or changes a
   developer-facing behavior — a new `/mix-*` command, a workflow change, or a
   breaking change — add a short `## <today's date>` entry at the top of
   `WHATS-NEW.md` (newest-first) so it surfaces after other developers pull. Skip
   for internal-only changes (refactors, an app/connector build with no
   platform-facing impact). Confirm the wording with the user.
4. **Review the manifest, then commit.**

   **First, if this branch touched an app or connector, check its manifest is
   still true.** The commit is about to stamp `lastUpdated`, and that date claims
   the manifest describes what exists today. Read the actual code and compare:

   - **`description`** — does it describe what the app does *now*? An app that
     grew a forecasting widget but still says "tracks sales" is the common case.
     This is the field most likely to have drifted, and the one users read.
   - **`name`** / **`displayName`** — still what people call it?
   - **`icon`** — a [Lucide](https://lucide.dev/icons/) name, lowercase and
     hyphenated (`bar-chart`, not `BarChart`).
   - **`authors`** — still accurate? The template ships `Your Name` /
     `you@example.com`; if you see those, they were never filled in.
   - **`connectors`** — every connector the app actually calls, and nothing it
     doesn't. A stale entry blocks registration until an admin configures a
     connector the app never uses.
   - **`widgets[].description`** — shown in the widget catalog when someone is
     deciding whether to add it.

   Propose any changes and **confirm them with the user before writing**.

   **Then commit** any uncommitted changes (skip if the tree is already clean and
   the branch has commits ahead of `origin/main`). Stage the work. Run
   `npx tsx scripts/stamp-updated.ts --dry-run` first if you want to see which
   manifests the commit will stamp; the pre-commit hook does the real stamping
   and re-stages the manifests itself, so there is no separate publish step and
   nothing extra to add. It stamps the *staged* manifest, so if you are holding
   unstaged edits in an `app.json` the commit takes only the date and your edits
   stay in the working tree — the manifest reading as modified afterwards is
   expected, not a misfire. An `app.ts` manifest is warned about rather than
   stamped — the script won't rewrite arbitrary TypeScript, so paste the line it
   prints into the default export yourself and re-stage. Write the
   message per **Commit message discipline** above (`<type>(<scope>): …`, plus a
   `BREAKING CHANGE:` footer when applicable) so the eventual release can version
   itself from history. If the branch already carries ad-hoc commits that don't
   follow the convention, note it — the Release phase falls back to change-scope, but
   a clean history makes the bump and changelog trustworthy. End the message with the
   required trailer on its own line:

   ```
   Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
   ```
5. **Push:** `git push -u origin <branch>`.
6. **Compose the PR body** (see template) from `git diff origin/main...HEAD` and the
   branch's commit messages.
7. **Open the PR:** `gh pr create --base main --head <branch> --title "<inferred title>" --body "<body>"`.
   - If a PR for this branch **already exists**, the push above updated it — offer
     to refresh its body with `gh pr edit <n> --body ...`.
   - If **`gh` is missing or not authenticated** (`gh auth status` fails), don't
     fail: print the compare URL
     `https://github.com/MixOSWork/mixos/compare/main...<branch>?expand=1`
     together with the full markdown body (ready to paste), and tell them to run
     **`/mix-init`** to install/authenticate `gh`.
8. **Stop.** Print the PR URL and say: *"Review and merge when you're ready —
   merging into `main` triggers the production build-and-deploy. I won't merge for
   you."*

### PR body template

Generate GitHub-flavored markdown with these sections:

- **Summary** — what this change does and why (1–3 sentences).
- **What changed** — grouped by scope, derived from the changed paths:
  `app:<slug>` (files under `apps/<slug>/`), `connector:<slug>`
  (`connectors/<slug>/`), **OS** (anything under `src/`, `scripts/`, `.github/`,
  `vercel.json`, root config, etc.), `migrations`, `docs`.
- **⚠️ OS change** — include this heads-up **only if** any changed file is outside
  `apps/` and `connectors/` (excluding `docs/plans/*`):
  note that Danger will label the PR `os-change` and it needs admin review before
  merge (per `OS-UPDATES.md`).
- **Migrations** — list any new `**/migrations/*.sql`; note they apply automatically
  on deploy. Omit the section if there are none.
- **Verification** — the pre-PR check results (✓/⚠ per check) plus any manual
  testing that was done this session.
- **Deploy note** — "Merging into `main` triggers `build-push-and-deploy` → prod
  (un-gated). Don't merge until reviewed."
- Footer (verbatim):

  ```
  🤖 Generated with [Claude Code](https://claude.com/claude-code)
  ```

---

## Release phase — cut a production version tag

Promotes what's on `main` to prod through the **gated** tag path
(`build-and-push.yml` → `deploy.yml`, `production` environment). Unlike merge-CD,
a tag build checks out the tagged commit, so it is **immune to the stale-head bug**
(issue #85) and leaves an **immutable `vX.Y.Z`** to roll back to. Trigger:
`$ARGUMENTS` contains **`release`**.

1. **Be on an up-to-date `main`.** `git fetch origin main --tags`. Refuse unless the
   checkout is `main` *and* level with `origin/main` (offer `git switch main` +
   `git merge --ff-only origin/main`). The tag must capture exactly what integrated
   on `main` — nothing local, nothing stale.
2. **Pick the tag target — skip a CI-skip tip.** Start at `origin/main`'s tip. If its
   message carries a CI-skip directive (`[skip ci]` / `[ci skip]` / `[no ci]` /
   `[skip actions]` / `[actions skip]`), the tag-triggered build **won't fire** — a
   silent no-op release. Walk back to the newest ancestor without such a directive
   and tag that commit. Show the user the chosen commit and
   `git diff --stat <target>..origin/main` so they see exactly what (if anything) is
   left off.
3. **Compute the next version from history.** Last tag:
   `git describe --tags --abbrev=0` (parse `vMAJOR.MINOR.PATCH`). Classify the
   commits since it — `git log <lasttag>..<target> --format='%s%n%b'` — by the
   **Commit message discipline** rules: **minor** if any commit is breaking
   (`!` / `BREAKING CHANGE`) or `os`-scoped, else **patch**. Cross-check against
   `git diff --name-only <lasttag>..<target>`: if a path outside `apps/`/`connectors/`
   changed (excluding `docs/plans/*`) but no commit
   was `os`-scoped, treat it as **minor** and flag the mislabeled commit. Show the
   computed version, the commits that drove it, and **confirm before tagging** — a
   hotfix or recovery may deliberately override to a patch, so let the user set the
   final number.
4. **Pre-flight the tag.** Refuse if it already exists locally (`git tag -l <v>`) or
   on the remote (`git ls-remote --tags origin <v>`). The target is on `origin/main`
   by construction, so ancestry is guaranteed.
5. **Cut an annotated tag** on the target commit:
   `git tag -a <v> <target-sha> -m "<message>"`. Build the message from the commits
   since the last tag, grouped by `type`/`scope` (a mini changelog); if step 2 walked
   back off the tip, note which commit was tagged and why.
6. **Confirm, then push — this is the deploy.** Pushing the tag fires the gated prod
   rollout, so treat it like a merge: state plainly that `git push origin <v>` builds
   the image and (once any `production`-env reviewer approves) rolls it out to prod,
   and get an explicit go-ahead. Then `git push origin <v>`.
7. **Watch the run and verify the rollout took the new image.**
   - Find it: `gh run list --workflow=build-and-push.yml --limit 5` → the row for
     `<v>`. If it never appears, the build was skipped — recheck step 2.
   - If the `deploy` job pauses, tell the user to approve the `production`
     environment in the GitHub UI (the tag path is gated by design).
   - Watch to completion: `gh run watch <id> --exit-status`.
   - From the `Verify rollout` step, read and report the live pod **image digest**.
     If you recorded the pre-release digest (from the previous deploy run's
     `Verify rollout` log), assert it **changed** — an unchanged digest means the
     rollout didn't pick up the new image. A digest proves the image rolled, not that
     the feature works, so remind the user to smoke-test.
8. **Stop.** Report the tag, the target commit + version reasoning, the run URL, the
   live digest, and the gate outcome (auto-rolled vs awaiting approval). If this
   release changed a `/mix-*` command or other developer-facing behavior, offer to
   add a `WHATS-NEW.md` entry (as in the Deploy phase).

## Notes

$ARGUMENTS
