/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The app migrations a checkout carries: apps/<slug>/migrations/*.sql.
//
// Two readers, one listing. The runner (scripts/app-migrations.ts) applies
// these files, and the build stamp (scripts/generate-project-registry.ts) tells
// the readiness probe to expect every one of them in the ledger. Each deciding
// for itself which directories and files count would let a build expect a file
// the runner never applies, which holds every deploy out of service, or the
// reverse, which lets one serve without a table it needs.
//
// Both pass the apps the registry accepted, and only those with
// `"database": true` have migrations that run. A folder the generator skipped,
// or one with no manifest, has none: its SQL never reaches the database.
//
// Library only. No imports from src/generated: the registry generator reads
// this before it has written anything.

import fs from "fs";
import path from "path";

export interface AppMigrationFiles {
  slug: string;
  /** Sorted, which is the order they are applied in. Empty when there are none. */
  files: string[];
}

/** What the listing needs to know about an app the registry accepted. */
export interface RegisteredApp {
  slug: string;
  database: boolean;
}

/** The .sql files in apps/<slug>/migrations/, sorted: the order they apply in. */
export function appMigrationFiles(appsDir: string, slug: string): string[] {
  const dir = path.join(appsDir, slug, "migrations");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/**
 * Every accepted app with `"database": true`, in slug order, with its migration
 * files. An app with a database and no migrations is listed with none: it still
 * gets its schema.
 */
export function listAppMigrations(
  appsDir: string,
  apps: readonly RegisteredApp[],
): AppMigrationFiles[] {
  return apps
    .filter((app) => app.database)
    .map((app) => app.slug)
    .sort()
    .map((slug) => ({ slug, files: appMigrationFiles(appsDir, slug) }));
}

/**
 * Accepted apps that carry migration files without declaring a database. The
 * build refuses them, and so does the release step, rather than leave SQL on
 * disk that an app expects to have run.
 */
export function undeclaredMigrations(
  appsDir: string,
  apps: readonly RegisteredApp[],
): AppMigrationFiles[] {
  return apps
    .filter((app) => !app.database)
    .map((app) => ({ slug: app.slug, files: appMigrationFiles(appsDir, app.slug) }))
    .filter((app) => app.files.length > 0)
    .sort((a, b) => a.slug.localeCompare(b.slug));
}
