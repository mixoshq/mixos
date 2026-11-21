/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Moves what this database keeps for each renamed extension from its old slug
// to its new one: the release step's half of `npm run rename`.
//
// The rename ledger, extension-renames.json, lists each rename in the checkout
// (scripts/extension-renames.ts), and the generator writes it, checked against
// the build, to src/generated/extension-renames.ts. This runs first in the
// release step and in `npm run migrate:apps`, before the app registry mirror,
// which would otherwise see the old slug leave and the new one arrive as a new,
// inactive app with nothing (scripts/sync-app-registry.ts).
//
// WHAT MOVES is exactly what Delete data… would delete for the extension
// (src/lib/repository/delete-data.ts), and the records the release step keeps
// for it:
//
//   - an app: its row in public.apps, with everything that hangs off it by
//     foreign key (grants and roles, installs, its password, MCP tool switches,
//     dashboard widgets) and everything keyed by its slug alone (settings, API
//     keys, applied migrations, scheduled jobs and their runs, opens, telemetry
//     it recorded or drove, its place in each MCP authorization, lockouts on
//     its password). Its schema and role are renamed, so its tables come with
//     them untouched. Which of its release notes each person has seen moves
//     too, since a note's id names its slug, so nobody is shown them as new
//     again.
//   - a connector: its credentials, every user's connection, its scope status,
//     webhook events, telemetry, and its switches and records in
//     platform_settings: identity, disabled, writable, replaced, missing.
//   - a theme: the applied theme, when it is the one renamed, and its identity.
//
// The audit log keeps the old slug: it is a record of what happened under it.
//
// WHEN. An entry whose old slug holds nothing here does nothing: a fresh
// instance, or one this has moved already. So the ledger keeps every entry,
// and a second run is a no-op. If the new slug already holds something, say a
// build without the ledger ran first and someone used the new app, nothing is
// merged: the entry is skipped and audited `<kind>.rename.skipped`, and an
// admin decides. A new slug holding only the bare row a release step made for
// it, with nothing hanging off it, is not something: that row is replaced.
//
// One transaction under the release step's lock (scripts/migration-lock.ts),
// like the registry mirror, so a rename moves whole or not at all, and two
// runners take turns.

import type { Sql, TransactionSql } from "postgres";
import { extensionRenames } from "../src/generated/extension-renames";
import { RELEASE_STEP_ACTOR } from "../src/lib/apps/audit-actors";
import { appRoleName, appSchemaName } from "../src/lib/apps/app-identifiers";
import {
  connectorMissingKey,
  connectorReplacedKey,
  connectorSwitchKey,
  connectorWritableKey,
} from "../src/lib/connectors/switch-keys";
import { identitySettingKey } from "../src/lib/repository/identity";
import type { ExtensionRename } from "./extension-renames";
import { takeMigrationLock } from "./migration-lock";

export type RenameOutcome = "moved" | "nothing" | "skipped";

export interface RenameResult {
  rename: ExtensionRename;
  outcome: RenameOutcome;
  /** For "skipped": what the new slug already holds. */
  reason?: string;
}

/** platform_settings' key for the applied theme (src/lib/themes/active.ts). */
const APPLIED_THEME_KEY = "theme";

/** A name for SQL text. Only ever an app's schema or role, from app-identifiers.ts. */
function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** The tables that hold an app's rows in an `app_slug` column: by foreign key, and by slug alone. */
const APP_SLUG_TABLES = [
  "user_app_grants",
  "user_apps",
  "app_passwords",
  "app_mcp_tool_settings",
  "dashboard_widgets",
  "app_settings",
  "app_api_keys",
  "_migrations",
  "app_scheduled_jobs",
  "app_job_runs",
  "app_open_events",
] as const;

/** The telemetry an app is the source of (delete-data.ts counts the same). */
const APP_SOURCES = ["app", "route", "service", "mcp"];

/** The tables that hold a connector's rows in a `connector_name` column. */
const CONNECTOR_TABLES = [
  "connector_configs",
  "user_connector_oauth",
  "connector_scope_status",
  "connector_webhook_events",
] as const;

async function audit(
  tx: TransactionSql,
  action: string,
  r: ExtensionRename,
  details: Record<string, unknown> = {},
): Promise<void> {
  await tx`
    insert into public.admin_audit_log
      (actor_id, actor_email, action, target_type, target_id, details)
    values (null, ${RELEASE_STEP_ACTOR}, ${action}, ${r.kind}, ${r.to},
            ${tx.json({ from: r.from, to: r.to, date: r.date, ...details } as never)})
  `;
}

async function schemaExists(tx: TransactionSql, schema: string): Promise<boolean> {
  return (await tx`select 1 from pg_namespace where nspname = ${schema}`).length > 0;
}

async function roleExists(tx: TransactionSql, role: string): Promise<boolean> {
  return (await tx`select 1 from pg_roles where rolname = ${role}`).length > 0;
}

/** What an app's slug holds beyond the bare row a release step makes, or null for nothing. */
async function appHolds(tx: TransactionSql, slug: string): Promise<string | null> {
  for (const table of APP_SLUG_TABLES) {
    const rows = await tx.unsafe(`select 1 from public.${ident(table)} where app_slug = $1 limit 1`, [slug]);
    if (rows.length > 0) return `rows in public.${table}`;
  }
  if (await schemaExists(tx, appSchemaName(slug))) return `the schema ${appSchemaName(slug)}`;
  if (await roleExists(tx, appRoleName(slug))) return `the role ${appRoleName(slug)}`;
  return null;
}

/** The settings keys the release step and the admin switches keep for a connector. */
function connectorKeys(name: string): string[] {
  return [
    identitySettingKey("connector", name),
    connectorSwitchKey(name),
    connectorWritableKey(name),
    connectorReplacedKey(name),
    connectorMissingKey(name),
  ];
}

/**
 * Move one platform_settings key. When both exist, the old one wins: it holds
 * what an admin decided under the old name, and the new name's was only ever
 * written by a release step that ran before the rename reached it.
 */
async function moveSetting(tx: TransactionSql, from: string, to: string): Promise<void> {
  await tx`
    delete from public.platform_settings
    where key = ${to} and exists (select 1 from public.platform_settings where key = ${from})
  `;
  await tx`update public.platform_settings set key = ${to}, updated_at = now() where key = ${from}`;
}

/** `kind:slug:` at the start of a release note's id (scripts/release-notes.ts releaseNoteId()). */
async function moveSeenNotes(tx: TransactionSql, kind: string, from: string, to: string): Promise<void> {
  const old = `${kind}:${from}:`;
  const next = `${kind}:${to}:`;
  // A person who has seen a note under both names keeps the one under the new.
  await tx`
    delete from public.release_notes_seen s
    where left(s.note_id, ${old.length}) = ${old}
      and exists (
        select 1 from public.release_notes_seen t
        where t.user_id = s.user_id and t.note_id = ${next} || substr(s.note_id, ${old.length + 1})
      )
  `;
  await tx`
    update public.release_notes_seen
    set note_id = ${next} || substr(note_id, ${old.length + 1})
    where left(note_id, ${old.length}) = ${old}
  `;
}

async function renameApp(tx: TransactionSql, r: ExtensionRename): Promise<RenameResult> {
  const [old] = await tx`select slug from public.apps where slug = ${r.from}`;
  const oldSchema = appSchemaName(r.from);
  const oldRole = appRoleName(r.from);
  const hasSchema = await schemaExists(tx, oldSchema);
  const hasRole = await roleExists(tx, oldRole);
  if (!old && !hasSchema && !hasRole) return { rename: r, outcome: "nothing" };

  const held = await appHolds(tx, r.to);
  if (held) return { rename: r, outcome: "skipped", reason: held };

  if (old) {
    // The row the release step made for the new slug, when one ran first, holds
    // nothing (appHolds() said so), and gives way to the old row.
    await tx`delete from public.apps where slug = ${r.to}`;

    // Copied column by column, whatever columns the table has by now, with
    // the slug changed and the missing mark cleared: the app is here, under
    // its new name. Then everything that names it is pointed at the copy,
    // and the old row, with nothing left hanging off it, goes.
    const columns = (
      await tx<{ column_name: string }[]>`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'apps' and column_name not in ('slug', 'missing_since')
        order by ordinal_position
      `
    ).map((c) => ident(c.column_name));
    await tx.unsafe(
      `insert into public.apps (slug, missing_since, ${columns.join(", ")})
       select $1, null, ${columns.join(", ")} from public.apps where slug = $2`,
      [r.to, r.from],
    );
    for (const table of APP_SLUG_TABLES) {
      await tx.unsafe(`update public.${ident(table)} set app_slug = $1 where app_slug = $2`, [r.to, r.from]);
    }
    await tx`delete from public.apps where slug = ${r.from}`;
  } else {
    // No row, but a schema or role: move the rows keyed by slug alone anyway.
    for (const table of APP_SLUG_TABLES) {
      await tx.unsafe(`update public.${ident(table)} set app_slug = $1 where app_slug = $2`, [r.to, r.from]);
    }
  }

  await tx`
    update public.telemetry_events set source_slug = ${r.to}
    where source_type = any(${APP_SOURCES}) and source_slug = ${r.from}
  `;
  await tx`update public.telemetry_events set caller_app_slug = ${r.to} where caller_app_slug = ${r.from}`;
  for (const table of ["oauth_tokens", "oauth_authorization_codes"]) {
    await tx.unsafe(
      `update public.${ident(table)} set granted_apps = array_replace(granted_apps, $1, $2) where $1 = any(granted_apps)`,
      [r.from, r.to],
    );
  }
  // A person's search order and switches keep the app where they put it, and
  // its objects' switches, `<slug>/<object>`, follow it too.
  const objectPrefix = `${r.from}/`;
  await tx`
    update public.user_search_preferences
    set source_order = array_replace(source_order, ${r.from}, ${r.to}),
        disabled_sources = array_replace(disabled_sources, ${r.from}, ${r.to}),
        disabled_objects = array(
          select case when left(o, ${objectPrefix.length}) = ${objectPrefix}
                      then ${`${r.to}/`} || substr(o, ${objectPrefix.length + 1})
                      else o end
          from unnest(disabled_objects) with ordinality as t(o, n)
          order by n
        )
    where ${r.from} = any(source_order)
       or ${r.from} = any(disabled_sources)
       or exists (select 1 from unnest(disabled_objects) o where left(o, ${objectPrefix.length}) = ${objectPrefix})
  `;
  // `<ip>::<slug>`: a lockout on the app's password stays a lockout.
  await tx`
    update public.app_unlock_failures
    set subject = left(subject, length(subject) - ${r.from.length}) || ${r.to}
    where right(subject, ${r.from.length + 2}) = ${`::${r.from}`}
  `;
  await moveSeenNotes(tx, "app", r.from, r.to);

  // Its tables keep their names and owner; only the schema's name changes.
  if (hasSchema) await tx.unsafe(`alter schema ${ident(oldSchema)} rename to ${ident(appSchemaName(r.to))}`);
  if (hasRole) await tx.unsafe(`alter role ${ident(oldRole)} rename to ${ident(appRoleName(r.to))}`);

  await audit(tx, "app.renamed", r, { schema: hasSchema, role: hasRole });
  return { rename: r, outcome: "moved" };
}

async function renameConnector(tx: TransactionSql, r: ExtensionRename): Promise<RenameResult> {
  const holds = async (name: string): Promise<string | null> => {
    for (const table of CONNECTOR_TABLES) {
      const rows = await tx.unsafe(`select 1 from public.${ident(table)} where connector_name = $1 limit 1`, [name]);
      if (rows.length > 0) return `rows in public.${table}`;
    }
    return null;
  };
  const oldKeys = connectorKeys(r.from);
  const [{ keys }] = await tx<{ keys: number }[]>`
    select count(*)::int as keys from public.platform_settings where key = any(${oldKeys})
  `;
  if (!(await holds(r.from)) && keys === 0) return { rename: r, outcome: "nothing" };

  const held = await holds(r.to);
  if (held) return { rename: r, outcome: "skipped", reason: held };

  for (const table of CONNECTOR_TABLES) {
    await tx.unsafe(`update public.${ident(table)} set connector_name = $1 where connector_name = $2`, [r.to, r.from]);
  }
  await tx`
    update public.telemetry_events set source_slug = ${r.to}
    where source_type = 'connector' and source_slug = ${r.from}
  `;
  // Its switches and records follow it (moveSetting()).
  const newKeys = connectorKeys(r.to);
  for (let i = 0; i < oldKeys.length; i++) await moveSetting(tx, oldKeys[i], newKeys[i]);
  await moveSeenNotes(tx, "connector", r.from, r.to);

  await audit(tx, "connector.renamed", r);
  return { rename: r, outcome: "moved" };
}

async function renameTheme(tx: TransactionSql, r: ExtensionRename): Promise<RenameResult> {
  const [applied] = await tx<{ value: string }[]>`
    select value from public.platform_settings where key = ${APPLIED_THEME_KEY}
  `;
  const isApplied = applied?.value === r.from;
  const oldKey = identitySettingKey("theme", r.from);
  const [identity] = await tx`select 1 from public.platform_settings where key = ${oldKey}`;
  if (!isApplied && !identity) return { rename: r, outcome: "nothing" };

  if (isApplied) {
    await tx`update public.platform_settings set value = ${r.to}, updated_at = now() where key = ${APPLIED_THEME_KEY}`;
  }
  await moveSetting(tx, oldKey, identitySettingKey("theme", r.to));
  await moveSeenNotes(tx, "theme", r.from, r.to);

  await audit(tx, "theme.renamed", r, { applied: isApplied });
  return { rename: r, outcome: "moved" };
}

/** Moves every rename in the ledger, in order, in one transaction. */
export async function syncRenames(
  sql: Sql,
  renames: readonly ExtensionRename[] = extensionRenames,
): Promise<RenameResult[]> {
  if (renames.length === 0) return [];
  return sql.begin(async (tx) => {
    await takeMigrationLock(tx);
    const results: RenameResult[] = [];
    for (const r of renames) {
      const result =
        r.kind === "app" ? await renameApp(tx, r) : r.kind === "connector" ? await renameConnector(tx, r) : await renameTheme(tx, r);
      if (result.outcome === "skipped") {
        await audit(tx, `${r.kind}.rename.skipped`, r, { reason: result.reason });
      }
      results.push(result);
    }
    return results;
  });
}

export async function syncAndReportRenames(
  sql: Sql,
  renames: readonly ExtensionRename[] = extensionRenames,
): Promise<RenameResult[]> {
  console.log("Moving renamed extensions' data to their new slugs...");
  const results = await syncRenames(sql, renames);
  const moved = results.filter((r) => r.outcome === "moved");
  console.log(
    renames.length === 0
      ? "  no renames"
      : `  ${renames.length} rename(s) in the ledger, ${moved.length} moved by this run`,
  );
  for (const { rename: r, outcome, reason } of results) {
    if (outcome === "moved") console.log(`  ${r.kind} ${r.from} → ${r.to}: moved`);
    if (outcome === "skipped") {
      console.log(
        `  ${r.kind} ${r.from} → ${r.to}: skipped, because ${r.to} already holds ${reason}. ` +
          `Nothing was merged; ${r.from}'s data is kept under its old slug.`,
      );
    }
  }
  return results;
}
