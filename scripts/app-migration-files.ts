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
// Library only. No imports from src/generated: the registry generator reads
// this before it has written anything.

import fs from "fs";
import path from "path";

export interface AppMigrationFiles {
  slug: string;
  /** Sorted, which is the order they are applied in. Empty when there are none. */
  files: string[];
}

/**
 * Every app directory, with its migration files. `_`-prefixed directories are
 * templates, not apps, and are left out — as the registry generator does.
 */
export function listAppMigrations(appsDir: string): AppMigrationFiles[] {
  if (!fs.existsSync(appsDir)) return [];
  return fs
    .readdirSync(appsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => entry.name)
    .sort()
    .map((slug) => {
      const dir = path.join(appsDir, slug, "migrations");
      const files = fs.existsSync(dir)
        ? fs
            .readdirSync(dir)
            .filter((f) => f.endsWith(".sql"))
            .sort()
        : [];
      return { slug, files };
    });
}
