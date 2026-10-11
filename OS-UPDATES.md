# Updating MixOS

This guide explains how to make changes to the MixOS platform itself — the core code that powers apps, connectors, and themes. To upgrade a deployment to a new release of MixOS instead, see [Upgrading](docs/hosting/README.md#upgrading).

## What counts as an OS change?

Any file **outside** of `apps/`, `connectors/` and `themes/` is considered part of the OS platform. This includes:

- `src/` — core components, libraries, layouts, and pages
- `scripts/` — registry generation and build tooling
- `supabase/` — database migrations and configuration
- Root config files — `package.json`, `tsconfig.json`, `eslint.config.mjs`, `next.config.ts`, etc.
- `.github/` — CI workflows and automation
- `dangerfile.ts` — PR guardrails

`themes/` sits on the authoring side of that line along with `apps/` and
`connectors/`: a theme is content, and the platform constrains it hard enough that
it cannot reach past the token contract. Worth knowing anyway — a theme has the
**widest blast radius of the three**, because it repaints every app in the install
at once. It needs no admin review; it does deserve a careful look in both light and
dark before merge. Changing the theme *system* — the token contract, the
allowlisted `.mix-*` surfaces, the compiler in `scripts/theme-css.ts` — **is** an OS
change, exactly as changing `AppManifest` is.

## PR workflow

1. **Create a branch** for your OS changes.
2. **Open a pull request.** Danger will automatically detect that you're modifying OS files and:
   - Add the `os-change` label to the PR
   - Post a warning comment listing every OS file you touched
3. **An admin must review and approve** the PR before it can be merged. The `os-change` label signals to the team that this PR requires elevated review.
4. App, connector, and theme developers should **never** need to touch OS files. If you find yourself editing `src/` to make your app or theme work, that's a sign the platform is missing a feature — open an issue instead.

## What to consider before making OS changes

- **Backwards compatibility.** Will this break existing apps, connectors, or themes? Check how `AppManifest`, `WidgetProps`, `BaseConnector`, `AppContext`, and `ThemeManifest` are used across all apps and themes. A token removed from the contract in `src/lib/themes/tokens.ts` breaks **every** theme at once.
- **Registry generation.** If you change `AppManifest`, `ConnectorManifest`, or `ThemeManifest` types, update `scripts/generate-project-registry.ts` to match and run `npm run dev` to regenerate.
- **Database migrations.** New migrations in `supabase/migrations/` run in alphabetical order. Use the next free number as the prefix (e.g., `0011_my_change.sql` after `0010_...`) and test against the local Docker stack (`npm run db:local`) and a plain Postgres (`npm run db:migrate`) first. Keep them portable: MixOS runs on any Postgres 13+, so a statement that names a Supabase-only role or schema (`anon`, `authenticated`, `service_role`, `auth.*`) has to be skipped where those do not exist — see the guarded grants in `0005_app_schema_columns.sql`.

  **Every new migration must bump `platform_schema_version` to its own number, as its last statement:**

  ```sql
  insert into public.platform_settings (key, value)
  values ('platform_schema_version', '11')
  on conflict (key) do update set value = excluded.value, updated_at = now();
  ```

  That row is how a running instance knows whether the database has caught up with the code. The build derives what it *expects* from the highest-numbered file in `supabase/migrations/`; `/api/health/ready` compares the two and returns 503 while the database is behind, so an orchestrator holds a new revision out of service rather than routing to an image that will fail on the first request touching a column that isn't there yet. A migration that changes the schema without bumping the row is invisible to that check — Danger fails the PR if you forget.

  The comparison is `<`, not `≠`: a database *ahead* of the image is the normal ordering (migrate, then deploy), and only the reverse is refused.

  **Each number is used once.** The ledger records a migration by its number, not its file name, so of two files with one number a database would apply one and skip the other. Two branches that both took the next number merge without a git conflict, so it is refused wherever migrations are listed, naming both files and the next free number: Danger fails a PR that adds a number already on `main` (or adds one twice), the build and `npm run dev:docker` stop, and the release step and `npm run db:migrate` apply nothing. If someone else's migration took your number first, rename yours to the next free number and change its `platform_schema_version` value to match.
- **What app migrations may contain.** `scripts/app-sql-policy.ts` is an allowlist: every statement in an app's migrations, every node of it, has to be something it names, and every function an expression calls has to be in `ALLOWED_FUNCTIONS`. Widening it widens what any installed app can leave in the database to run as the platform's role, so a change there gets the review a change to the platform schema gets. See `docs/security-architecture.md` §3.2.
- **App containment.** `src/lib/apps/import-policy.mjs` is the list of what app code may import, and `scripts/app-containment.ts` holds every app to it, and to the environment, network and HTML bans, on every build and every Registry install. `eslint.config.mjs` carries the same rules as editor feedback. If you modify them, understand why they exist (see `docs/secure-edge-gateway-architecture.md` and `docs/security-architecture.md` §24).
- **Guide documentation.** If you add a new manifest field, hook, or developer-facing feature, update the relevant guide page (`src/components/apps/guide-tabs.tsx` or `src/components/connectors/connector-guide-tabs.tsx`) — or, for a theme-system change, the matching file under `docs/themes/`.

## Key files

| Area | Files |
|------|-------|
| App types & context | `src/lib/apps/types.ts`, `src/lib/apps/context.ts` |
| Widget system | `src/lib/hooks/types.ts`, `src/components/dashboard/widget-wrapper.tsx` |
| Connector types | `src/lib/connectors/types.ts` |
| Theme types & token contract | `src/lib/themes/types.ts`, `src/lib/themes/tokens.ts` |
| API gateway | `src/app/api/apps/[...slug]/route.ts` |
| Registry generation | `scripts/generate-project-registry.ts` |
| Auth & middleware | `src/lib/auth/session.ts`, `src/proxy.ts` |
| Hook system | `src/lib/hooks/hook-system.ts` |
| Build identity | `src/generated/build-info.ts` (generated: the version, from `package.json`), `src/lib/platform/version.ts` (the version, the commit and `requiresMixOS`), `src/lib/platform/build.ts` (built deployment or checkout) |
| Schema gate | `src/lib/platform/schema-version.ts`, `src/lib/platform/app-migrations.ts`, `src/app/api/health/ready/route.ts` |
| Instance-wide locks | `src/lib/platform/lock.ts` (a row every instance on the database shares), `src/lib/platform/checkout-lock.ts` (`.mixos/lock`, one checkout's) |
| Installs from the Registry | `src/lib/repository/install.ts` (install), `src/lib/repository/pending.ts` (`.mixos/pending/`), `src/lib/repository/register.ts` and `scripts/register.ts` (`npm run register`), `src/lib/repository/pending-actions.ts` and `src/components/admin/pending/` (the review, Register and Discard in Admin) |
| Database migrations | `supabase/migrations/` |
| App migrations | `scripts/app-migrations.ts` (applies them, per app schema and role), `scripts/app-sql-policy.ts` (what they may contain), `src/lib/apps/app-identifiers.ts` (schema and role names) |
| Security architecture | `docs/secure-edge-gateway-architecture.md` |
