/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Does the database have the schema this image expects?
 *
 * The platform's own migrations are applied out of band — `npm run db:push`
 * against a linked project, `npm run db:local` against Docker — while the code
 * that depends on them ships inside an image. Nothing connected the two, so a
 * deploy in the wrong order produced an instance that started cleanly, passed
 * its liveness probe, took traffic, and then failed on whichever request first
 * touched a column that was not there yet. The symptom is scattered 500s in
 * unrelated features; the cause is invisible from any of them.
 *
 * `supabase/migrations/0007_platform_schema_version.sql` introduces the row.
 * The image carries `EXPECTED_SCHEMA_VERSION`, derived at build time from the
 * highest-numbered file in that directory. This compares them.
 *
 * ── WHERE THIS IS ENFORCED, AND WHY NOT EARLIER ─────────────────────────────
 *
 * In the READINESS probe and, per request, in the PROXY. Not at boot.
 *
 * `instrumentation.ts`'s `register()` would be the obvious place — it runs once
 * per server instance and completes before requests are served. It is the wrong
 * place here, because it also runs where there is no database: `next build`
 * loads server modules to collect page data, and CI builds deliberately without
 * PG* credentials (see the note on the Build step in .github/workflows/ci.yml).
 * A boot check that connects would turn "the database is behind" into "the
 * build fails on a machine that was never supposed to have a database".
 *
 * Readiness is the signal an orchestrator already consults to decide whether
 * to route to a revision, so a mismatch holds the new revision out of service
 * — which is exactly the intended outcome — without being able to kill a
 * running container. The Docker HEALTHCHECK deliberately points at
 * /api/health/live, which does not consult this, so a mismatch never restarts
 * a pod in a loop.
 *
 * Not every host waits for readiness, so the proxy asks too
 * (`./maintenance.ts`): while the platform schema is behind, every request but
 * the two health probes gets the maintenance response instead of reaching a
 * route that would query it.
 *
 * ── THE COMPARISON IS `<`, NOT `!==` ────────────────────────────────────────
 *
 * A database AHEAD of the image is the normal, safe deployment ordering:
 * migrate, then deploy, and during the rollout the old image runs against the
 * new schema. Migrations in this project are additive for exactly that reason.
 * Only the reverse — code expecting a migration the database has not applied —
 * is refused.
 */

import { sql } from "@/lib/db/client";
import { EXPECTED_APP_MIGRATIONS, EXPECTED_SCHEMA_VERSION } from "@/generated/build-info";
import { checkAppMigrations, type AppMigrationStatus } from "./app-migrations";

export interface SchemaVersionStatus {
  /** False only when the database is provably behind this image. */
  ok: boolean;
  /** What this image was built against. */
  expected: number;
  /** What the database reports. Null when it could not be determined. */
  actual: number | null;
  /** Present whenever `ok` is false, or the check could not be completed. */
  message?: string;
}

/**
 * Short, because the answer changes exactly once per deployment and the probe
 * is polled every few seconds. Long enough that a probe interval does not
 * become a query rate.
 */
const CACHE_MS = 15_000;

interface CacheEntry {
  at: number;
  status: SchemaVersionStatus;
}

// On globalThis for the same reason the pool is: dev hot-reload re-evaluates
// modules, and a module-local would reset the cache on every edit.
const globalForSchema = globalThis as unknown as {
  __schemaVersionCache?: CacheEntry;
  __appMigrationCache?: { at: number; status: AppMigrationStatus };
};

/**
 * Read the applied schema version.
 *
 * A missing ROW and a missing TABLE both mean the same thing here — the
 * database has not applied migration 0007 — and both resolve to 0, which is
 * behind any image that carries this file. That is the correct answer, and it
 * is the answer on the very first deploy of this change: the operator has to
 * run the migration, which is the whole point.
 *
 * A connection failure is NOT that. It resolves to null, and the caller treats
 * null as "cannot tell" rather than "behind", because readiness already probes
 * connectivity separately and reporting a schema mismatch for what is actually
 * an unreachable database sends whoever is paged to the wrong file.
 */
async function readAppliedVersion(): Promise<{
  version: number | null;
  error?: string;
}> {
  try {
    const rows = (await sql`
      select value
      from public.platform_settings
      where key = 'platform_schema_version'
      limit 1
    `) as unknown as { value: string }[];

    if (rows.length === 0) return { version: 0 };

    const parsed = Number(rows[0].value);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return {
        version: null,
        error:
          `platform_settings.platform_schema_version is "${rows[0].value}", ` +
          `which is not a migration number.`,
      };
    }
    return { version: parsed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // `42P01 undefined_table` is a database that predates migration 0007.
    // That is a real answer — 0 — not an error.
    if (
      (err as { code?: string })?.code === "42P01" ||
      /relation .*platform_settings.* does not exist/i.test(message)
    ) {
      return { version: 0 };
    }
    return { version: null, error: message };
  }
}

/** Uncached. Use `schemaVersionStatus()` unless you specifically want a fresh read. */
export async function checkSchemaVersion(): Promise<SchemaVersionStatus> {
  const { version, error } = await readAppliedVersion();

  if (version === null) {
    return {
      ok: true,
      expected: EXPECTED_SCHEMA_VERSION,
      actual: null,
      message:
        `Could not determine the database schema version, so it was not ` +
        `checked against this build (expects ${EXPECTED_SCHEMA_VERSION}). ${error ?? ""}`.trim(),
    };
  }

  if (version < EXPECTED_SCHEMA_VERSION) {
    return {
      ok: false,
      expected: EXPECTED_SCHEMA_VERSION,
      actual: version,
      // For the server log only: readiness and the maintenance response both
      // keep the numbers out of what they send.
      message:
        `This build expects platform schema ${EXPECTED_SCHEMA_VERSION}, but the ` +
        `database is at ${version}. Run the release step against this database ` +
        `before serving traffic from this revision — \`node ops/release.cjs\` in ` +
        `the image, \`npm run release\` from a checkout, or \`npm run db:local\` ` +
        `against the local stack.`,
    };
  }

  return { ok: true, expected: EXPECTED_SCHEMA_VERSION, actual: version };
}

/** Cached for `CACHE_MS`. What the readiness probe and `./maintenance.ts` call. */
export async function schemaVersionStatus(): Promise<SchemaVersionStatus> {
  const cached = globalForSchema.__schemaVersionCache;
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.status;

  const status = await checkSchemaVersion();
  globalForSchema.__schemaVersionCache = { at: Date.now(), status };
  return status;
}

/**
 * The other half of "the schema this image expects": every app migration the
 * build carries, against the ledger the release step keeps. See
 * `./app-migrations.ts`. Cached for `CACHE_MS`, and called by the readiness
 * probe after `schemaVersionStatus()`, and by `./maintenance.ts` beside it.
 */
export async function appMigrationStatus(): Promise<AppMigrationStatus> {
  const cached = globalForSchema.__appMigrationCache;
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.status;

  const status = await checkAppMigrations(sql, EXPECTED_APP_MIGRATIONS);
  globalForSchema.__appMigrationCache = { at: Date.now(), status };
  return status;
}
