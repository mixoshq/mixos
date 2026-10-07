# Render

[`render.yaml`](../../render.yaml) is a Render Blueprint for the whole
deployment. It creates three things:

| Resource | What it is |
| --- | --- |
| `mixos` | A web service built from this repository's Dockerfile. Before each deploy goes live it runs the release step, `node ops/release.cjs`, as its pre-deploy command. |
| `mixos-db` | Render Postgres 17, reachable from the private network only. |
| `mixos-cron` | A cron job that sends the 5-minute scheduler tick to the web service over the private network. |

Render generates every key: `AUTH_SECRET`, `CRON_SECRET` and the six platform
keys. Each is 32 random bytes in base64, which the key check accepts alongside
hex. Render asks for the first admin's email and password when the Blueprint
is created, and the first deploy creates that account.

## Deploy

Put the button in your fork's README. It must point at your fork, which holds
your apps, not at this repository:

```markdown
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/<you>/mixos)
```

Or, in the Render dashboard: **New → Blueprint**, then pick the repository.

When the first deploy finishes, sign in at the web service's URL
(`https://mixos-xxxx.onrender.com`) with the email and password you entered.
The app takes its public URL from `RENDER_EXTERNAL_URL`, which Render sets, so
nothing else needs configuring.

**Copy the generated keys somewhere safe** (the web service's
**Environment** tab). Three of them encrypt data at rest. If the service is
deleted and recreated, the Blueprint generates new keys, and they can't decrypt
what the old ones encrypted.

## What it costs

The Blueprint uses Render's smallest paid sizes: `0.5c-512mb` for the web
service and the cron job, `0.1c-256mb` for Postgres. Paid instances are
required, not just recommended. A free instance runs no pre-deploy command, so
nothing would apply the schema. It also can't receive private network traffic,
so the tick couldn't reach it. Scale the web service up from the dashboard if
512 MB is tight for your apps.

### Trying it on the free tier

To evaluate MixOS at no cost, accepting that free web services sleep when idle
and free Postgres expires after 30 days, change `render.yaml` in your fork
before creating the Blueprint:

- Set the web service's and the database's `plan` to `free`.
- Replace `preDeployCommand` with
  `dockerCommand: sh -c "node ops/release.cjs && node server.js"`. The release
  step then runs at every start, which is safe because it is idempotent.
- Point the cron job at the public URL instead of the private network. Replace
  `http://$MIXOS_HOST:10000` with `https://<your service>.onrender.com`. To pay
  nothing at all, drop the cron job too. Scheduled jobs then won't run, but
  everything else works.

## Custom domain

Add the domain to the web service in the dashboard, then set `NEXTAUTH_URL` to
`https://your.domain`. `RENDER_EXTERNAL_URL` keeps naming the `onrender.com`
address, and OAuth redirect URIs have to match the domain people actually use.

## Upgrades

Push to the branch the service tracks. Render builds the image, runs the
release step in it, and switches traffic once `/api/health/ready` answers. If
the release step fails, the deploy fails and the previous version keeps
serving. The pre-deploy logs say why.

## Troubleshooting

- **The deploy fails at the health check.** Open the pre-deploy logs. If the
  release step didn't run, or failed, `/api/health/ready` answers 503 with
  `"reason": "schema-behind"`.
- **The release step warns that keys are missing.** A key's value was replaced
  with something that isn't 32 bytes. Restore it from your copy;
  `npm run keys:generate` makes new ones for a fresh install.
- **The cron job logs `401`.** The cron job's `CRON_SECRET` comes from the web
  service's, so this only happens if one of them was edited by hand.
- **You need `psql`.** The database's IP allow list is empty, so it is private.
  Add your address in the dashboard, connect with the external URL, then remove
  it again.
