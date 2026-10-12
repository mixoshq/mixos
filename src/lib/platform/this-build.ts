/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * This server's own build in `public.platform_builds_seen` (./builds-seen.ts):
 * its key, which Delete data leaves out of the builds it counts, and the
 * record written when the server starts and on the cron tick.
 *
 * Recording is best-effort. A server that can't reach its database, or whose
 * database is behind the build, still starts and ticks, and says why once in
 * its log. A build that never records itself is one Delete data can't see,
 * which is why the release step records it as well, and fails if it can't.
 */

import { appSlugs } from "@/generated/app-registry";
import { connectorNames } from "@/generated/connector-registry";
import { sql } from "@/lib/db/client";
import { isBuiltDeployment } from "./build";
import { buildRecord, extensionSetHash, recordBuildSeen, RECORD_EVERY_MINUTES, type BuildRecord } from "./builds-seen";
import { mixosCommit } from "./version";

// Anchored once, at module load, in the form the build's file tracer reads
// (see src/lib/repository/install.ts). Only a checkout reads under it.
const ROOT = process.cwd();

/** What this server's build carries, and its key. Throws for a checkout whose `.mixos/checkout-id` can't be read or made. */
export function thisBuild(): BuildRecord {
  return buildRecord({
    root: ROOT,
    built: isBuiltDeployment(),
    commit: mixosCommit(),
    apps: appSlugs,
    connectors: connectorNames,
  });
}

/** This server's key, or null when it has none it can tell. */
export function thisBuildKey(): string | null {
  try {
    return thisBuild().key;
  } catch {
    return null;
  }
}

// On globalThis, so a module that `next dev` loads again keeps it.
const memory = globalThis as unknown as {
  __mixosBuildSeen?: { said: string; at: number };
  __mixosBuildSeenWarned?: boolean;
};

export type BuildSeenOutcome = "recorded" | "unchanged" | "skipped" | "failed";

/**
 * Record this build as seen. `skipped` when this process said the same less
 * than ten minutes ago, `unchanged` when another did, `failed` when it
 * couldn't. Never throws.
 */
export async function recordThisBuild(now: number = Date.now()): Promise<BuildSeenOutcome> {
  try {
    const record = thisBuild();
    const said = `${record.key} ${extensionSetHash(record.apps, record.connectors)}`;
    const last = memory.__mixosBuildSeen;
    if (last?.said === said && now - last.at < RECORD_EVERY_MINUTES * 60_000) return "skipped";
    const wrote = await recordBuildSeen(sql, record);
    memory.__mixosBuildSeen = { said, at: now };
    return wrote ? "recorded" : "unchanged";
  } catch (err) {
    if (!memory.__mixosBuildSeenWarned) {
      memory.__mixosBuildSeenWarned = true;
      console.warn(
        "[builds-seen] couldn't record which apps and connectors this build carries:",
        err instanceof Error ? err.message : err,
      );
    }
    return "failed";
  }
}
