# Railway

A Railway project for MixOS has three services:

| Service | Source | What it does |
| --- | --- | --- |
| `Postgres` | Railway's PostgreSQL | The database. |
| `mixos` | Your fork of this repository | The app. [`railway.json`](../../railway.json) has Railway build the Dockerfile, run the release step (`node ops/release.cjs`) before each deploy, and wait for `/api/health/ready`. |
| `cron` | The `curlimages/curl` image | The 5-minute scheduler tick, as a Railway cron service. |

You set it up by hand once, in about five minutes. You can then publish the
project as a template, and after that it's one click for anyone.

## Setting it up

1. **Create a project** and add **PostgreSQL** to it.
2. **Add your fork** as a service, named `mixos`. Railway finds
   `railway.json` and builds the Dockerfile.
3. **Give it a domain**: the service's **Networking** settings, **Generate
   Domain**. The app takes its public URL from `RAILWAY_PUBLIC_DOMAIN`, which
   Railway sets once a domain exists.
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

   Replace each `<generated>` with the output of `openssl rand -hex 32`, or
   take the whole set from `npm run keys:generate`. `${{Postgres.DATABASE_URL}}`
   is a reference Railway resolves to the database's private connection string.
   Railway's Postgres speaks TLS on it, so leave `PGSSLMODE` unset.
5. **Add the cron service**: **New → Docker Image**, `curlimages/curl:8.21.0`,
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

**Copy the keys somewhere safe.** Three of them encrypt data at rest, and the
data can't be recovered without them.

## Publishing it as a template

A template turns those steps into one click. From the project, create a
template (Railway can generate one from an existing project), then, in the
template editor:

- Set each generated key's default to `${{secret(64, "abcdef0123456789")}}`.
  Railway evaluates that when someone deploys the template, so every deployment
  gets its own 64-hex-character keys.
- Leave `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD` empty and mark them
  required, so the person deploying is asked for them.
- Keep the `${{Postgres.DATABASE_URL}}`, `${{mixos.CRON_SECRET}}` and
  `${{mixos.RAILWAY_PUBLIC_DOMAIN}}` references as they are.

Publish it, and put the button in your fork's README:

```markdown
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/<template code>)
```

## Custom domain

Add the domain to the `mixos` service, then set `NEXTAUTH_URL=https://your.domain`
there. `RAILWAY_PUBLIC_DOMAIN` keeps naming the Railway address, and OAuth
redirect URIs have to match the domain people actually use.

## Upgrades

Push to the branch the service tracks. Railway builds the image, runs the
release step in a container of it, and only then replaces the running
deployment, waiting for `/api/health/ready`. A failed release step fails the
deploy and leaves the previous one serving.

## Troubleshooting

- **The release step can't connect, with a TLS or SSL error.** Set
  `PGSSLMODE=disable` on `mixos`. The private network doesn't leave Railway.
- **The cron service logs `401`.** Its `CRON_SECRET` should be the reference
  `${{mixos.CRON_SECRET}}`, not a copied value.
- **The cron service can't resolve the host.** `mixos` has no domain yet;
  generate one (step 3).
