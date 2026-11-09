# Render

[`render.yaml`](../../../render.yaml) is a Render Blueprint for the whole
deployment. It creates three things:

| Resource | What it is |
| --- | --- |
| `mixos` | A web service built from your repository's Dockerfile. Before each deploy goes live, it runs the release step as its pre-deploy command. |
| `mixos-db` | Render Postgres 17, reachable from the private network only. |
| `mixos-cron` | A cron job that sends the five-minute tick to the web service over the private network. |

Render generates every key: `AUTH_SECRET`, `CRON_SECRET` and the six platform
keys. Each is 32 random bytes in base64, which MixOS accepts as well as hex.

## What you need

- **Your own repository** on GitHub, with your copy of MixOS: see
  [Step 1 of How to install](../install.md#step-1-get-your-own-copy).
- **A Render account, on paid instances.** The Blueprint uses Render's smallest
  paid sizes. A free web service runs no pre-deploy command, so nothing would
  apply the schema, and can't receive private network traffic, so the tick
  couldn't reach it. [Trying it on the free tier](#trying-it-on-the-free-tier)
  has a variant for evaluating MixOS.
- **An email and a password** for your admin account. Render asks for them when
  you create the Blueprint.

## Steps

1. **Create the Blueprint.** In the Render dashboard, choose **New > Blueprint**
   and pick your repository. Or put a button in your repository's README. It
   must point at your repository, which holds your apps, not at
   `mixoshq/mixos`:

   ```markdown
   [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/<you>/mixos)
   ```

2. **Enter your admin email and password** when Render asks for them. The first
   deploy creates that account.
3. **Wait for the first deploy**, then sign in at the web service's address,
   such as `https://mixos-xxxx.onrender.com`. MixOS takes its public address from
   `RENDER_EXTERNAL_URL`, which Render sets, so nothing else needs configuring.
4. **Copy the generated keys somewhere safe**, from the web service's
   **Environment** tab. Three of them encrypt data at rest. If the service is
   deleted and created again, the Blueprint generates new keys, and they can't
   decrypt what the old ones encrypted.

## The release step on Render

The web service's `preDeployCommand` is `node ops/release.cjs`: the release
step, in the new image, before the deploy takes traffic. Its health check is
`/api/health/ready`, so Render switches traffic only once the database has
everything the new build expects. If the release step fails, the deploy fails,
and the previous version keeps serving. The pre-deploy logs say why.

## What it costs

The Blueprint uses Render's smallest paid sizes: `0.5c-512mb` for the web
service and the cron job, and `0.1c-256mb` for Postgres. Scale the web service up
from the dashboard if 512 MB is tight for your apps.

### Trying it on the free tier

To evaluate MixOS at no cost, accepting that free web services sleep when idle
and free Postgres expires after 30 days, change `render.yaml` in your
repository before creating the Blueprint:

- Set the web service's and the database's `plan` to `free`.
- Replace `preDeployCommand` with
  `dockerCommand: sh -c "node ops/release.cjs && node server.js"`. The release
  step then runs at every start, which is safe, because it can run any number of
  times.
- Point the cron job at the public address instead of the private network:
  replace `http://$MIXOS_HOST:10000` with `https://<your service>.onrender.com`.
  To pay nothing at all, drop the cron job too. Scheduled jobs then won't run,
  but everything else works.

## Custom domain

Add the domain to the web service in the dashboard, then set `NEXTAUTH_URL` to
`https://your.domain`. `RENDER_EXTERNAL_URL` keeps naming the `onrender.com`
address, and OAuth redirect addresses have to match the domain people actually
use.

## Previews

`render.yaml` turns pull request previews off for the web service, with
`previews: { generation: off }`. A preview copies the service's environment,
the database address and every key included, and runs the pull request's code
with it. The [GitHub App's](../after-you-install/github-app.md) pull requests
carry a publisher's code, so the instance refuses to propose while `render.yaml`
turns previews on, and the App's pull request titles carry `[skip preview]` as
well. If you created the service in the dashboard rather than from the
Blueprint, turn its previews off in its settings. The App can't see that
setting, so Deployment > GitHub App asks you to confirm it.

## Upgrading on Render

Merge the new release into the branch the service tracks, as in
[Upgrading MixOS](../after-you-install/upgrading.md). Render builds the image,
runs the release step in it, and switches traffic once `/api/health/ready`
answers. If the release step fails, the deploy fails and the previous version
keeps serving.

The admin pages show the MixOS version and the commit the running deploy was
built from, which Render sets as `RENDER_GIT_COMMIT`.

To roll back, go back to the deploy before the upgrade, from the service's
dashboard. The database stays as the newer deploy left it: see
[Rolling back](../after-you-install/upgrading.md#rolling-back).

For a backup before you upgrade, add your address to the database's IP allow
list, which starts empty, and run `pg_dump` against its external connection
string; remove the address afterwards.

## Common problems

- **The deploy fails at the health check.** Open the pre-deploy logs. If the
  release step didn't run, or failed, `/api/health/ready` answers 503 with
  `"reason": "schema-behind"`, or `"reason": "app-migrations-behind"` when an
  app's migrations are what's missing. The web service's log names the files.
- **The release step warns that keys are missing.** A key's value was replaced
  with something that isn't 32 bytes. Restore it from your copy;
  `npm run keys:generate` makes new ones only for a fresh install.
- **The cron job logs `401`.** The cron job's `CRON_SECRET` comes from the web
  service's, so this only happens if one of them was edited by hand.
- **You need `psql`.** The database's IP allow list is empty, so it's private.
  Add your address in the dashboard, connect with the external connection
  string, then remove the address again.
