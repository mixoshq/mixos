/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Makes public.apps a mirror of the generated app registry.
//
// WHY THIS EXISTS AT ALL. An app in the registry was validated at build time,
// so it is valid, full stop, and no person decides that a row exists. The TABLE
// stays all the same, because four tables hang off it by foreign key:
//
//   user_app_grants · user_apps · app_passwords · dashboard_widgets
//
// all `on delete cascade`. Those constraints are the only thing at the database
// level that stops a grant, an install, a password or a dashboard widget
// referring to an app that does not exist. Without the table, nothing would
// take that guarantee's place.
//
// So the row is not something a person creates. It is derived state, and this
// is what derives it:
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
// a build that predates it. Deleting would make every one of those destroy the
// app's grants, installs and widgets, so nothing here deletes.
//
// WHY THE HASH. A kept row must not hand its activation, and with it the grants,
// to different code that comes back under the slug. The same files
// coming back (a rollback, a skip that ended) are the same app; anything else
// waits for an admin.
//
// SAME SLUG, DIFFERENT EXTENSION. Every run also records each app's identity
// (src/lib/repository/identity.ts): where it came from, by its install record,
// or `local`. A new version or commit from the same repository is the same
// app, so an update changes nothing here. Any other change, at any release
// step and not only when an app returns, means a different extension now has
// the slug: a local app reinstalled from the Registry, one from another
// repository, or an installed one whose record was deleted. That one is
// switched off and flagged (`identity_changed_at`), its API keys are revoked
// and its MCP tool switches deleted, since both were given out for the
// extension before it: a tool the new one declares under an old name starts
// off, like any other. Activating it again needs its slug typed
// (setAppActive() in src/lib/apps/access.ts). When it is also an app coming
// back with different files, this flag is the one it gets: it says more, and
// asks more of the admin.
//
// A ROLE IS NEVER ACCESS. A `user_app_grants` row records a grant, a role on
// a global app, or both, and `role_only` says which (src/lib/apps/grant-rule.ts).
// A grant stays a grant whether or not the app is global. Each run records
// whether each app is global, so the run after an app stops being global can
// tell: whoever had it, by an install or a role, and has no grant has lost it,
// and `needs_grants_since` puts that in front of the admin until an admin
// grants the app to someone, or it is global again.
//
// Leaving, returning, a change of identity and an app that stopped being
// global are audited, with the release step as the actor
// (RELEASE_STEP_ACTOR): `app.missing`, `app.returned`, `app.identity.changed`
// and `app.global.ended`.
//
// One transaction under the release step's lock (scripts/migration-lock.ts), so
// the mirror and its audit rows are written whole or not at all, and two runners
// take turns.

import path from "path";
import type { Sql, TransactionSql } from "postgres";
import type { AppManifest } from "../src/lib/apps/types";
import { appRegistry as builtRegistry } from "../src/generated/app-registry";
import { registryInstalls as builtInstalls } from "../src/generated/registry-installs";
import { RELEASE_STEP_ACTOR } from "../src/lib/apps/audit-actors";
import { IS_GRANT_SQL } from "../src/lib/apps/grant-rule";
import { extensionIdentity, identityDetails } from "../src/lib/repository/identity";
import type { RegistryInstall } from "../src/lib/repository/install-record";
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
  /** It came back as a different extension, so it is in `replaced` too. */
  identityChanged: boolean;
}

export interface ReplacedApp {
  slug: string;
  /** The identity recorded before this run. */
  previous: string;
  /** This build's. */
  identity: string;
  /** True when this run switched off an app that was active. */
  deactivated: boolean;
  /** How many of its API keys this run revoked. */
  apiKeysRevoked: number;
  /** How many of its MCP tool switches this run deleted. */
  mcpToolSwitchesReset: number;
}

/** An app this run found had stopped being global. */
export interface GlobalEndedApp {
  slug: string;
  /** How many people have a role in it and, now, no access. */
  roleOnly: number;
  /**
   * How many people who had it, with an install or a role, have no grant: the
   * people who lost it. Only when there are any does the app need grants.
   */
  lost: number;
}

export interface AppRegistrySyncResult {
  upserted: number;
  /** Not in this build, and marked missing by this run. */
  missing: string[];
  /** Marked missing by an earlier run, and still not in this build. */
  stillMissing: string[];
  /** Missing until this run. */
  returned: ReturnedApp[];
  /** A different extension than the one recorded under the slug. */
  replaced: ReplacedApp[];
  /** Apps that stopped being global. */
  globalEnded: GlobalEndedApp[];
}

/**
 * What the mirror records of each app. `global` is optional for a caller that
 * doesn't know it; the release step always passes the registry's.
 */
export type MirroredApp = Pick<AppManifest, "slug" | "name" | "description" | "icon"> & {
  global?: boolean;
};

interface AppRow {
  slug: string;
  is_active: boolean;
  missing_since: Date | null;
  code_hash: string | null;
  identity: string | null;
  global: boolean | null;
}

/** One row in admin_audit_log, in the sync's own transaction. */
async function audit(
  tx: TransactionSql,
  action: "app.missing" | "app.returned" | "app.identity.changed" | "app.global.ended",
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
 * `appRegistry` is this build's registry, `appsDir` where its folders are, and
 * `installs` what it installed from a Registry. A test passes its own, the way
 * it passes the app migration runner its own apps.
 */
export async function syncAppRegistry(
  sql: Sql,
  appRegistry: readonly MirroredApp[] = builtRegistry,
  appsDir: string = APPS_DIR,
  installs: readonly RegistryInstall[] = builtInstalls,
): Promise<AppRegistrySyncResult> {
  const slugs = appRegistry.map((a) => a.slug);
  // Before the transaction: the files are this build's, and reading them has
  // no business holding the lock.
  const hashes = new Map(slugs.map((slug) => [slug, appCodeHash(path.join(appsDir, slug))]));
  const identities = new Map(slugs.map((slug) => [slug, extensionIdentity("app", slug, installs)]));

  return sql.begin(async (tx) => {
    await takeMigrationLock(tx);

    // Read under the lock, since a runner that went first may already have
    // marked or cleared what this one is about to.
    const rows = await tx<AppRow[]>`
      select slug, is_active, missing_since, code_hash, identity, global from public.apps
    `;
    const bySlug = new Map(rows.map((r) => [r.slug, r]));

    const returned: ReturnedApp[] = [];
    const replaced: ReplacedApp[] = [];
    const globalEnded: GlobalEndedApp[] = [];
    for (const app of appRegistry) {
      const codeHash = hashes.get(app.slug) ?? null;
      const identity = identities.get(app.slug)!;
      const global = app.global ?? null;
      // An app global again needs no grants: the reminder that it did goes.
      await tx`
        insert into public.apps (slug, name, description, icon, is_active, code_hash, identity, global)
        values (${app.slug}, ${app.name}, ${app.description}, ${app.icon}, false, ${codeHash}, ${identity}, ${global})
        on conflict (slug) do update set
          name                = excluded.name,
          description         = excluded.description,
          icon                = excluded.icon,
          code_hash           = excluded.code_hash,
          identity            = excluded.identity,
          global              = coalesce(excluded.global, public.apps.global),
          needs_grants_since  = case when excluded.global then null else public.apps.needs_grants_since end,
          needs_grants_reason = case when excluded.global then null else public.apps.needs_grants_reason end,
          missing_since       = null
      `;

      const row = bySlug.get(app.slug);

      // Global at the last run that carried it, and not now: held only by the
      // people an admin granted it to. Whoever had it, by an install or a
      // role, and has no grant lost it, and only if anyone did does the app
      // need grants. Recorded either way.
      if (row?.global === true && global === false) {
        const [{ roleOnly, lost }] = await tx<{ roleOnly: number; lost: number }[]>`
          select
            (select count(*)::int from public.user_app_grants
              where app_slug = ${app.slug} and role_only) as "roleOnly",
            (select count(*)::int from (
               select user_id from public.user_apps where app_slug = ${app.slug}
               union
               select user_id from public.user_app_grants where app_slug = ${app.slug}
             ) had
              where not exists (
                select 1 from public.user_app_grants g
                 where g.user_id = had.user_id and g.app_slug = ${app.slug} and ${tx.unsafe(IS_GRANT_SQL)}
              )) as lost
        `;
        if (lost > 0) {
          await tx`
            update public.apps
               set needs_grants_since = coalesce(needs_grants_since, now()),
                   needs_grants_reason = 'global-ended'
             where slug = ${app.slug}
          `;
        }
        await audit(tx, "app.global.ended", app.slug, { roleOnly, lost });
        globalEnded.push({ slug: app.slug, roleOnly, lost });
      }

      // New to this database: it arrives inactive, with nothing to compare.
      if (!row) continue;

      // Null is a row activation wrote before any release step recorded one,
      // for this same build's app: nothing to compare with yet.
      const identityChanged = row.identity !== null && row.identity !== identity;
      const returning = row.missing_since !== null;
      // Back after a run without it. A hash missing on either side counts as
      // changed: the safe reading of "can't tell" is the one an admin settles.
      const codeChanged = returning && (codeHash === null || row.code_hash !== codeHash);

      if (identityChanged) {
        // The first replaced identity, and when, are kept while an admin
        // hasn't answered: a second change doesn't hide what came first.
        await tx`
          update public.apps
          set is_active = false,
              identity_changed_at = coalesce(identity_changed_at, now()),
              replaced_identity = coalesce(replaced_identity, ${row.identity})
          where slug = ${app.slug}
        `;
        const revoked = await tx`
          update public.app_api_keys
          set revoked_at = now()
          where app_slug = ${app.slug} and revoked_at is null
          returning id
        `;
        // Turned on for the tools of the extension before it.
        const switches = await tx`
          delete from public.app_mcp_tool_settings
          where app_slug = ${app.slug}
          returning tool_name
        `;
        await audit(tx, "app.identity.changed", app.slug, {
          previous: identityDetails(row.identity),
          identity: identityDetails(identity),
          // True when this run switched off an app that was active.
          deactivated: row.is_active,
          apiKeysRevoked: revoked.length,
          mcpToolSwitchesReset: switches.length,
        });
        replaced.push({
          slug: app.slug,
          previous: row.identity!,
          identity,
          deactivated: row.is_active,
          apiKeysRevoked: revoked.length,
          mcpToolSwitchesReset: switches.length,
        });
      } else if (codeChanged) {
        await tx`
          update public.apps
          set is_active = false, returned_changed_at = now()
          where slug = ${app.slug}
        `;
      }

      if (!returning) continue;
      await audit(tx, "app.returned", app.slug, {
        codeChanged,
        previousCodeHash: row.code_hash,
        codeHash,
        missingSince: row.missing_since!.toISOString(),
        identityChanged,
        // True when this run switched off an app that was active when it left.
        deactivated: (codeChanged || identityChanged) && row.is_active,
      });
      returned.push({ slug: app.slug, codeChanged, identityChanged });
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
      replaced,
      globalEnded,
    };
  });
}
