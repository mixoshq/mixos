# Self-hosted

[`deploy/docker-compose.yml`](../../../deploy/docker-compose.yml) runs the whole
of MixOS on one machine of your own. Run it with Docker Compose directly, or let
[Coolify](#coolify) or [Dokploy](#dokploy) deploy it from git. It has four
services:

| Service | What it does |
| --- | --- |
| `db` | Postgres 17, on a named volume. Not published; nothing outside the Compose network can reach it. |
| `migrate` | The release step, `node ops/release.cjs`. Runs once per `up`, before the app, then exits. |
| `app` | The production server, from your repository's Dockerfile. Published on `127.0.0.1` only, for a proxy in front of it. |
| `cron` | The five-minute tick: `curl` against `/api/cron` with the bearer token. |

[`deploy/docker-compose.https.yml`](../../../deploy/docker-compose.https.yml)
adds Caddy on ports 80 and 443, with a Let's Encrypt certificate for your
domain. It's a separate file so that hosts with their own proxy, such as Coolify
and Dokploy, never start a second one.

Everything is configured by one file, `deploy/.env`, beside the Compose file.
It's deliberately not the repository root's `.env`, which `next dev` and the
scripts would also load.

## What you need

- **A Linux server with 2 GB of memory or more.** The image is built on the
  server, and `next build` needs the room.
- **Docker Engine with the Compose v2 plugin**, and git.
- **A domain whose DNS points at the server**, with ports 80 and 443 open.
- **Your own repository** on GitHub, with your copy of MixOS: see
  [Step 1 of How to install](../install.md#step-1-get-your-own-copy).

For Coolify or Dokploy, you need a server that already runs it.

## Docker Compose on your server

Your repository is private, so the server needs a key to read it. On the
server, run `ssh-keygen -t ed25519` and accept the defaults. Add the public key
it saves, `~/.ssh/id_ed25519.pub`, to your repository's **Settings > Deploy
keys**, with write access off. Then:

```bash
git clone git@github.com:<you>/mixos.git     # your repository, with your apps
cd mixos
sh deploy/new-env.sh https://mixos.example.com you@example.com
MIXOS_COMMIT=$(git rev-parse HEAD) docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.https.yml up -d --build
```

`deploy/new-env.sh` writes `deploy/.env` with every key generated, and prints the
first admin's password once. It needs only a POSIX shell and `openssl`, or
`/dev/urandom`, so it runs on the server itself. It refuses to overwrite an
existing `deploy/.env`, because the keys in it decrypt data already stored.

The first `up` builds the image, which takes several minutes. Then Postgres
starts, the release step applies the schema and creates your admin, the app
starts, and Caddy obtains the certificate. Sign in at your address, and change
the printed password on your account page.

`MIXOS_COMMIT` is optional. It's the commit the admin pages show beside the
MixOS version, built into the image. Leave it out and the commit shows as
unknown.

**Back up `deploy/.env`.** Three of its keys encrypt connector credentials,
per-user OAuth grants and app settings at rest. Without them, that data can't be
recovered, whatever backups of the database you have.

### Without the bundled HTTPS

Leave out the second `-f`, and put your own proxy, such as nginx, Traefik or a
load balancer, in front of `127.0.0.1:3000`. Set `MIXOS_PORT` in `deploy/.env`
if 3000 is taken. Your proxy must do what
[Securing your install](../after-you-install/securing.md#if-you-run-your-own-proxy)
lists. For a quick look on your own machine, use
`sh deploy/new-env.sh http://localhost:3000 you@example.com` and the first file
alone.

## Coolify

[Coolify](https://coolify.io) deploys the same Compose file from your
repository. It handles the domain and TLS itself, so leave out
`docker-compose.https.yml`.

1. Create a resource from your repository (public, or private through a GitHub
   App) and choose the **Docker Compose** build pack. Set the Compose file
   location to `/deploy/docker-compose.yml`.
2. Generate the environment on your own machine with
   `sh deploy/new-env.sh https://mixos.example.com you@example.com`. Paste the
   contents of `deploy/.env` into the resource's environment variables; the bulk
   editor takes the whole file at once. Coolify marks every variable the Compose
   file requires, and won't deploy until each has a value.
3. On the `app` service, set the domain to `https://mixos.example.com:3000`. The
   port is where the container listens; Coolify serves the domain on 443.
4. Deploy.

`migrate` shows as exited after a deploy, and that's expected: it's a one-shot
step that exits 0 when it's done. If Coolify counts the exit against the
deployment's health, add `exclude_from_hc: true` to the `migrate` service in
Coolify's Compose editor. Coolify reads that key, but plain `docker compose`
rejects it, which is why the shared file doesn't carry it.

If port 3000 is already taken on the server, set `MIXOS_PORT` to something free.
The loopback publish isn't how Coolify reaches the app; it only has to not
collide with anything.

To show the commit on the admin pages, set `MIXOS_COMMIT` to `$SOURCE_COMMIT` in
the resource's environment variables. Coolify leaves the source commit out of
builds by default, so also make it available during the build, in the
resource's advanced build settings.

## Dokploy

[Dokploy](https://dokploy.com) works the same way:

1. Create a **Compose** service from your repository, with the Compose path
   `./deploy/docker-compose.yml`.
2. Paste `deploy/.env`, generated as above, into the service's environment.
3. Add a domain for the `app` service, on container port 3000.
4. Deploy.

On Dokploy, the admin pages show the commit as unknown, since nothing passes
`MIXOS_COMMIT` to the build.

## The release step here

The `migrate` service is the release step. It runs once per `up`, in the image
that's about to serve, after Postgres is healthy and before the app starts, and
the app waits for it to finish successfully. It connects as the same role as the
app, and writes nothing to disk. On Coolify and Dokploy, it runs on every deploy
the same way.

## Previews

Keep **Preview Deployments** off for the Coolify resource while the
[GitHub App](../after-you-install/production-updates.md) is linked, and anything else on
your server that builds pull requests. A preview builds a pull request's code and
runs it with the resource's environment, and the App's pull requests carry a
publisher's code. The App can't read this setting, so Deployment > Production Updates asks you to
confirm it.

## Upgrading

Merge the new release into your repository and push it, as in
[Upgrading MixOS](../after-you-install/upgrading.md). Then, on the server:

```bash
git pull
MIXOS_COMMIT=$(git rev-parse HEAD) docker compose -f deploy/docker-compose.yml build
docker compose -f deploy/docker-compose.yml run --rm migrate
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.https.yml up -d
```

Run the release step on its own, against the new image, before `up`. A single
`up -d --build` also works, but Compose replaces the app container before it
knows whether `migrate` succeeded. A failed migration would then leave the app
stopped, where the separate `run` leaves the old app serving. If `run` fails,
its output says why, and nothing else has changed. The old app keeps working
against the migrated database: the schema check refuses a database that's
*behind* the code, not one that's ahead of it.

On Coolify or Dokploy, redeploy from the dashboard, or let it deploy when your
branch changes. The `migrate` step runs before the new app starts; if a deploy
fails, its log says why.

**Rolling back.** On your own server, check out the commit you ran before the
upgrade, then build and start it. `git log` shows the commit; run
`git switch main` before you next upgrade.

```bash
git checkout <the commit before the upgrade>
MIXOS_COMMIT=$(git rev-parse HEAD) docker compose -f deploy/docker-compose.yml build
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.https.yml up -d
```

On Coolify or Dokploy, use its rollback to go back to the deployment before the
upgrade.

## Backups and access

```bash
# A logical backup, to the host
docker compose -f deploy/docker-compose.yml exec -T db pg_dump -U mixos -Fc mixos > mixos-$(date +%F).dump

# Restore one into an empty database
docker compose -f deploy/docker-compose.yml exec -T db pg_restore -U mixos -d mixos --clean < mixos-2026-10-05.dump

# A psql prompt
docker compose -f deploy/docker-compose.yml exec db psql -U mixos

# Logs
docker compose -f deploy/docker-compose.yml logs -f app cron
```

The Compose file publishes no database port, and its `DATABASE_URL` exists only
inside the containers, so back up from inside them, as above. On Coolify or
Dokploy, run the `pg_dump` part from a shell in the database container.

To reset a forgotten admin password, set `INITIAL_ADMIN_EMAIL` and a new
`INITIAL_ADMIN_PASSWORD` in `deploy/.env`. Then run
`docker compose -f deploy/docker-compose.yml run --rm migrate node ops/seed-admin.cjs`.
Unlike the release step, that command does reset an existing account.

## What runs where

`docker compose -f deploy/docker-compose.yml ps -a` should show `db` and `app`
healthy, `cron` up, and `migrate` exited with code 0. Without `-a` it lists only
running containers, and `migrate` doesn't appear. `cron` logs one line per tick:

```
[cron] 2026-10-06T03:55:38Z GET /api/cron -> 200
```

## What's read-only

The server can't change its own code. The image's files are owned by root, and
the server runs as the `node` user (uid 1000). Compose also runs `app` and
`migrate` on a read-only root filesystem, so not even root inside the container
can change them.

`migrate` writes nothing. The app can write to three paths, each a `tmpfs` that
lives in memory and empties when the container restarts:

| Path | What writes there |
| --- | --- |
| `/app/.next/cache` | Next's cache of optimized images, from `/_next/image`. Next keeps it under half the mount's 256 MB. |
| `/app/.next/server/route-cache` | Next's copy of the pre-rendered 404 page, once it has served or regenerated it. |
| `/tmp` | Nothing in MixOS today. It's scratch space for libraries. |

If you add something that writes files at runtime, give its path a mount of its
own in `deploy/docker-compose.yml`: a `tmpfs` like the ones above, or a named
volume for data that must outlive the container. Either starts out owned by
root, so hand it to the server's user: add `uid=1000,gid=1000` to a `tmpfs`, or
`chown 1000:1000` a volume once. Without a mount, the write fails with
`EROFS: read-only file system`.

## Common problems

- **The cron service logs `401`.** The app and the cron service disagree about
  `CRON_SECRET`, which can't happen while both read it from `deploy/.env`.
  Check whether one was set somewhere else.
- **The cron service logs `000`.** The app isn't answering. Check
  `docker compose -f deploy/docker-compose.yml logs app`.
- **`migrate` shows as exited.** That's expected: it's a one-shot step. Its exit
  code should be 0; anything else, and its log says why.
- **Compose stops with "Set ... in deploy/.env".** A required value is missing.
  Generate the file with `deploy/new-env.sh`, or fill the value in.
- **`deploy/new-env.sh` won't run.** It refuses to overwrite an existing
  `deploy/.env`, whose keys decrypt data already stored. Edit that file by hand to
  change a value.
- **No certificate.** Caddy can only get one when the domain's DNS points at the
  server and ports 80 and 443 are open. The certificate is issued on the first
  start.
- **Port 3000 is taken.** Set `MIXOS_PORT` in `deploy/.env` to a free port.
