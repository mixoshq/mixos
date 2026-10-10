/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Has the database applied every app migration this build carries?
 *
 * The platform schema answers that with a version number
 * (`./schema-version.ts`). App migrations have none: the release step applies
 * each app's files by name and records them in `public._migrations`
 * (scripts/app-migrations.ts). So the build stamps the list of files it
 * carries — `EXPECTED_APP_MIGRATIONS`, written by
 * scripts/generate-project-registry.ts from the same listing the runner uses —
 * and this compares that list with the ledger. A release step whose app
 * migrations failed, or that never ran, leaves files missing from it, and the
 * readiness probe holds the revision out of service until they are there.
 *
 * Stamped at build time rather than read from `apps/` at request time, for the
 * same reason as the schema version: whether a deployed function can see a
 * repository file depends on output tracing and on the host, and a constant
 * compiled into the server does not.
 *
 * Same direction as the schema version, too: only a database BEHIND the build
 * is refused. Ledger rows for files this build does not carry, such as an app
 * since removed, are fine.
 *
 * No imports from src/generated or the shared pool, so it can be tested
 * against any database; `appMigrationStatus()` in `./schema-version.ts` is the
 * cached wrapper the probe calls.
 */

import type { Sql } from "postgres";

export interface AppMigrationRef {
  slug: string;
  file: string;
}

export interface AppMigrationStatus {
  /** False only when the ledger provably lacks a file this build carries. */
  ok: boolean;
  /** Files this build carries that the ledger does not have. */
  pending: AppMigrationRef[];
  /** Present whenever `ok` is false, or the check could not be completed. */
  message?: string;
}

/** The expected files that are not among the applied rows. */
export function pendingAppMigrations(
  expected: readonly AppMigrationRef[],
  applied: readonly { app_slug: string; migration_file: string }[],
): AppMigrationRef[] {
  const done = new Set(applied.map((r) => `${r.app_slug}/${r.migration_file}`));
  return expected.filter((m) => !done.has(`${m.slug}/${m.file}`));
}

/** Uncached. Compare `expected` with the ledger in the database `sql` reaches. */
export async function checkAppMigrations(
  sql: Sql,
  expected: readonly AppMigrationRef[],
): Promise<AppMigrationStatus> {
  if (expected.length === 0) return { ok: true, pending: [] };

  let applied: { app_slug: string; migration_file: string }[];
  try {
    const slugs = [...new Set(expected.map((m) => m.slug))];
    applied = (await sql`
      select app_slug, migration_file
      from public._migrations
      where app_slug = any(${slugs})
    `) as unknown as { app_slug: string; migration_file: string }[];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // `42P01 undefined_table`: no ledger at all, so nothing has been applied.
    // A real answer, not an error — though the schema version check, which
    // the probe asks first, already refuses a database this far behind.
    if ((err as { code?: string })?.code === "42P01") {
      applied = [];
    } else {
      // Anything else is "cannot tell", not "behind": readiness probes
      // connectivity separately, and blaming migrations for an unreachable
      // database sends whoever is paged to the wrong place.
      return {
        ok: true,
        pending: [],
        message: `Could not read public._migrations, so app migrations were not checked against this build. ${message}`,
      };
    }
  }

  const pending = pendingAppMigrations(expected, applied);
  if (pending.length === 0) return { ok: true, pending };

  return {
    ok: false,
    pending,
    message:
      `This build carries ${pending.length} app migration(s) the database has not applied: ` +
      `${pending.map((m) => `apps/${m.slug}/migrations/${m.file}`).join(", ")}. ` +
      `Run the release step against this database before serving traffic from this revision — ` +
      `\`node ops/release.cjs\` in the image, \`npm run release\` from a checkout, or ` +
      `\`npm run migrate:apps\` against the local stack.`,
  };
}
