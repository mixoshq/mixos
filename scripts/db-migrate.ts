/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// `npm run db:migrate` — apply the platform schema (supabase/migrations/) to
// whatever DATABASE_URL names. Any Postgres 13 or later, Supabase included.
// See scripts/platform-migrations.ts for how it records what it applied, and
// why the Supabase CLI's `db push` and this can be used interchangeably.
//
// App migrations are a separate step, `npm run migrate:apps`, because they
// depend on the app registry this build was generated with. On a deployment,
// `npm run release` (scripts/release.ts) runs both, in order.

import path from "path";
import { createPgClient } from "../src/lib/db/pg-options";
import { loadEnv } from "./load-env";
import { migratePlatform } from "./platform-migrations";

loadEnv();

async function main() {
  // One line per server notice, instead of postgres.js's default object dump.
  const sql = createPgClient({ max: 1, onnotice: (n) => console.log(`  (${n.message})`) });
  try {
    console.log("Applying the platform schema...");
    const { applied, alreadyApplied } = await migratePlatform(
      sql,
      path.resolve(__dirname, "..", "supabase", "migrations"),
    );
    console.log(
      applied.length === 0
        ? `  up to date (${alreadyApplied} migration(s) already applied)`
        : `  applied ${applied.length}, ${alreadyApplied} already applied`,
    );
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("Platform migration failed:", err);
  process.exit(1);
});
