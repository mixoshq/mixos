# Updating MixOS

This guide explains how to make changes to the MixOS platform itself — the core code that powers apps, connectors, and themes.

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
- **Database migrations.** New migrations in `supabase/migrations/` run in alphabetical order. Use a numbered prefix (e.g., `0010_my_change.sql`) and test against the local Docker stack (`npm run db:local`) and a plain Postgres (`npm run db:migrate`) first. Keep them portable: MixOS runs on any Postgres 13+, so a statement that names a Supabase-only role or schema (`anon`, `authenticated`, `service_role`, `auth.*`) has to be skipped where those do not exist — see the guarded grants in `0005_app_schema_columns.sql`.

  **Every new migration must bump `platform_schema_version` to its own number, as its last statement:**

  ```sql
  insert into public.platform_settings (key, value)
  values ('platform_schema_version', '10')
  on conflict (key) do update set value = excluded.value, updated_at = now();
  ```

  That row is how a running instance knows whether the database has caught up with the code. The build derives what it *expects* from the highest-numbered file in `supabase/migrations/`; `/api/health/ready` compares the two and returns 503 while the database is behind, so an orchestrator holds a new revision out of service rather than routing to an image that will fail on the first request touching a column that isn't there yet. A migration that changes the schema without bumping the row is invisible to that check — Danger fails the PR if you forget.

  The comparison is `<`, not `≠`: a database *ahead* of the image is the normal ordering (migrate, then deploy), and only the reverse is refused.
- **What app migrations may contain.** `scripts/app-sql-policy.ts` is an allowlist: every statement in an app's migrations, every node of it, has to be something it names, and every function an expression calls has to be in `ALLOWED_FUNCTIONS`. Widening it widens what any installed app can leave in the database to run as the platform's role, so a change there gets the review a change to the platform schema gets. See `docs/security-architecture.md` §3.2.
- **ESLint rules.** The `eslint.config.mjs` enforces security boundaries — apps cannot import the database client or connector modules directly. If you modify these rules, understand why they exist (see `docs/secure-edge-gateway-architecture.md`).
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
| Build identity | `src/generated/build-info.ts` (generated), `src/lib/platform/version.ts` |
| Schema gate | `src/lib/platform/schema-version.ts`, `src/lib/platform/app-migrations.ts`, `src/app/api/health/ready/route.ts` |
| Instance-wide locks | `src/lib/platform/lock.ts` |
| Database migrations | `supabase/migrations/` |
| App migrations | `scripts/app-migrations.ts` (applies them, per app schema and role), `scripts/app-sql-policy.ts` (what they may contain), `src/lib/apps/app-identifiers.ts` (schema and role names) |
| Security architecture | `docs/secure-edge-gateway-architecture.md` |
