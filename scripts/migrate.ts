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
  return sql
    // CREATE TABLE [IF NOT EXISTS] <name>
    .replace(
      /\b(create\s+table\s+(?:if\s+not\s+exists\s+)?)(\w+)/gi,
      `$1${prefix}$2`
    )
    // ALTER TABLE <name>
    .replace(/\b(alter\s+table\s+)(\w+)/gi, `$1${prefix}$2`)
    // DROP TABLE [IF EXISTS] <name>
    .replace(
      /\b(drop\s+table\s+(?:if\s+exists\s+)?)(\w+)/gi,
      `$1${prefix}$2`
    )
    // CREATE [UNIQUE] INDEX ... ON <name>
    .replace(/\b(on\s+)(\w+)(\s*\()/gi, `$1${prefix}$2$3`)
    // CREATE INDEX <name> — prefix the index name too
    .replace(
      /\b(create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?)(\w+)/gi,
      `$1${prefix}$2`
    )
    // INSERT INTO <name>
    .replace(/\b(insert\s+into\s+)(\w+)/gi, `$1${prefix}$2`)
    // UPDATE <name>
    .replace(/\b(update\s+)(\w+)(\s+set\b)/gi, `$1${prefix}$2$3`)
    // DELETE FROM <name>
    .replace(/\b(delete\s+from\s+)(\w+)/gi, `$1${prefix}$2`)
    // REFERENCES <name>
    .replace(/\b(references\s+)(\w+)(\s*\()/gi, `$1${prefix}$2$3`);
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
  appSlug: string
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
  sqlText: string
) {
  await sql.begin(async (tx) => {
    await tx.unsafe(sqlText);
    await tx`
      INSERT INTO public._migrations (app_slug, migration_file)
      VALUES (${appSlug}, ${file})
    `;
  });
}

async function migrateApps(sql: Sql) {
  if (!fs.existsSync(APPS_DIR)) return;
  const entries = fs.readdirSync(APPS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("_")) continue;

    const slug = entry.name;
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
    console.log("Applying app migrations...");
    await migrateApps(sql);
    console.log("\nApp migrations complete.");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
