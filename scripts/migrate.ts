/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// `npm run migrate:apps` — apply every app's pending migrations from
// apps/<slug>/migrations/, after mirroring the app registry into public.apps.
// The work is in scripts/app-migrations.ts. Then the release step's identity
// check for connectors and themes, with its marks for connectors this build
// lacks (scripts/sync-identities.ts), so a checkout's database catches a
// different extension under a name as a deployment's does; and the record of
// what this checkout carries (scripts/record-build.ts).
//
// The platform schema has to be in place first — `npm run db:migrate`, or on
// the local Docker stack `npm run db:local`, which `npm run dev:docker` runs for
// you. On a deployment, `npm run release` runs both in order.

import { createPgClient } from "../src/lib/db/pg-options";
import { migrateAppSchemas } from "./app-migrations";
import { loadEnv } from "./load-env";
import { recordAndReportBuild } from "./record-build";
import { syncAndReportIdentities } from "./sync-identities";

/**
 * Minimal .env loader — reads KEY=VALUE pairs from .env.local (then .env)
 * into process.env without overriding values already set in the shell.
 * Avoids taking a dotenv dependency just for the migrate script.
 */
loadEnv();

async function main() {
  const sql = createPgClient({ max: 1 });
  try {
    await migrateAppSchemas(sql);
    console.log("");
    await syncAndReportIdentities(sql);
    console.log("");
    await recordAndReportBuild(sql);
    console.log("\nApp migrations complete.");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
