/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which builds use this database: `public.platform_builds_seen`
 * (supabase/migrations/0001_platform_schema.sql).
 *
 * One database is often served by more than one build. A host's rollback serves
 * an older build without running a release step, a preview can share
 * production's database, and checkouts can share a development database. Delete
 * data (src/lib/repository/delete-data.ts) must not take an extension's data
 * from a build that still carries it, and the build serving the request can't
 * speak for the others. So each build records what it carries:
 *
 *   - at its release step (scripts/record-build.ts);
 *   - when its server starts (src/instrumentation.ts);
 *   - on the cron tick (src/app/api/cron/route.ts).
 *
 * At most every ten minutes per build, unless what it carries changed, and a
 * build not seen for 30 days is pruned. Delete data counts every build seen in
 * the last 24 hours, except the caller's own.
 *
 * ── THE KEY ─────────────────────────────────────────────────────────────────
 *
 * A built deployment is `build:<commit>:<hash>`: the commit it was built from,
 * or `unknown`, and a hash of the apps and connectors it carries. Its release
 * step and its server compute the same key from the same build. A checkout is
 * `checkout:<id>`, from `.mixos/checkout-id`, a random id made the first time
 * it is needed, so a checkout keeps one key while its extensions change.
 *
 * No `@/` paths and no server modules: the release step uses this too, bundled
 * without them. The server's own build is in ./this-build.ts.
 */

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Sql, TransactionSql } from "postgres";

/** A build seen within this many hours counts as one that uses the database. */
export const RECENT_BUILD_HOURS = 24;

/** How often a build records itself while what it carries is unchanged. */
export const RECORD_EVERY_MINUTES = 10;

/** A build not seen for this many days is forgotten. */
export const KEEP_BUILDS_DAYS = 30;

/** One row of platform_builds_seen, as a build writes it. */
export interface BuildRecord {
  key: string;
  /** The app slugs it carries, sorted. */
  apps: string[];
  /** The connector names it carries, sorted. */
  connectors: string[];
}

/** What a build's key and record come from. */
export interface BuildFacts {
  /** The checkout's root. Read only for a checkout. */
  root: string;
  /** Whether this runs from a build output rather than a checkout: isBuiltDeployment(). */
  built: boolean;
  /** The commit it was built from: mixosCommit(). */
  commit: string | null;
  apps: readonly string[];
  connectors: readonly string[];
}

/** `.mixos/checkout-id` holds this and nothing else. */
const CHECKOUT_ID = /^[0-9a-f]{32}$/;

/** A `.mixos/checkout-id` that MixOS didn't write. */
export class CheckoutIdError extends Error {
  constructor() {
    super(".mixos/checkout-id isn't one MixOS wrote. Delete it, and a new one is made.");
    this.name = "CheckoutIdError";
  }
}

function sorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * This checkout's id, from `.mixos/checkout-id` under `root`, made the first
 * time it is asked for. Two processes asking at once get the same one: the
 * file is written whole under another name and linked into place, which fails
 * for the second.
 */
export function checkoutId(root: string): string {
  const dir = path.join(/* turbopackIgnore: true */ root, ".mixos");
  const file = path.join(/* turbopackIgnore: true */ dir, "checkout-id");
  const read = (): string | null => {
    try {
      return fs.readFileSync(file, "utf8").trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  };

  let id = read();
  if (id === null) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}`;
    fs.writeFileSync(tmp, `${randomBytes(16).toString("hex")}\n`, { mode: 0o644 });
    try {
      fs.linkSync(tmp, file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    id = read();
  }
  if (id === null || !CHECKOUT_ID.test(id)) throw new CheckoutIdError();
  return id;
}

/** A hash of the apps and connectors a build carries, in 16 hex characters. */
export function extensionSetHash(apps: readonly string[], connectors: readonly string[]): string {
  return createHash("sha256")
    .update(`apps:${sorted(apps).join(",")}\nconnectors:${sorted(connectors).join(",")}`)
    .digest("hex")
    .slice(0, 16);
}

/** The record a build writes. Throws CheckoutIdError, or a filesystem error, for a checkout whose id can't be read or made. */
export function buildRecord(facts: BuildFacts): BuildRecord {
  const apps = sorted(facts.apps);
  const connectors = sorted(facts.connectors);
  const key = facts.built
    ? `build:${facts.commit ?? "unknown"}:${extensionSetHash(apps, connectors)}`
    : `checkout:${checkoutId(facts.root)}`;
  return { key, apps, connectors };
}

/** A key in a few words: "a checkout", "a build of commit 3e1f0a2". */
export function describeBuildKey(key: string): string {
  if (key.startsWith("checkout:")) return "a checkout";
  const commit = /^build:([^:]+):/.exec(key)?.[1];
  if (!commit) return "a build";
  return commit === "unknown" ? "a build with no commit recorded" : `a build of commit ${commit.slice(0, 7)}`;
}

/**
 * Record `record` as seen now, unless the same build said the same less than
 * ten minutes ago. Builds not seen for 30 days are pruned when it writes. True
 * when it wrote.
 */
export async function recordBuildSeen(sql: Sql, record: BuildRecord): Promise<boolean> {
  const wrote = await sql`
    insert into public.platform_builds_seen as b (build_key, apps, connectors, last_seen_at)
    values (${record.key}, ${record.apps}, ${record.connectors}, now())
    on conflict (build_key) do update set
      apps = excluded.apps,
      connectors = excluded.connectors,
      last_seen_at = excluded.last_seen_at
    where b.last_seen_at < now() - make_interval(mins => ${RECORD_EVERY_MINUTES})
       or b.apps is distinct from excluded.apps
       or b.connectors is distinct from excluded.connectors
    returning 1 as wrote
  `;
  if (wrote.length === 0) return false;
  await sql`
    delete from public.platform_builds_seen
    where last_seen_at < now() - make_interval(days => ${KEEP_BUILDS_DAYS})
  `;
  return true;
}

/** A build that recorded itself. */
export interface SeenBuild {
  key: string;
  lastSeenAt: Date;
}

/**
 * The builds seen in the last 24 hours that carry the app or connector
 * `slug`, most recent first, leaving out `exceptKey`, the caller's own.
 */
export async function recentBuildsCarrying(
  sql: Sql | TransactionSql,
  kind: "app" | "connector",
  slug: string,
  exceptKey: string | null,
): Promise<SeenBuild[]> {
  const rows =
    kind === "app"
      ? await sql<{ build_key: string; last_seen_at: Date }[]>`
          select build_key, last_seen_at from public.platform_builds_seen
          where ${slug} = any(apps)
            and last_seen_at > now() - make_interval(hours => ${RECENT_BUILD_HOURS})
            and build_key is distinct from ${exceptKey}
          order by last_seen_at desc, build_key
        `
      : await sql<{ build_key: string; last_seen_at: Date }[]>`
          select build_key, last_seen_at from public.platform_builds_seen
          where ${slug} = any(connectors)
            and last_seen_at > now() - make_interval(hours => ${RECENT_BUILD_HOURS})
            and build_key is distinct from ${exceptKey}
          order by last_seen_at desc, build_key
        `;
  return rows.map((r) => ({ key: r.build_key, lastSeenAt: r.last_seen_at }));
}
