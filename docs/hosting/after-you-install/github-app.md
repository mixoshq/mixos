# The GitHub App

Admin > GitHub links an instance to the repository it's built from, through a
private GitHub App you own. With it linked, a deployment can propose extensions,
their updates and their removals as pull requests into your repository, which
you review and merge on GitHub. Nothing merges by itself, and nothing runs on
the instance until you deploy.

## Linking your GitHub repository

Admin > GitHub is off until `GITHUB_APP_ENCRYPTION_KEY` is set. Generate a value,
set it where the instance runs, and restart it:

```
npm run keys:generate -- --github-app
```

Keep a copy: the App's private key is stored encrypted under it. Link from the
deployed instance, not from a development copy.

1. **Create the App** from the page. Choose your account, or the organization
   that owns the repository. The App asks to write contents and pull requests,
   and to read checks, commit statuses and metadata. It doesn't ask for workflows
   or any webhook event.
2. **Install it** on GitHub. Choose **Only select repositories**, then the one
   repository this instance is built from.
3. **Finish linking.** The instance checks that the installation covers one
   chosen repository, and that it isn't `mixoshq/mixos` itself, then records it.

Before every operation, the instance checks the installation again. If it covers
every repository, or more than one, the link turns off. Narrow it on GitHub, then
choose **Check again**.

**Add rulesets.** The App can write to any branch, and your host deploys the
default branch, so require pull requests there. In the repository's
**Settings > Rules > Rulesets**, add:

- a branch ruleset on the default branch, with **Require a pull request before
  merging** and **Restrict deletions**;
- a tag ruleset on all tags, with **Restrict creations** and
  **Restrict updates**.

Don't put the App on either bypass list. Admin > GitHub shows whether a pull
request rule applies. It reads rulesets only, so if you use classic branch
protection, or your repository is private on GitHub Free, which has no rulesets,
confirm the protection on the page instead. Linking doesn't need the rule;
proposing changes through the App does.

**Replace the private key** by generating a new one in the App's settings on
GitHub and pasting it on the page. The instance checks it with GitHub before
storing it. Then delete the old key on GitHub.

**Unlink** uninstalls the App from GitHub, then deletes its key and the link
here. If GitHub refuses, nothing is deleted. Then delete the App in its settings
on GitHub.

**Rotating `GITHUB_APP_ENCRYPTION_KEY`.** Re-encrypt the stored key with the old
and the new key, then set the new key and restart:

```
GITHUB_APP_ENCRYPTION_KEY_OLD=<old key> GITHUB_APP_ENCRYPTION_KEY_NEW=<new key> \
  DATABASE_URL=<database> npm run keys:rotate-github-app
```

With Docker Compose, put both in the shell's environment and run
`docker compose -f deploy/docker-compose.yml run --rm -e GITHUB_APP_ENCRYPTION_KEY_OLD -e GITHUB_APP_ENCRYPTION_KEY_NEW migrate node ops/rekey-github-app.cjs`.

## Proposing an extension

With the App linked, a deployment's Browse pages show **Propose to owner/repo**
where a checkout shows Install. Proposing downloads the release, checks it
against the hash mixos.org published, and opens a pull request into your default
branch that adds the extension's folder, with its `.registry.json`, on the branch
`mixos/install/<kind>-<slug>`. Nothing runs on the instance.

Admin > GitHub shows what proposals need:

- the pull request rule on the default branch, or another protection you
  confirmed;
- **Previews elsewhere** confirmed: Render service previews, Railway PR
  environments and Coolify preview deployments off, and nothing else that builds
  the repository's branches or pull requests with secrets. The App can't read
  those settings, so it asks you. Each host page says where they are.

Before each proposal, the instance reads the default branch and refuses, naming
the file, when:

- a workflow uses `pull_request_target`;
- a workflow that runs for pull requests into the default branch, or for pushes
  to `mixos/**`, uses a secret other than `GITHUB_TOKEN`, asks for a write
  permission, sets no `permissions`, or runs on a self-hosted runner;
- `render.yaml` turns previews on;
- on Vercel, `vercel.json` doesn't turn off deployments of `mixos/**`.

A pull request from a branch in your repository gets its secrets, which is why.
To keep such a workflow, skip each of its jobs for the App's pull requests:

```yaml
jobs:
  deploy:
    if: ${{ !startsWith(github.head_ref, 'mixos/') }}
```

A `branches-ignore` on a `pull_request` trigger doesn't do it, because it filters
the target branch. MixOS's own workflows pass as they are. The instance also
refuses when the extension's folder is already on the default branch, or the
branch exists.

**Updating and removing through the App.** An extension this build installed
from mixos.org can be changed the same way. A withdrawn or newer notice offers
**Propose update**, and so does its card in Browse (**Propose a different
release** when it runs the current one); **Remove** on its tile offers **Propose
removal**. Each opens a dialog with the same checks, and for an update the update
dialog's comparison: the releases with their dates, what the one you pick changes
(the publisher's claims, what the manifest declares, new migrations, the files),
and the same explicit yes for an older or a withdrawn release. The pull request
replaces the folder on `mixos/update/<kind>-<slug>`, deleting what the new release
lacks, or deletes it on `mixos/remove/<kind>-<slug>`, `.registry.json` included.

Before either, the instance checks that the folder on your default branch is what
this build runs: its `.registry.json` records the same release, and its files are
that release, file for file. A folder someone edited on GitHub, or a default
branch that has moved to another release, is refused, naming the difference:
sort it out in a checkout, or deploy the branch first. A removal is refused while
an app in the build requires the connector or uses the app's services or hooks,
and for the last theme, as in a checkout. The data stays on each instance until
an admin deletes it there
([Deleting an extension's data](README.md#deleting-an-extensions-data)).

**Rolling back** an update or a removal once it's merged is reverting the merge
and deploying again. Neither undoes a migration the new release ran; only
restoring a backup of the database does.

**Merging is the deploy.** Your repository's CI checks the pull request: the
build runs the registry generator, and `extensions.yml` smoke-tests a changed app
([The pull-request check](README.md#the-pull-request-check)). Admin > Apps,
Connectors and Themes list the App's open pull requests with their checks:

- **No CI ran:** nothing checked the head commit within ten minutes. Check that
  GitHub Actions is on for your repository. Don't merge it unchecked.
- **Changed since proposed:** someone pushed to the branch after the App opened
  it. Read those commits before you merge.

When the merge deploys, an app arrives inactive: activate it on Admin > Apps.

## Updating MixOS through the App

When a newer release of MixOS is out and the App is linked, the release notice at
the top of the admin pages shows the commands that merge it into your
repository, as [Upgrading MixOS](upgrading.md) describes, and a link to what
changed:

```bash
git fetch upstream --tags && git merge v0.5.0
```

The App can't open that merge as a pull request on your own repository, which
doesn't have the release's commit until you merge it. A fork of
`mixoshq/mixos` shares upstream's commits, so on a fork the notice offers
**Open an update pull request** instead. It opens a pull request into your
default branch from the branch `mixos/update-<tag>`, at the release's commit,
with the release notes as text, GitHub's own numbers for the release against
your branch, and the upgrade checklist. Nothing is merged: merge it on GitHub
when its checks pass, and that's the deploy. An update pull request needs what a
proposal needs: the pull request rule and **Previews elsewhere** confirmed.

**What is verified first.** The notice knows the release's tag and commit from
mixos.org. Before anything is written, the instance asks GitHub, with a read-only
token, whether `mixoshq/mixos`'s tag is at that commit and whether the commit is
on its `main`. If either isn't so, or GitHub can't answer (it answers 404 while
`mixoshq/mixos` is private), nothing is opened: the instance
says so, records it in the audit log, and gives you the compare link on GitHub to
merge the release by hand. The same happens when the release changes a file under
`.github/workflows/`, which the App can't push because it has no workflows
permission, when the release changes more files than GitHub lists in a compare
(300), or when your default branch already has the release's commit.

**Once opened,** the notice names the pull request and offers nothing else.
Admin > GitHub lists open update pull requests with their checks, as Admin > Apps
lists proposed extensions: **No CI ran** and **Changed since proposed** mean the
same there. If you close one without merging, delete its branch on GitHub;
Admin > GitHub then offers to open another.
