/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The release step's record of which apps and connectors this build carries,
// in platform_builds_seen (src/lib/platform/builds-seen.ts). Delete data on
// any instance that shares the database counts it for 24 hours.
//
// The same key the build's server records itself under: in the image and on
// Vercel, the commit and a hash of what it carries; in a checkout, its
// .mixos/checkout-id. Unlike the server's record this one isn't best-effort:
// a release step that can't record its build fails, rather than leave a build
// that Delete data can't see.
//
// Library only: scripts/release.ts and scripts/migrate.ts call it.

import path from "path";
import type { Sql } from "postgres";
import { appRegistry } from "../src/generated/app-registry";
import { connectorNames } from "../src/generated/connector-registry";
import { isBuiltDeployment } from "../src/lib/platform/build";
import { buildRecord, describeBuildKey, recordBuildSeen, type BuildRecord } from "../src/lib/platform/builds-seen";
import { mixosCommit } from "../src/lib/platform/version";

const ROOT = path.resolve(__dirname, "..");

/** This build's record: what it carries, under its key. */
export function releaseBuild(): BuildRecord {
  return buildRecord({
    root: ROOT,
    built: isBuiltDeployment(),
    commit: mixosCommit(),
    apps: appRegistry.map((a) => a.slug),
    connectors: connectorNames,
  });
}

/** Record `record` as seen, saying so in the release step's log. */
export async function recordAndReportBuild(sql: Sql, record: BuildRecord = releaseBuild()): Promise<void> {
  console.log("Recording what this build carries...");
  const wrote = await recordBuildSeen(sql, record);
  console.log(
    `  ${describeBuildKey(record.key)}: ${record.apps.length} app(s), ${record.connectors.length} connector(s)` +
      (wrote ? "" : ", as recorded in the last ten minutes"),
  );
}
