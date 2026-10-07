/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The release step: everything a deployment does to its database before new
// code takes traffic, in the one order that works.
//
//   1. The platform schema, supabase/migrations/   (scripts/platform-migrations.ts)
//   2. The app registry mirror and app migrations  (scripts/app-migrations.ts)
//   3. The first admin, only if it does not exist  (scripts/admin-seed.ts)
//
// Step 3 runs only when INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD are both
// set, and never touches an account that already exists. Step 2 removes apps
// that are no longer in this build's registry, with their grants, installs and
// widgets — the same thing `npm run migrate:apps` does on every local boot.
//
// WHERE IT RUNS. From a checkout, `npm run release`. Inside the production
// image it is bundled to ops/release.cjs (`npm run build:ops`, run by the
// Dockerfile), because the image carries compiled output and no tsx, so the
// same step works as a Render or Railway pre-deploy command and as the
// one-shot `migrate` service in docker-compose.selfhost.yml:
//
//   node ops/release.cjs
//
// The readiness probe refuses traffic until step 1 has caught the database up
// to the schema this build expects (src/lib/platform/schema-version.ts), so a
// deploy that skips this step stays out of rotation rather than serving errors.

import path from "path";
import { createPgClient } from "../src/lib/db/pg-options";
import { missingPlatformKeys } from "../src/lib/env/keys";
import { installFlagProblems } from "../src/lib/repository/policy";
import { seedAdmin } from "./admin-seed";
import { migrateAppSchemas } from "./app-migrations";
import { loadEnv } from "./load-env";
import { migratePlatform } from "./platform-migrations";

loadEnv();

const ROOT = path.resolve(__dirname, "..");

/**
 * Configuration the app needs and this step does not. Reported rather than
 * enforced: the release step can legitimately run somewhere that holds only
 * the database URL, and the app fails closed on each missing key on its own.
 * But on a hosting platform this runs with the service's own environment, so
 * it is the earliest point a typo can be caught — before the deploy goes live.
 */
function reportMissingConfiguration(): void {
  const missing = [
    ...missingPlatformKeys().map((m) => `${m.env}: ${m.reason}`),
    ...(["AUTH_SECRET", "CRON_SECRET"] as const)
      .filter((name) => !process.env[name])
      .map((name) => `${name} is not set.`),
  ];
  if (missing.length > 0) {
    console.warn("\nThe app will not work until these are set:");
    for (const line of missing) console.warn(`  - ${line}`);
    console.warn("Generate the keys with: npm run keys:generate");
  }

  // Read as false, so the instance is more locked down than whoever typed the
  // value may have meant. Worth saying before the deploy goes live.
  const flags = installFlagProblems();
  if (flags.length > 0) {
    console.warn("\nInstall flags with values that are not true or false:");
    for (const line of flags) console.warn(`  - ${line}`);
  }
}

async function main() {
  // One line per server notice, instead of postgres.js's default object dump.
  const sql = createPgClient({ max: 1, onnotice: (n) => console.log(`  (${n.message})`) });
  try {
    console.log("Applying the platform schema...");
    const platform = await migratePlatform(sql, path.join(ROOT, "supabase", "migrations"));
    console.log(
      platform.applied.length === 0
        ? `  up to date (${platform.alreadyApplied} migration(s) already applied)`
        : `  applied ${platform.applied.length}, ${platform.alreadyApplied} already applied`,
    );

    console.log("");
    await migrateAppSchemas(sql);

    const email = process.env.INITIAL_ADMIN_EMAIL;
    const password = process.env.INITIAL_ADMIN_PASSWORD;
    if (email && password) {
      const outcome = await seedAdmin(sql, { email, password, mode: "create-only" });
      console.log(
        outcome === "created"
          ? `\nCreated the admin account ${email}.`
          : `\nAdmin account ${email} already exists; left unchanged.`,
      );
    }
  } finally {
    await sql.end();
  }

  reportMissingConfiguration();
  console.log("\nRelease step complete.");
}

main().catch((err) => {
  console.error("Release step failed:", err);
  process.exit(1);
});
