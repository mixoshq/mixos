# Upgrading MixOS

Upgrading means merging a new release of MixOS into your repository and
deploying it. Your apps, connectors and themes come along, because they live in
the same repository. How smooth it is depends mostly on whether you changed
anything under `src/`.

Each version of MixOS is a release: an annotated tag on `mixoshq/mixos`'s `main`,
such as `v0.2.0`, listed on the
[releases page](https://github.com/mixoshq/mixos/releases) and on
[mixos.org](https://mixos.org/docs/releases), with notes that put breaking
changes first. Upgrade by merging the newest release's tag. Don't merge
`upstream/main`: between releases it holds work that hasn't been released yet.

## When a new release is out

Each instance asks mixos.org once a day which releases of MixOS exist. When a
newer one is out, the top of every admin page says so, such
as: "MixOS 0.5.0 is available (this instance runs 0.4.2). A minor release: it may
need changes." The notice links to the release's page on mixos.org and to this
guide, and its notes are folded under it. Nothing is applied for you. The check
sends nothing about the instance; see
[New releases of MixOS](README.md#new-releases-of-mixos) for what it does, and how
to turn it off.

With the [GitHub App](github-app.md) linked, the notice also shows the commands
for step 2; see [Through the GitHub App](#through-the-github-app).

## Upgrade in five steps

1. **Back up the database**, before anything else. Migrations only go forward,
   so a backup is the way back if something goes wrong.

   ```bash
   pg_dump "$DATABASE_URL" -Fc -f pre-upgrade.dump
   ```

   Each host reaches its database its own way: on Render, add your address to
   the database's IP allow list, which starts empty, and use its external
   connection string; on Railway, use the Postgres service's public connection
   string, since its `DATABASE_URL` only works inside Railway; with Docker
   Compose, dump from inside the container, as in
   [Backups and access](../providers/self-hosted.md#backups-and-access).

2. **Merge the release, on a branch.** Your copy takes MixOS's releases from
   `upstream`, which `/mixos init` sets up. If `git remote get-url upstream`
   finds none, add it once:
   `git remote add upstream https://github.com/mixoshq/mixos.git`. Then:

   ```bash
   git fetch upstream --tags
   git describe --abbrev=0 --exclude '*-*' upstream/main   # the newest release, such as v0.2.0
   git switch -c upgrade-v0.2.0
   git merge --no-edit v0.2.0
   ```

   Then read the release's notes against your apps, breaking changes first.

3. **Try it on your computer first**, in your
   [development copy](../development.md). Starting it applies the new
   migrations to your local database, so problems show up there rather than in
   production. To prove the migrations also apply to an empty database, run
   `npm run docker:reset` first: it deletes the local database.

   ```bash
   npm ci && npm run dev:docker
   ```

4. **Check it builds.**

   ```bash
   npm run build && npm run typecheck
   ```

5. **Push the branch, and merge it** into `main` through a pull request on your
   own repository, not `mixoshq/mixos`. Merging deploys it, and every
   host runs the release step, which applies the new migrations before the new
   version takes over. When it's done, the admin pages show the new version and
   its commit ([Which build is running](README.md#which-build-is-running)).

Skipping releases is fine. Merge the newest tag, and the release step applies
every migration in between; read the notes of each release you skipped.
Prereleases, tags with a suffix such as `v0.3.0-rc.1`, are for trying a version
before it's final, and `--exclude '*-*'` leaves them out.

## On each host

What happens once the merge lands depends on the host:

- **Vercel**: the production build runs the release step once the code has
  built, before the new deployment takes traffic. If it fails, the build fails,
  and the previous deployment keeps serving. See
  [Upgrading on Vercel](../providers/vercel-supabase.md#upgrading-on-vercel).
- **Render** and **Railway**: the release step runs in the new image first, and
  the host switches over only once it has succeeded. See
  [Render](../providers/render.md#upgrading-on-render) and
  [Railway](../providers/railway.md#upgrading-on-railway).
- **Docker Compose** on your own server: nothing changes until you pull, build,
  run the release step and start the new version there. **Coolify** and
  **Dokploy** redeploy from the dashboard, or when the branch changes. See
  [Upgrading](../providers/self-hosted.md#upgrading).

Wherever the release step fails, the old version keeps serving while you fix it.

## Through the GitHub App

With the [GitHub App](github-app.md) linked, the release notice shows the
commands for step 2 and a link to what changed. The steps are yours, as above.
Only on a fork of `mixoshq/mixos`, which shares upstream's commits, can the
notice do steps 2 and 5 for you, by opening the pull request at the release's
commit. See
[Updating MixOS through the App](github-app.md#updating-mixos-through-the-app).

## What breaks

If something goes wrong, it's usually one of these, in the order you'll meet
them:

- **`npm ci` fails.** The lockfile moved and your copy disagrees. Resolve the
  conflict in `package-lock.json` by taking the release's version and running it
  again, rather than editing it by hand.
- **The registry generator fails.** This is the helpful failure. Every
  `app.json`, `connector.json` and `theme.json` is checked against its schema, so
  a field that was removed or tightened stops the build with a message naming the
  file.
- **An app is left out of the build.** The registry generator prints
  `Skipping <app>/` with the reason, such as an import apps may no longer make.
  The rest of the build goes on, and the release step keeps the app's data until
  it's back.
- **A lint rule you've never seen is now an error.** Most platform guarantees are
  lint rules, and new guarantees bring new ones. The message names the rule and
  the reason; read it before working around it.
- **Contrast fails on a theme that passed before.** A change to what's checked
  can surface a colour pair that was always marginal. See
  [Contrast](../../themes/contrast.md).
- **Type errors in your apps.** `context` gained or changed a field. These are
  usually mechanical.
- **The release step fails.** Its output says which migration, and why. Every
  statement in an app's migrations is checked before any of them runs, so one an
  app migration may not contain stops the step with its file and line: see
  [What a migration may contain](../../apps/database.md#what-a-migration-may-contain).
  The old version keeps serving while you fix it.

## Rolling back

**Code only:** go back to the version before the upgrade and deploy it again.
Each host page says how: [Vercel](../providers/vercel-supabase.md#rolling-back),
[Render](../providers/render.md#upgrading-on-render),
[Railway](../providers/railway.md#upgrading-on-railway) and
[your own server](../providers/self-hosted.md#upgrading). The earlier version
runs against the upgraded database, because MixOS refuses a database that's
behind its code, not one that's ahead of it. Whether it works fully depends on
what the migrations changed. An app it doesn't include keeps its data, and
returns as it was when you upgrade again.

**Code and database:** do that, then restore the backup from step 1:

```bash
pg_restore --clean -d "$DATABASE_URL" pre-upgrade.dump
```

On Render and Railway, reach the database the same way as for the backup. With
Docker Compose, restore inside the container:

```bash
docker compose -f deploy/docker-compose.yml exec -T db \
  pg_restore -U mixos -d mixos --clean < pre-upgrade.dump
```

There are no down migrations, so a migrated database can't be un-migrated in
place: the backup is the only way back, which is why it comes first.

- **Restore with the same keys still set.** Connector credentials, per-user
  OAuth grants and `password`-typed app settings are stored encrypted. A restore
  is only complete if `CONNECTOR_ENCRYPTION_KEY`, `USER_OAUTH_ENCRYPTION_KEY` and
  `APP_SETTINGS_ENCRYPTION_KEY` are unchanged; change one and restore an older
  dump, and those rows can't be read.
- **Keep owners and privileges**, in both the backup and the restore: don't add
  `--no-owner` or `--no-privileges`. Each app's schema belongs to a database role
  of its own, and the release step refuses to run an app's migrations in a schema
  that belongs to anyone else. Who may run some of MixOS's database functions is
  set by privileges, too.

## Extensions and versions

Extensions in your copy move with MixOS: they're in the same repository, and the
build tells you if they disagree.

An extension installed from the Registry can name the oldest MixOS it runs on.
Install and Register compare it with your copy's version, the one in
`package.json` that each release sets, and refuse an extension that needs a newer
MixOS than yours: upgrade first. The build checks it again, from each extension's
`.registry.json`, and stops rather than leave an extension out of a deploy; see
[When an extension needs a newer MixOS](README.md#when-an-extension-needs-a-newer-mixos).
Upgrading never trips that check, since every floor an older MixOS meets, a newer
one meets too.
