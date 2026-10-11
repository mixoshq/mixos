/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Makes public.apps a mirror of the generated app registry.
//
// WHY THIS EXISTS AT ALL. `public.apps` used to be a decision: an admin flipped
// a toggle and a row appeared. That decision is gone — an app in the registry
// was validated at build time, so it is valid, full stop — but the TABLE has to
// stay, because four tables hang off it by foreign key:
//
//   user_app_grants · user_apps · app_passwords · dashboard_widgets
//
// all `on delete cascade`. Those constraints are the only thing at the database
// level that stops a grant, an install, a password or a dashboard widget
// referring to an app that does not exist. Dropping the table to remove the
// toggle would have taken that guarantee with it and left nothing in its place.
//
// So the row is no longer something a person creates. It is derived state, and
// this is what derives it:
//
//   - a NEWLY seen app arrives INACTIVE: its code is present but it serves
//     nothing until an admin activates it on the Apps page. `is_active` is
//     absent from the conflict clause on purpose — a redeploy must never
//     re-decide a switch an admin has already thrown, in either direction.
//   - every app in the registry is upserted, so its name and description in the
//     database track the manifest rather than whatever they were on the day
//     someone first registered it, and its code hash (scripts/app-code-hash.ts)
//     is recorded;
//   - an app NOT in the registry is marked, never deleted: `missing_since` is set
//     by the first run without it, and everything it had stays — its
//     activation, the grants, installs, password and widgets that hang off the
//     row, and its settings, API keys, scheduled jobs and tables, which are
//     keyed by slug alone. A build that doesn't carry an app serves none of it
//     (isAppActive in src/lib/apps/access.ts);
//   - an app that COMES BACK has the mark cleared. If its files hash to what was
//     recorded before it left, it is exactly as it was. If they don't, it comes
//     back inactive and flagged (`returned_changed_at`) until an admin activates
//     it again.
//
// WHY MARK RATHER THAN DELETE. This cannot tell an app removed on purpose from
// one the registry generator skipped for a problem in it, or from a rollback to
// a build that predates it. Deleting made every one of those destroy the app's
// grants, installs and widgets, so nothing here deletes.
//
// WHY THE HASH. The delete was also what made a slug that came back arrive
// inactive with no grants. A kept row must not hand that activation, and with it
// the grants, to different code that comes back under the slug. The same files
// coming back (a rollback, a skip that ended) are the same app; anything else
// waits for an admin.
//
// Leaving and returning are audited, with the release step as the actor
// (RELEASE_STEP_ACTOR): `app.missing` and `app.returned`.
//
// One transaction under the release step's lock (scripts/migration-lock.ts), so
// the mirror and its audit rows are written whole or not at all, and two runners
// take turns.

import path from "path";
import type { Sql, TransactionSql } from "postgres";
import type { AppManifest } from "../src/lib/apps/types";
import { appRegistry as builtRegistry } from "../src/generated/app-registry";
import { RELEASE_STEP_ACTOR } from "../src/lib/apps/audit-actors";
import { appCodeHash } from "./app-code-hash";
import { takeMigrationLock } from "./migration-lock";

const APPS_DIR = path.join(path.resolve(__dirname, ".."), "apps");

/**
 * Who `admin_audit_log` says wrote the release step's rows. No person did, so
 * `actor_id` is null, and this can't be an email address, so no reader takes
 * one of these rows for an admin's. Readers label it unverified
 * (src/lib/apps/audit-actors.ts, where it is defined).
 */
export { RELEASE_STEP_ACTOR };

export interface ReturnedApp {
  slug: string;
  /** Its files differ from the hash recorded before it left. */
  codeChanged: boolean;
}

export interface AppRegistrySyncResult {
  upserted: number;
  /** Not in this build, and marked missing by this run. */
  missing: string[];
  /** Marked missing by an earlier run, and still not in this build. */
  stillMissing: string[];
  /** Missing until this run. */
  returned: ReturnedApp[];
}

/** What the mirror records of each app. */
export type MirroredApp = Pick<AppManifest, "slug" | "name" | "description" | "icon">;

interface AppRow {
  slug: string;
  is_active: boolean;
  missing_since: Date | null;
  code_hash: string | null;
}

/** One row in admin_audit_log, in the sync's own transaction. */
async function audit(
  tx: TransactionSql,
  action: "app.missing" | "app.returned",
  slug: string,
  details: Record<string, unknown>,
): Promise<void> {
  await tx`
    insert into public.admin_audit_log
      (actor_id, actor_email, action, target_type, target_id, details)
    values (null, ${RELEASE_STEP_ACTOR}, ${action}, 'app', ${slug}, ${tx.json(details as never)})
  `;
}

/**
 * `appRegistry` is this build's registry and `appsDir` where its folders are. A
 * test passes its own, the way it passes the app migration runner its own apps.
 */
export async function syncAppRegistry(
  sql: Sql,
  appRegistry: readonly MirroredApp[] = builtRegistry,
  appsDir: string = APPS_DIR,
): Promise<AppRegistrySyncResult> {
  const slugs = appRegistry.map((a) => a.slug);
  // Before the transaction: the files are this build's, and reading them has
  // no business holding the lock.
  const hashes = new Map(slugs.map((slug) => [slug, appCodeHash(path.join(appsDir, slug))]));

  return sql.begin(async (tx) => {
    await takeMigrationLock(tx);

    // Read under the lock, since a runner that went first may already have
    // marked or cleared what this one is about to.
    const rows = await tx<AppRow[]>`
      select slug, is_active, missing_since, code_hash from public.apps
    `;
    const bySlug = new Map(rows.map((r) => [r.slug, r]));

    const returned: ReturnedApp[] = [];
    for (const app of appRegistry) {
      const codeHash = hashes.get(app.slug) ?? null;
      await tx`
        insert into public.apps (slug, name, description, icon, is_active, code_hash)
        values (${app.slug}, ${app.name}, ${app.description}, ${app.icon}, false, ${codeHash})
        on conflict (slug) do update set
          name          = excluded.name,
          description   = excluded.description,
          icon          = excluded.icon,
          code_hash     = excluded.code_hash,
          missing_since = null
      `;

      const row = bySlug.get(app.slug);
      if (!row?.missing_since) continue;

      // Back after a run without it. A hash missing on either side counts as
      // changed: the safe reading of "can't tell" is the one an admin settles.
      const codeChanged = codeHash === null || row.code_hash !== codeHash;
      if (codeChanged) {
        await tx`
          update public.apps
          set is_active = false, returned_changed_at = now()
          where slug = ${app.slug}
        `;
      }
      await audit(tx, "app.returned", app.slug, {
        codeChanged,
        previousCodeHash: row.code_hash,
        codeHash,
        missingSince: row.missing_since.toISOString(),
        // True when this run switched off an app that was active when it left.
        deactivated: codeChanged && row.is_active,
      });
      returned.push({ slug: app.slug, codeChanged });
    }

    // `= any(...)` rather than `not in (...)`: an empty registry would make
    // `not in ()` a syntax error, and this has to behave sanely for a repo with
    // no apps in it rather than blowing up on the edge case. Only rows not yet
    // marked, so `missing_since` keeps the first run without the app.
    const missing = await tx<{ slug: string; is_active: boolean; code_hash: string | null }[]>`
      update public.apps
      set missing_since = now()
      where missing_since is null and not (slug = any(${slugs}))
      returning slug, is_active, code_hash
    `;
    for (const row of missing) {
      await audit(tx, "app.missing", row.slug, {
        active: row.is_active,
        codeHash: row.code_hash,
      });
    }

    const inBuild = new Set(slugs);
    return {
      upserted: appRegistry.length,
      missing: missing.map((r) => r.slug).sort(),
      stillMissing: rows
        .filter((r) => r.missing_since && !inBuild.has(r.slug))
        .map((r) => r.slug)
        .sort(),
      returned,
    };
  });
}
