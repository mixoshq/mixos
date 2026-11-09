# Railway

A Railway project for MixOS has three services:

| Service | Source | What it does |
| --- | --- | --- |
| `Postgres` | Railway's PostgreSQL | The database. |
| `mixos` | Your own repository | The app. [`railway.json`](../../../railway.json) has Railway build the Dockerfile, run the release step before each deploy, and wait for `/api/health/ready`. |
| `cron` | The `curlimages/curl` image | The five-minute tick, as a Railway cron service. |

You set it up by hand once, in about five minutes. You can then publish the
project as a template, and after that it's one click for anyone who can read
your repository.

## What you need

- **Your own repository** on GitHub, with your copy of MixOS: see
  [Step 1 of How to install](../install.md#step-1-get-your-own-copy).
- **A Railway account.**
- **The keys**, from `npm run keys:generate` in your copy, or
  `openssl rand -hex 32` for each.

## Steps

1. **Create a project** and add **PostgreSQL** to it.
2. **Add your repository** as a service, named `mixos`. Railway finds
   `railway.json` and builds the Dockerfile.
3. **Give it a domain**: in the service's **Networking** settings, choose
   **Generate Domain**. MixOS takes its public address from
   `RAILWAY_PUBLIC_DOMAIN`, which Railway sets once a domain exists.
4. **Set its variables.** In the service's raw variable editor, paste:

   ```
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   AUTH_SECRET=<generated>
   CONNECTOR_ENCRYPTION_KEY=<generated>
   USER_OAUTH_ENCRYPTION_KEY=<generated>
   APP_SETTINGS_ENCRYPTION_KEY=<generated>
   MCP_TOKEN_KEY=<generated>
   APP_API_KEY_SECRET=<generated>
   APP_UNLOCK_SECRET=<generated>
   CRON_SECRET=<generated>
   INITIAL_ADMIN_EMAIL=you@example.com
   INITIAL_ADMIN_PASSWORD=<a password>
   ```

   Replace each `<generated>` with the output of `openssl rand -hex 32`, or take
   the whole set from `npm run keys:generate`. `${{Postgres.DATABASE_URL}}` is a
   reference Railway resolves to the database's private connection string.
   Railway's Postgres speaks TLS on it, so leave `PGSSLMODE` unset.
5. **Add the cron service**: **New > Docker Image**, `curlimages/curl:8.21.0`,
   named `cron`. In its settings:
   - **Cron Schedule**: `*/5 * * * *`
   - **Custom Start Command**:

     ```
     sh -c 'curl -fsS -o /dev/null -w "%{http_code}\n" --max-time 290 -H "Authorization: Bearer $CRON_SECRET" "https://$MIXOS_HOST/api/cron"'
     ```

   - **Variables**:

     ```
     CRON_SECRET=${{mixos.CRON_SECRET}}
     MIXOS_HOST=${{mixos.RAILWAY_PUBLIC_DOMAIN}}
     ```

6. **Deploy.** The release step applies the schema and creates your admin
   account, and the app goes live once `/api/health/ready` passes. Sign in at
   the generated domain.

**Copy the keys somewhere safe.** Three of them encrypt data at rest, and that
data can't be recovered without them.

## The release step on Railway

`railway.json` sets the deploy's pre-deploy command to `node ops/release.cjs`,
and its health check to `/api/health/ready`, with up to 300 seconds to pass.
Railway runs the release step in a container of the new image, and only then
replaces the running deployment. A failed release step fails the deploy and
leaves the previous one serving.

## Publishing it as a template

A template turns those steps into one click. From the project, create a template
(Railway can generate one from an existing project), then, in the template
editor:

- Set each generated key's default to `${{secret(64, "abcdef0123456789")}}`.
  Railway evaluates that when someone deploys the template, so every deployment
  gets its own 64-hex-character keys.
- Leave `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD` empty and mark them
  required, so the person deploying is asked for them.
- Keep the `${{Postgres.DATABASE_URL}}`, `${{mixos.CRON_SECRET}}` and
  `${{mixos.RAILWAY_PUBLIC_DOMAIN}}` references as they are.

Publish it, and put the button in your repository's README:

```markdown
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/<template code>)
```

## Custom domain

Add the domain to the `mixos` service, then set
`NEXTAUTH_URL=https://your.domain` there. `RAILWAY_PUBLIC_DOMAIN` keeps naming
the Railway address, and OAuth redirect addresses have to match the domain people
actually use.

## PR environments

Keep PR environments off for this project while the
[GitHub App](../after-you-install/github-app.md) is linked: in the project's
settings, under **Environments**. A PR environment deploys a pull request's code
with copies of your variables, and the App's pull requests carry a publisher's
code. The App can't read this setting, so Deployment > GitHub App asks you to confirm it
before the first proposal.

## Upgrading on Railway

Merge the new release into the branch the service tracks, as in
[Upgrading MixOS](../after-you-install/upgrading.md). Railway builds the image,
runs the release step in a container of it, and only then replaces the running
deployment, waiting for `/api/health/ready`. A failed release step fails the
deploy and leaves the previous one serving.

The admin pages show the MixOS version and the commit the running deployment was
built from, which Railway sets as `RAILWAY_GIT_COMMIT_SHA` on deploys from
GitHub.

To roll back, go back to the deployment before the upgrade, from the service's
deployments. The database stays as the newer deployment left it: see
[Rolling back](../after-you-install/upgrading.md#rolling-back).

For a backup before you upgrade, run `pg_dump` against the Postgres service's
public connection string: its `DATABASE_URL` only works inside Railway.

## Common problems

- **The release step can't connect, with a TLS or SSL error.** Set
  `PGSSLMODE=disable` on `mixos`. The private network doesn't leave Railway.
- **The cron service logs `401`.** Its `CRON_SECRET` should be the reference
  `${{mixos.CRON_SECRET}}`, not a copied value.
- **The cron service can't resolve the host.** `mixos` has no domain yet;
  generate one (step 3).
