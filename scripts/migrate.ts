/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Applies per-app migrations from apps/<slug>/migrations/.
//
// Scope note: this runner handles APP migrations only. The platform's own
// schema lives in supabase/migrations/ and is applied separately — with
// `npm run db:local` against the local Docker stack (which `npm run dev:docker`
// does for you), or `npm run db:push` against a linked hosted project. This
// script no longer touches it.
//
// App tables are automatically prefixed `_app_<slug>_` so one app can never
// read or write another's data, and applied files are recorded in
// public._migrations so each runs exactly once. See docs/apps/database.md.

import fs from "fs";
import path from "path";
import { type Sql } from "postgres";
import { createPgClient } from "../src/lib/db/pg-options";
import { syncAppRegistry } from "./sync-app-registry";
import { loadEnv } from "./load-env";

const ROOT = path.resolve(__dirname, "..");
const APPS_DIR = path.join(ROOT, "apps");

/**
 * Minimal .env loader — reads KEY=VALUE pairs from .env.local (then .env)
 * into process.env without overriding values already set in the shell.
 * Avoids taking a dotenv dependency just for the migrate script.
 */
loadEnv();

/**
 * Prefixes bare table names in SQL with the app-scoped prefix.
 * Matches CREATE TABLE, ALTER TABLE, DROP TABLE, INSERT INTO,
 * UPDATE, DELETE FROM, CREATE INDEX ... ON, and REFERENCES.
 */
function addTablePrefix(sql: string, prefix: string): string {
  return (
    sql
      // CREATE TABLE [IF NOT EXISTS] <name>
      .replace(
        /\b(create\s+table\s+(?:if\s+not\s+exists\s+)?)(\w+)/gi,
        `$1${prefix}$2`,
      )
      // ALTER TABLE <name>
      .replace(/\b(alter\s+table\s+)(\w+)/gi, `$1${prefix}$2`)
      // DROP TABLE [IF EXISTS] <name>
      .replace(/\b(drop\s+table\s+(?:if\s+exists\s+)?)(\w+)/gi, `$1${prefix}$2`)
      // CREATE [UNIQUE] INDEX ... ON <name>
      .replace(/\b(on\s+)(\w+)(\s*\()/gi, `$1${prefix}$2$3`)
      // CREATE INDEX <name> — prefix the index name too
      .replace(
        /\b(create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?)(\w+)/gi,
        `$1${prefix}$2`,
      )
      // INSERT INTO <name>
      .replace(/\b(insert\s+into\s+)(\w+)/gi, `$1${prefix}$2`)
      // UPDATE <name>
      .replace(/\b(update\s+)(\w+)(\s+set\b)/gi, `$1${prefix}$2$3`)
      // DELETE FROM <name>
      .replace(/\b(delete\s+from\s+)(\w+)/gi, `$1${prefix}$2`)
      // REFERENCES <name>
      .replace(/\b(references\s+)(\w+)(\s*\()/gi, `$1${prefix}$2$3`)
  );
}

/**
 * Return the set of migration files already applied for the given app slug.
 * `_migrations` is created by the platform schema (supabase/migrations/
 * 0001_initial.sql). SQLSTATE `42P01` (undefined_table) therefore means the
 * platform schema has not been pushed yet, which is a setup error worth
 * reporting rather than swallowing.
 */
async function getAppliedMigrations(
  sql: Sql,
  appSlug: string,
): Promise<Set<string>> {
  try {
    const rows = await sql<{ migration_file: string }[]>`
      SELECT migration_file
      FROM public._migrations
      WHERE app_slug = ${appSlug}
    `;
    return new Set(rows.map((r) => r.migration_file));
  } catch (err) {
    const e = err as { code?: string };
    if (e?.code === "42P01") {
      throw new Error(
        "public._migrations does not exist. Apply the platform schema first: " +
          "`npm run db:local` for the local Docker stack (or just re-run " +
          "`npm run dev:docker`), or `npm run db:push` against a linked " +
          "hosted project.",
      );
    }
    throw err;
  }
}

/**
 * Apply one migration file transactionally: the DDL and the ledger INSERT
 * commit together, so a partial apply rolls back cleanly.
 */
async function applyMigration(
  sql: Sql,
  appSlug: string,
  file: string,
  sqlText: string,
) {
  await sql.begin(async (tx) => {
    await tx.unsafe(sqlText);
    await tx`
      INSERT INTO public._migrations (app_slug, migration_file)
      VALUES (${appSlug}, ${file})
    `;
  });
}

/**
 * Create the platform-owned `_sync_state` table for any app declaring a `sync`.
 *
 * Watermark, window size and last status are the platform's bookkeeping, not the
 * app's — `runSync` is the only writer, and `docs/apps/data-freshness.md` lists
 * "persisting a provider cursor in your state table" as the single most
 * expensive mistake in this codebase. There is deliberately no cursor column: a
 * cursor lives inside one run and there is nowhere here to put it.
 */
async function ensureSyncState(sql: Sql, slug: string): Promise<void> {
  const manifestPath = path.join(APPS_DIR, slug, "app.json");
  if (!fs.existsSync(manifestPath)) return;
  let declaresSync = false;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as {
      sync?: unknown[];
    };
    declaresSync = Array.isArray(manifest.sync) && manifest.sync.length > 0;
  } catch {
    return;
  }
  if (!declaresSync) return;

  const table = `_app_${slug.replace(/-/g, "_")}__sync_state`;
  await sql.unsafe(`
    create table if not exists public."${table}" (
      name           text primary key,
      synced_through timestamptz,
      window_days    int,
      last_status    text,
      last_run_at    timestamptz
    )
  `);
  await sql.unsafe(`alter table public."${table}" enable row level security`);
  console.log(`  ${slug}: sync state ready`);
}

/**
 * Enable RLS on every table in `public` that lacks it, and report what changed.
 *
 * The platform schema states the rule in its own header: RLS on, zero policies,
 * because Supabase publishes `public` through PostgREST to the `anon` role and
 * the anon key is publishable rather than secret. A table with RLS off is
 * readable by anyone holding it.
 *
 * App tables were never covered. `applyMigration` runs an app's own SQL with the
 * table names rewritten, so whatever `create table` it contains lands in
 * `public` exactly as written — with no RLS. `_app_<slug>_*` tables have been
 * reachable through PostgREST for as long as apps have had migrations. The only
 * `enable row level security` this script used to emit was for `__sync_state`,
 * which the platform creates itself.
 *
 * Sweeping the catalog rather than tracking names is deliberate: the platform
 * schema tried the hand-kept list and the list is what rotted. Idempotent, so
 * running migrations twice hardens nothing the second time.
 */
async function hardenRowLevelSecurity(sql: Sql) {
  const rows = await sql<{ relname: string }[]>`
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and not c.relrowsecurity
      and not exists (
        select 1
        from pg_depend d
        where d.objid = c.oid
          and d.deptype = 'e'
      )
    order by c.relname
  `;

  for (const { relname } of rows) {
    await sql.unsafe(
      `alter table public."${relname}" enable row level security`,
    );
    console.log(`  RLS enabled: ${relname}`);
  }

  return rows.length;
}

async function migrateApps(sql: Sql) {
  if (!fs.existsSync(APPS_DIR)) return;
  const entries = fs.readdirSync(APPS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("_")) continue;

    const slug = entry.name;

    // The platform owns the sync watermark table, so an app that declares a
    // `sync` never writes a migration for it — and never gets the chance to
    // shape it wrongly. Created before the app's own migrations so one of them
    // could reference it.
    await ensureSyncState(sql, slug);

    const migrationsDir = path.join(APPS_DIR, slug, "migrations");
    if (!fs.existsSync(migrationsDir)) continue;

    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    if (files.length === 0) continue;

    const applied = await getAppliedMigrations(sql, slug);

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`  ${slug}/${file}: already applied`);
        continue;
      }
      const raw = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
      const prefix = `_app_${slug.replace(/-/g, "_")}_`;
      const sqlText = addTablePrefix(raw, prefix);
      console.log(`  ${slug}/${file}: applying...`);
      await applyMigration(sql, slug, file, sqlText);
      console.log(`  ${slug}/${file}: applied`);
    }
  }
}

async function main() {
  const sql = createPgClient({ max: 1 });
  try {
    // Before the per-app SQL, because an app's own migration may insert seed
    // rows into a table that references public.apps — and the parent row has to
    // exist by then.
    console.log("Syncing the app registry into public.apps...");
    const sync = await syncAppRegistry(sql);
    console.log(`  ${sync.upserted} app(s) in the registry`);
    for (const slug of sync.removed) {
      // Loud, because the cascade behind this line deletes that app's grants,
      // installs, password and dashboard widgets.
      console.log(
        `  ${slug}: no longer in the registry — removed, along with its grants, installs, password and widgets`,
      );
    }

    console.log("\nApplying app migrations...");
    await migrateApps(sql);

    // After the app SQL, never before: a table created by this run has to be
    // hardened by this run. See hardenRowLevelSecurity for why it sweeps.
    console.log("\nChecking row-level security...");
    const hardened = await hardenRowLevelSecurity(sql);
    console.log(
      hardened === 0
        ? "  all tables already protected"
        : `  hardened ${hardened} table(s)`,
    );

    console.log("\nApp migrations complete.");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
