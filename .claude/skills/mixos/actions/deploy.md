# /mixos deploy

Gets the current work onto GitHub as a PR against `main`. Deployment itself
is done by Vercel: every PR gets a Preview deployment, and merging into
`main` deploys Production. `.github/workflows/ci.yml` gates the PR (lint,
audit, repository-URL check, typecheck, build). This action stops at the PR —
merging is a human decision.

## Flags

- `--reset` — do none of the above. Instead, return to `main`, bring it up
  to date, and clean out branches that are finished. See **Reset** at the
  end of this file. Anything else after `deploy` is ignored.

## 0. Ground rules

- Never commit or push to `main` directly. Every path below ends on a branch.
- Never merge the PR, and never enable auto-merge. Merging into `main` is the
  production deploy; that is the human's call.
- Never use `--force`, `--no-verify`, `git add -A` of files you have not
  looked at, or `git stash`. If you would need any of those, stop and say why.
- Do not modify, format, or "tidy" the changes you are committing. This
  action ships what is there. The two exceptions are the manifest review and
  the `WHATS-NEW.md` entry in step 3, and both are confirmed with the user
  before they are written.
- Never run `npm run db:push` here. It targets the *linked hosted* project,
  so on a feature branch it would push unreviewed schema straight at
  production. Applying schema to production is a deploy step a human does
  (README, "Deploying").
- Every commit message ends with the attribution trailer this session was
  given (the `Co-Authored-By: Claude …` line). If the session has none, omit it
  rather than invent one.

## 1. Read the situation

Run, together:

```bash
git status --porcelain
git branch --show-current
git fetch origin main --quiet && git log --oneline origin/main..HEAD
git rev-list --count HEAD..origin/main
git diff --stat && git diff --cached --stat
```

If not on `main`, also find out whether the branch already has a PR:

```bash
gh pr list --head "$(git branch --show-current)" --state all --json number,state --jq '.[] | "#\(.number) \(.state)"'
```

(Skip if `gh` is not authenticated — treat the branch as having no PR.)

Decide which case you are in:

| Working tree | Branch | Case |
| --- | --- | --- |
| dirty | `main` | **A** — branch, commit, push, PR |
| dirty | not `main`, no PR or a closed one | **B** — commit, push, PR |
| dirty | not `main`, PR **open** | **B-open** — commit, push, update that PR |
| dirty | not `main`, PR **merged** | **B-merged** — the branch is finished; see below |
| clean, and `origin/main..HEAD` is non-empty | not `main`, no open PR | **C** — push, PR |
| clean, and `origin/main..HEAD` is non-empty | not `main`, PR open | **Nothing to deploy** unless there are unpushed commits — then push and stop. |
| clean, and `origin/main..HEAD` is empty | any | **Nothing to deploy.** Say so and stop. |
| clean | `main` | **Nothing to deploy.** Say so and stop. |

**B-merged** — the branch's PR has merged, so `origin/main` already contains
its commits and the branch is dead. Do not commit onto it: the new PR would
come from a branch that should be deleted. Instead carry the uncommitted
work onto a fresh branch from `origin/main`. This is safe when every dirty
file is identical on `HEAD` and `origin/main`; check with

```bash
git diff --quiet HEAD origin/main -- <each dirty path> && echo identical
```

If identical, the branch to create in step 5 is made with
`git switch -c <name> origin/main` — git carries the working-tree changes
across untouched — and the rest of the run is case A. If NOT identical
(someone changed one of those files on `main` after the merge), stop and
show the difference; merging that by hand is not this action's job.

"Dirty" means `git status --porcelain` printed anything — untracked files
count. Look at every untracked file before including it; if one is clearly
not meant for the repo (a scratch file, a log, a local dump), leave it out and
say so in the plan.

If the branch is not `main` and the `rev-list --count` above is non-zero,
`main` has moved on since the branch was cut. **Warn, don't block:** the
Preview will not show what `main` looks like after the merge, and conflicts
are cheaper to find here than in the PR. Offer `git merge origin/main`
(never rebase a pushed branch) and continue once the user decides.

If `git merge-base HEAD origin/main` fails — no common ancestor — stop and
explain: the PR would carry unrelated history.

## 2. Pre-flight

Whenever there is uncommitted work (cases A, B, B-open, B-merged). These are
the checks `ci.yml` will run on the PR, so failing them here is cheaper than
failing them there. Run in this order and read each result:

```bash
npx tsx scripts/generate-project-registry.ts   # registry + theme contrast
npm run typecheck
npm run lint
npm run verify:repository-url
npm run build
```

Then, only when the relevant files changed:

- `supabase/migrations/*.sql` changed → `npm run db:local` (applies to the
  local Docker stack, which is what a pre-PR check should prove).
- any `apps/*/migrations/*.sql` changed → `npm run migrate:apps`.

If any of these reports **errors**, print them and stop. Nothing is
committed. Warnings do not block; mention them in the plan.

## 3. Plan the commits

Whenever there is uncommitted work. Read the full diff — `git diff` plus the
content of each untracked file — and group the hunks into logical changes. A
logical change is something that would make sense as its own line in a
changelog: "gate sign-in to superadmins", "add the Gmail connector", "rename
the header link". It is NOT a file or a directory: one file can hold two
changes, and one change usually spans several files. Prefer one commit per
scope when the work spans unrelated areas, so the changelog stays legible.

Write a commit message for each group in **Conventional Commits** form —
look at `git log --format=%s -15` for the register:

```
<type>(<scope>): <summary>
```

- **type** — `feat` (new user-facing behavior), `fix`, `ops` (infra / deploy
  plumbing), or `refactor` / `perf` / `test` / `docs` / `chore`. These mirror
  the branch-name prefixes.
- **scope** — the app, connector, or theme slug the change lives in, or
  **`os`** for anything platform-wide (`src/`, `scripts/`, `.github/`,
  `supabase/migrations/`, root config, `.claude/`). `deps` for dependency
  bumps.
- **breaking change** — `!` before the colon (`feat(os)!:`) **and** a
  `BREAKING CHANGE: <what breaks + how to migrate>` footer.
- **summary** — imperative mood, ≤ ~70 chars, no trailing period, specific
  about the *what*. If a change needs explaining, a short body saying **why**,
  wrapped at 72 columns.

The type and scope are what a future release derives its version bump and
changelog from (see `docs/plans/20260921_0842-release-versioning.md`), so a
mislabeled commit costs more later than it saves now.

If everything belongs to one logical change, one commit is correct. Do not
split for the sake of splitting.

**Manifest review.** If a group touches files under an app, connector, or
theme, the pre-commit hook will stamp that manifest's `lastUpdated`
(preview with `npx tsx scripts/stamp-updated.ts --dry-run`). The date claims
the manifest describes what exists today, and only you can check that.
Read the code and compare:

- `description` — does it describe what the thing does *now*? This is the
  field most likely to have drifted, and the one users read.
- `name` / `displayName` — still what people call it?
- `icon` — a [Lucide](https://lucide.dev/icons/) name, lowercase and
  hyphenated (`bar-chart`, not `BarChart`).
- `authors` — the template ships `Your Name` / `you@example.com`; if you see
  those, they were never filled in.
- `connectors` — every connector the app actually calls, and nothing it
  doesn't. A stale entry blocks registration until an admin configures a
  connector the app never uses.
- `widgets[].description` — shown in the widget catalog.

Any correction goes in the plan as its own line, and is written only after
the user confirms.

**What's new.** If the work adds or changes developer-facing behavior — a
`/mixos` action, a workflow change, a breaking change — draft a short
`## <today's date>` entry for the top of `WHATS-NEW.md` (newest first) and
put it in the plan; it joins the commit it describes. Skip for internal-only
changes (refactors, an app or connector build with no platform-facing
impact).

If a branch is to be created (cases A and B-merged), also choose its name:
`<type>/<slug>` where the type is `feat`, `fix`, or `ops` by the nature of
the change, and the slug is short kebab-case derived from the changes —
prefer the slug of a matching plan file (`docs/plans/*.md` or
`{apps,connectors,themes}/*/plans/*.md`) when one exists. Example:
`feat/deal-radar`. Check `git branch -a --list '*<slug>*'` and add a `-2`
suffix if it exists.

## 4. Show the plan and wait

Print, then **stop and wait for a yes**:

```
Branch: <name>  (new, from main)
   — or —   Branch: <name>  (current)
   — or —   Branch: <name>  (new, from origin/main — PR #<n> has merged)

Behind origin/main by <n> commits — merging origin/main first.   (omit if 0, or if the user declined)

Commits:
  1. <type>(<scope>): <summary>
       <file>, <file>, <file>
  2. <type>(<scope>): <summary>
       <file>

Manifest: <path> — <field>: "<old>" → "<new>"     (omit if none)
What's new: <one-line summary of the entry>        (omit if none)
Left out: <untracked file> — <one-line reason>     (omit if none)

Then: push to origin and open a PR against main.
   — or, B-open —   Then: push to origin; PR #<n> is open, so its title and body get rewritten to cover every commit.
```

Do not proceed on silence, on a question, or on a partial answer. If the
user edits the plan (renames the branch, regroups, drops a file), apply the
edit and show the plan again.

## 5. Execute

Once confirmed, run through without further prompts.

**Case A** — create the branch:

```bash
git switch -c <name>
```

**Case B-merged** — create it from `origin/main` instead, which carries the
uncommitted changes across:

```bash
git switch -c <name> origin/main
```

**Whenever there is uncommitted work** — first write any manifest correction
and the `WHATS-NEW.md` entry from the plan. Then make each commit in plan
order. Stage precisely what the commit covers:

- Whole files: `git add <paths>`.
- A file split across commits: `git add -p <path>` is interactive and will
  not work here. Instead stage the file's hunks by writing a patch:
  `git diff <path> > <tempdir>/<n>.patch` (use the session's scratch
  directory), edit it down to the hunks for this commit, then
  `git apply --cached <tempdir>/<n>.patch`. Verify with
  `git diff --cached --stat` before committing.

Commit with a heredoc so the body, footer and trailer survive intact:

```bash
git commit -m "$(cat <<'MSG'
<type>(<scope>): <summary>

<body, if any>

BREAKING CHANGE: <if any>

Co-Authored-By: …
MSG
)"
```

The pre-commit hook stamps `lastUpdated` on every manifest whose app,
connector, or theme has a file in the commit, re-stages the manifest, and
validates it. That is expected output, not a failure. It stamps the *staged*
manifest, so if you are holding unstaged edits in a manifest the commit takes
only the date and your edits stay in the working tree.

After the last commit, `git status --porcelain` must be empty apart from
anything you deliberately left out. If it is not, stop and show what remains.

**All cases** — push:

```bash
git push -u origin HEAD
```

## 6. Open the PR — or update the open one

**Case B-open:** do not open a second PR. Rewrite the existing one so its
title and body describe every commit on the branch, not just the new one —
the reviewer reads the PR, not the commit list:

```bash
gh pr edit <n> --title "<title>" --body "$(cat <<'BODY'
<body>
BODY
)"
```

Draft the body exactly as below, then print the PR URL and skip the rest
of this step.

**Every other case:** draft the PR body first, from
`git diff origin/main...HEAD` and the branch's commit messages. Audience:
whoever reviews and merges — assume they have not been in this session.

```
## Summary

<what this change does and why — 1–3 sentences, then one bullet per commit in plain language>

## What changed

<grouped by scope, derived from the changed paths: `app:<slug>`, `connector:<slug>`,
`theme:<slug>`, **OS** (anything under src/, scripts/, .github/, .claude/, root config),
`migrations`, `docs`>

## ⚠️ OS change

<only if any changed file is outside apps/, connectors/ and themes/, excluding build
plans (docs/plans/*.md and any */plans/*.md — a plan describes work, it does not
perform it): "Danger will label this PR `os-change`; it needs admin review before
merge (OS-UPDATES.md)." Omit the section otherwise.>

## Migrations

<list any new **/migrations/*.sql. Note that they do NOT apply on deploy: after
merging, a human runs `npm run db:push` (platform) and/or `npm run migrate:apps`
(per-app) against production, per the README's "Deploying" section. Omit the
section if there are none.>

## Verify on the preview

<2–4 concrete things to click or curl on the Vercel Preview URL, specific to these
changes. Skip if there is nothing user-visible.>

## Verification

<the pre-flight results, ✓/⚠ per check, plus any manual testing done this session>

## Notes

<anything the merger must know: a Vercel env var to set, a secret to add, a
Supabase setting to flip. Omit the section if none.>

Merging into `main` deploys Production on Vercel. Don't merge until reviewed.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

Title: if one commit, its subject; otherwise a short line covering the set.

Then check for the GitHub CLI:

```bash
gh auth status >/dev/null 2>&1 && echo ok
```

**If `ok`:**

```bash
gh pr create --base main --title "<title>" --body "$(cat <<'BODY'
<body>
BODY
)"
```

Print the PR URL. Then say that Vercel will post a Preview URL on the PR
within a few minutes, that `ci.yml` and Danger run against it, and that
merging deploys Production.

**If not `ok`** — the push already happened, so do not undo anything. Print:

1. The compare link: `https://github.com/<owner>/<repo>/compare/main...<branch>?expand=1`
   (read owner/repo from `git remote get-url origin`).
2. The title and body you drafted, in a fenced block, ready to paste.
3. One line: `gh auth login` makes this automatic next time (`/mixos init`
   installs and authenticates it).

## 7. Final message

End with a short summary: branch, the commits (subjects only), the PR or
compare URL, and anything that still needs a human (migrations to apply,
secrets, Vercel settings). Nothing else.

## When something fails midway

- Pre-flight fails → nothing was touched; print the errors.
- A commit fails (hook, empty stage, manifest validation) → show the error
  and the current `git status`; do not retry blindly and do not skip to the
  next commit.
- Push is rejected → do not force. Show the error. The likely cause is the
  branch already exists on origin with different history; suggest a new
  branch name.
- `gh pr create` fails after the push → fall through to the "not ok" path
  above; the work is safe on origin.

## Reset: `/mixos deploy --reset`

For after a PR has merged. Gets the checkout back to a fresh `main` and
removes the branches that are done. Nothing here touches `main`'s history
or any branch with work that has not been merged.

### R1. Refuse to run on a dirty tree

```bash
git status --porcelain
```

If it prints anything, stop and show it. Switching branches with
uncommitted changes either fails or silently carries the changes to `main`;
neither is what "reset" means. Suggest `/mixos deploy` (to ship them) or
tell the user to stash or discard them by hand — this action never does
either.

### R2. Back to main, up to date

```bash
git switch main
git pull --ff-only origin main
git fetch --prune origin
```

`--ff-only` is deliberate: if `main` has diverged locally, stop and show
`git log --oneline origin/main..main`. Local commits on `main` are a
mistake this action must not paper over with a merge.

`--prune` drops the remote-tracking refs for branches deleted on GitHub;
that is what makes step R3 able to see them.

### R3. Find the dead branches

A local branch is dead when either:

- its upstream is **gone** — deleted on GitHub:
  `git branch -vv | grep ': gone]'`
- or its PR has been **merged** but the remote branch was not deleted. This
  is the common case here: the repository does not delete branches on merge.
  For every other local branch except `main`, ask
  `gh pr list --head <branch> --state merged --json number --jq length`; a
  non-zero answer means merged. Skip this check if `gh auth status` fails,
  and say so.

Never include `main`.

### R4. Show, then delete

Print the list and what will happen to each:

```
Deleting:
  <branch>   — PR #<n> merged, remote branch gone
  <branch>   — PR #<n> merged; will also delete origin/<branch>

Keeping:
  <branch>   — no merged PR found                (omit if none)
```

If every branch to delete has a merged PR or a gone upstream, go ahead
without waiting. If any branch is dead only because its upstream is gone
and `gh` could not confirm a merged PR, **stop and wait for a yes** — that
is the one case where the branch might hold unmerged work.

Then:

```bash
git branch -D <branch>                      # -D, not -d: squash-merged branches look unmerged to git
git push origin --delete <branch>           # only for the "merged but remote still there" case
```

If nothing is dead, say "Nothing to clean up" and stop.

### R5. Final message

Three lines: `main` is at `<short sha>` (`<subject>`), which branches were
deleted, which were kept and why. Nothing else.
