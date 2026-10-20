/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Records which extension each connector and theme name in this build is, and
// acts when a different one has taken a name: the release step's identity
// check for the kinds with no table of their own. Apps record theirs in their
// rows (scripts/sync-app-registry.ts).
//
// An identity (src/lib/repository/identity.ts) is where an extension came
// from, by its install record: the catalogue, its kind and slug, and its GitHub
// repository; or `local`. A new version or commit from the same repository is
// the same extension, so an update changes nothing here.
//
// CONNECTORS. Recorded in platform_settings as `connector.identity.<name>`.
// A connector's credentials, and every user's connection to it, are kept by
// name, so a different connector under the same name would be handed them.
// When this build's identity differs from the recorded one, this turns the
// connector off with the admin switch (`connector.disabled.<name>`,
// src/lib/connectors/switch.ts), marks it `connector.replaced.<name>`, with the
// identity it replaced as the value, and audits `connector.identity.changed`.
// The credentials are kept, as Disable keeps them. It stays off until an admin
// enables it with its name typed (setConnectorEnabled() in
// src/lib/connectors/switch-admin.ts), which clears the mark.
//
// THEMES. Recorded as `theme.identity.<slug>`, and a change is audited
// `theme.identity.changed`, saying whether it is the applied theme. Nothing
// more: a theme runs no code and holds no credentials, keys or data, the only
// thing the database keeps by its slug is which theme is applied, and the build
// checks everything a theme can change (its tokens, its selectors, the contrast
// of its colours, no outside URLs). It has no switch to hold it at either:
// turning it "off" would be putting every user on another theme.
//
// A name with nothing recorded is recorded without comparing: an extension new
// to this database. A connector or theme that leaves the build keeps its
// record, so one that comes back as a different extension is caught as well.
//
// CONNECTORS THIS BUILD LACKS. A connector this database holds credentials
// or connections for (connector_configs, user_connector_oauth), and that this
// build doesn't carry, is marked `connector.missing.<name>`, with when as its
// value, and audited `connector.missing`. Nothing is deleted: its credentials
// and its users' connections stay until an admin deletes them with Delete data
// (src/lib/repository/delete-data.ts), which needs this mark. A build that
// carries it again clears the mark, audited `connector.returned`. Apps have the
// same mark in their rows (scripts/sync-app-registry.ts); a theme holds no data.
//
// One transaction under the release step's lock (scripts/migration-lock.ts),
// like the app registry sync, so the records, the switches, the marks and the
// audit rows are written whole or not at all.

import type { Sql, TransactionSql } from "postgres";
import { connectorNames } from "../src/generated/connector-registry";
import { registryInstalls } from "../src/generated/registry-installs";
import { themeSlugs } from "../src/generated/theme-registry";
import { RELEASE_STEP_ACTOR } from "../src/lib/apps/audit-actors";
import {
  MISSING_KEY_PREFIX,
  connectorMissingKey,
  connectorReplacedKey,
  connectorSwitchKey,
  connectorWritableKey,
} from "../src/lib/connectors/switch-keys";
import {
  describeIdentity,
  extensionIdentity,
  identityDetails,
  identitySettingKey,
} from "../src/lib/repository/identity";
import type { RegistryInstall } from "../src/lib/repository/install-record";
import { takeMigrationLock } from "./migration-lock";

/** What the release step reads of a build. A test passes its own. */
export interface IdentityBuild {
  connectors: readonly string[];
  themes: readonly string[];
  installs: readonly RegistryInstall[];
}

const THIS_BUILD: IdentityBuild = {
  connectors: connectorNames,
  themes: themeSlugs,
  installs: registryInstalls,
};

export interface ReplacedConnector {
  name: string;
  previous: string;
  identity: string;
  /** True when this run turned it off; false when an admin already had. */
  disabled: boolean;
}

export interface ReplacedTheme {
  slug: string;
  previous: string;
  identity: string;
  /** It is the theme this instance has applied. */
  applied: boolean;
}

export interface IdentitySyncResult {
  connectors: ReplacedConnector[];
  themes: ReplacedTheme[];
  /** Connectors this database holds credentials for that this build lacks, marked by this run. */
  missing: string[];
  /** Connectors marked missing until this run. */
  returned: string[];
}

/** platform_settings' key for the applied theme (src/lib/themes/active.ts). */
const APPLIED_THEME_KEY = "theme";

async function audit(
  tx: TransactionSql,
  action: "connector.identity.changed" | "theme.identity.changed" | "connector.missing" | "connector.returned",
  targetType: "connector" | "theme",
  targetId: string,
  details: Record<string, unknown>,
): Promise<void> {
  await tx`
    insert into public.admin_audit_log
      (actor_id, actor_email, action, target_type, target_id, details)
    values (null, ${RELEASE_STEP_ACTOR}, ${action}, ${targetType}, ${targetId}, ${tx.json(details as never)})
  `;
}

export async function syncIdentities(
  sql: Sql,
  build: IdentityBuild = THIS_BUILD,
): Promise<IdentitySyncResult> {
  const wanted = [
    ...build.connectors.map((slug) => ({ kind: "connector" as const, slug })),
    ...build.themes.map((slug) => ({ kind: "theme" as const, slug })),
  ].map((e) => ({
    ...e,
    key: identitySettingKey(e.kind, e.slug),
    identity: extensionIdentity(e.kind, e.slug, build.installs),
  }));

  return sql.begin(async (tx) => {
    await takeMigrationLock(tx);

    const keys = [...wanted.map((w) => w.key), APPLIED_THEME_KEY];
    const rows = await tx<{ key: string; value: string }[]>`
      select key, value from public.platform_settings where key = any(${keys})
    `;
    const recorded = new Map(rows.map((r) => [r.key, r.value]));
    const appliedTheme = recorded.get(APPLIED_THEME_KEY);

    const result: IdentitySyncResult = { connectors: [], themes: [], missing: [], returned: [] };
    for (const w of wanted) {
      const previous = recorded.get(w.key);
      if (previous === w.identity) continue;

      await tx`
        insert into public.platform_settings (key, value)
        values (${w.key}, ${w.identity})
        on conflict (key) do update set value = excluded.value, updated_at = now()
      `;
      if (previous === undefined) continue;

      const details = { previous: identityDetails(previous), identity: identityDetails(w.identity) };
      if (w.kind === "connector") {
        // Off, keeping the first time if an admin had already turned it off,
        // as the switch itself does. The mark keeps the first identity
        // replaced while an admin hasn't answered.
        const switched = await tx`
          insert into public.platform_settings (key, value)
          values (${connectorSwitchKey(w.slug)}, ${new Date().toISOString()})
          on conflict (key) do nothing
          returning key
        `;
        await tx`
          insert into public.platform_settings (key, value)
          values (${connectorReplacedKey(w.slug)}, ${previous})
          on conflict (key) do nothing
        `;
        // Allow changes was given to the connector before it. The one now
        // under this name starts read-only, as every connector does.
        await tx`
          delete from public.platform_settings where key = ${connectorWritableKey(w.slug)}
        `;
        const disabled = switched.length > 0;
        await audit(tx, "connector.identity.changed", "connector", w.slug, { ...details, disabled });
        result.connectors.push({ name: w.slug, previous, identity: w.identity, disabled });
      } else {
        const applied = appliedTheme === w.slug;
        await audit(tx, "theme.identity.changed", "theme", w.slug, { ...details, applied });
        result.themes.push({ slug: w.slug, previous, identity: w.identity, applied });
      }
    }

    // A connector this database holds credentials or connections for, that
    // this build lacks: marked once, keeping when it was first marked, and
    // kept whole. By exact name, from the rows that hold them.
    const marked = await tx<{ key: string }[]>`
      insert into public.platform_settings (key, value)
      select ${MISSING_KEY_PREFIX}::text || held.name, ${new Date().toISOString()}
      from (
        select connector_name as name from public.connector_configs
        union
        select connector_name from public.user_connector_oauth
      ) as held
      where not (held.name = any(${build.connectors}))
      on conflict (key) do nothing
      returning key
    `;
    for (const { key } of marked) {
      const name = key.slice(MISSING_KEY_PREFIX.length);
      const [held] = await tx<{ credentials: boolean; connections: number }[]>`
        select
          exists (select 1 from public.connector_configs where connector_name = ${name}) as credentials,
          (select count(*)::int from public.user_connector_oauth where connector_name = ${name}) as connections
      `;
      await audit(tx, "connector.missing", "connector", name, { ...held });
      result.missing.push(name);
    }

    // Back in this build: the mark goes, with when it was set in the audit row.
    const back = await tx<{ key: string; value: string }[]>`
      delete from public.platform_settings
      where key = any(${build.connectors.map(connectorMissingKey)})
      returning key, value
    `;
    for (const row of back) {
      const name = row.key.slice(MISSING_KEY_PREFIX.length);
      await audit(tx, "connector.returned", "connector", name, { missingSince: row.value });
      result.returned.push(name);
    }

    result.missing.sort();
    result.returned.sort();
    return result;
  });
}

/** syncIdentities(), saying in the release step's log what it found. */
export async function syncAndReportIdentities(
  sql: Sql,
  build: IdentityBuild = THIS_BUILD,
): Promise<IdentitySyncResult> {
  console.log("Recording where each connector and theme came from...");
  const result = await syncIdentities(sql, build);
  console.log(`  ${build.connectors.length} connector(s), ${build.themes.length} theme(s)`);
  for (const c of result.connectors) {
    console.log(
      `  ${c.name}: a different connector than before (was ${describeIdentity(c.previous)}; ` +
        `now ${describeIdentity(c.identity)}) — ${c.disabled ? "disabled" : "kept disabled"} until an admin ` +
        `enables it by typing its name; its credentials are kept`,
    );
  }
  for (const t of result.themes) {
    console.log(
      `  ${t.slug}: a different theme than before (was ${describeIdentity(t.previous)}; ` +
        `now ${describeIdentity(t.identity)})${t.applied ? ", and it is the applied theme" : ""}`,
    );
  }
  for (const name of result.missing) {
    console.log(`  ${name}: not in this build — marked missing; its credentials and connections are kept`);
  }
  for (const name of result.returned) {
    console.log(`  ${name}: back in the build`);
  }
  return result;
}
