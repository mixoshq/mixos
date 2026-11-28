/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The release step: everything a deployment does to its database before new
// code takes traffic, in the one order that works.
//
//   1. The platform schema, supabase/migrations/   (scripts/platform-migrations.ts)
//   2. Renamed extensions' data, to the new slugs  (scripts/sync-renames.ts)
//   3. The app registry mirror and app migrations  (scripts/app-migrations.ts)
//   4. Where each connector and theme came from    (scripts/sync-identities.ts)
//   5. What this build carries                     (scripts/record-build.ts)
//   6. The first admin, only if it does not exist  (scripts/admin-seed.ts)
//
// Step 5 runs only when INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD are both
// set, and never touches an account that already exists. Step 2 marks apps that
// are no longer in this build's registry as missing and keeps everything they
// had, brings back any that returned (switched off, if their files changed while
// they were gone; scripts/sync-app-registry.ts), switches off any that is a
// different extension than the one recorded under its slug — the same thing
// `npm run migrate:apps` does on every local boot — and runs each app's
// migrations as that app's own role, in its own schema, once every pending
// statement has passed scripts/app-sql-policy.ts. Step 3 does the identity
// check for connectors, turning off one that is a different connector than
// the one recorded under its name, and records themes. It also marks each
// connector the database holds credentials for that this build lacks, and
// clears the mark when one returns. Step 4 records the apps and connectors
// this build carries, which Delete data on every instance sharing the
// database counts (src/lib/platform/builds-seen.ts).
//
// Each step takes the same lock and re-reads what it is about to change once it
// holds it (scripts/migration-lock.ts), so two release steps at once — two
// instances booting, a deploy overlapping a manual run — take turns and both
// succeed.
//
// WHERE IT RUNS. From a checkout, `npm run release`. In a Vercel production
// build, once `next build` has succeeded (scripts/vercel-release.ts). Inside
// the production image it is bundled to ops/release.cjs (`npm run build:ops`,
// run by the Dockerfile), because the image carries compiled output and no
// tsx, so the same step works as a Render or Railway pre-deploy command and as
// the one-shot `migrate` service in deploy/docker-compose.yml. The SQL parser
// that checks app migrations loads ops/libpg-query.wasm from beside the bundle,
// which `build:ops` copies there:
//
//   node ops/release.cjs
//
// WHAT IT READS. The environment it is started with, and nothing else — not
// scripts/load-env.ts, not any .env file. Those files describe a development
// database, and a development checkout is exactly where someone types
// `DATABASE_URL='<production>' npm run release`. Filling in whatever the shell
// left out from them would pair production's URL with development's
// PGSSLMODE=disable and INITIAL_ADMIN_* (the committed local login, from
// .env.docker). So a run whose environment names no database stops, rather
// than finding one in a file.
//
// The readiness probe refuses traffic until steps 1 and 2 have caught the
// database up to this build — its platform schema version
// (src/lib/platform/schema-version.ts) and every app migration it carries
// (src/lib/platform/app-migrations.ts) — so on a host that waits for it, a
// deploy that skips or fails this step stays out of rotation rather than
// serving errors.

import path from "path";
import { createPgClient, databaseNamed } from "../src/lib/db/pg-options";
import {
  malformedOptionalKeys,
  missingDeploymentSecrets,
  missingPlatformKeys,
} from "../src/lib/env/keys";
import { flagProblems, releaseChannelProblem } from "../src/lib/repository/policy";
import { connectorTelemetryProblem } from "../src/lib/apps/telemetry-retention";
import { seedAdmin } from "./admin-seed";
import { migrateAppSchemas } from "./app-migrations";
import { migratePlatform } from "./platform-migrations";
import { recordAndReportBuild } from "./record-build";
import { syncAndReportIdentities } from "./sync-identities";
import { syncAndReportRenames } from "./sync-renames";

const ROOT = path.resolve(__dirname, "..");

/**
 * Configuration the app needs and this step does not. Reported rather than
 * enforced: the release step can legitimately run somewhere that holds only
 * the database URL — a laptop running it for Vercel — and the app fails closed
 * on each missing key on its own. But on a hosting platform this runs with the
 * service's own environment, so it is the earliest point a typo can be caught —
 * before the deploy goes live.
 */
function reportMissingConfiguration(): void {
  const missing = [...missingDeploymentSecrets(), ...missingPlatformKeys()].map(
    (m) => `${m.env}: ${m.reason}`,
  );
  if (missing.length > 0) {
    console.warn("\nNot set here. The app needs each one wherever it runs:");
    for (const line of missing) console.warn(`  - ${line}`);
    console.warn("Generate the keys with: npm run keys:generate");
  }

  // An optional key turns its feature off while unset, which needs no word.
  // Set but not 32 bytes, the feature stays off too, which someone setting it
  // didn't mean, so say so now.
  const malformed = malformedOptionalKeys();
  if (malformed.length > 0) {
    console.warn("\nSet, but not a key:");
    for (const m of malformed) console.warn(`  - ${m.env}: ${m.reason}`);
  }

  // Read as false, so the instance is more locked down than whoever typed the
  // value may have meant: installs off, or update checks off. Worth saying
  // before the deploy goes live.
  const flags = flagProblems();
  if (flags.length > 0) {
    console.warn("\nSwitches with values that are not true or false:");
    for (const line of flags) console.warn(`  - ${line}`);
  }

  // Read as stable, so admins hear about fewer releases than whoever typed it meant.
  const channel = releaseChannelProblem();
  if (channel) {
    console.warn("\nA release channel that is not stable or prerelease:");
    console.warn(`  - ${channel}`);
  }

  // Raised to 90 days, or nothing deleted until it can be read: either way not
  // what whoever typed it meant.
  const retention = connectorTelemetryProblem();
  if (retention) {
    console.warn("\nHow long connector calls are kept:");
    console.warn(`  - ${retention}`);
  }
}

async function main() {
  if (!databaseNamed()) {
    console.error(
      "No database to release to: DATABASE_URL is not set.\n" +
        "The release step reads only its own environment, never a .env file in the checkout, " +
        "so name the database in the command:\n\n" +
        "  DATABASE_URL='<connection string>' npm run release",
    );
    process.exit(1);
  }

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
    await syncAndReportRenames(sql);

    console.log("");
    await migrateAppSchemas(sql);

    console.log("");
    await syncAndReportIdentities(sql);

    console.log("");
    await recordAndReportBuild(sql);

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
