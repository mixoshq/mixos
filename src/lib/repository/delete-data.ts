/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Delete data: what this database keeps for an app or a connector that left
 * the build, deleted, once nothing uses it any more.
 *
 * Removing an extension has two halves (./remove.ts). Its code goes in a
 * checkout and ships with a commit and a deploy. Its data stays in each
 * database, and the release step marks it (`apps.missing_since` in
 * scripts/sync-app-registry.ts, `connector.missing.<name>` in
 * scripts/sync-identities.ts). This is the second half, on each instance, by an
 * admin who typed the name. No code the extension ships runs. A theme holds no
 * data, so it has none.
 *
 * ── WHAT DECIDES ────────────────────────────────────────────────────────────
 *
 * The database, never the build serving the request alone. Refused when:
 *
 *   - the build serving this instance carries it: its data is in use here;
 *   - no release step has marked it missing: a host can serve an older build
 *     without running one, so a serving build that lacks it doesn't show that
 *     it has gone for good;
 *   - any other build seen in the last 24 hours carries it
 *     (`platform_builds_seen`, ../platform/builds-seen.ts). The caller's own
 *     build doesn't count, so a checkout can delete its own data right after
 *     removing the code.
 *
 * The Remove dialog's "Remove code and delete this checkout's data" calls this
 * right after a removal that regenerated the checkout's registry without it,
 * which is the change a release step marks. On a local database that counts as
 * the mark. On a shared one it doesn't, and a release step has to run first:
 * as with "Activate in this checkout" (./pending-admin.ts), a checkout decides
 * on its own only for a database no other machine reaches.
 *
 * ── WHAT GOES ───────────────────────────────────────────────────────────────
 *
 * For an app: its schema, `app_<slug>`, and its role, `mixos_app_<slug>`
 * (../apps/app-identifiers.ts), with its tables and its sync state; its rows in
 * `_migrations`, `app_settings`, `app_api_keys`, `app_scheduled_jobs`,
 * `app_job_runs` and `app_open_events`, and the `telemetry_events` it was the
 * source of; its place in each MCP authorization (`granted_apps`); and then its
 * row in `apps`, with its identity, which takes its grants, installs, password,
 * widgets and MCP tool switches with it. Calls it made to a connector or
 * another app's services are their telemetry, and stay.
 *
 * For a connector: its credentials (`connector_configs`), every user's own
 * connection (`user_connector_oauth`), its `connector_scope_status`, its webhook
 * replay markers, its telemetry, and its keys in `platform_settings`: the
 * missing mark, its identity, the switch and the replaced mark.
 *
 * Each row by its own column, equal to the name, never by a prefix of a name:
 * `notes_archive` is not part of `notes`. `admin_audit_log` is always kept.
 * Afterwards nothing under the name is left for a later extension to inherit.
 *
 * ── ONE TRANSACTION ─────────────────────────────────────────────────────────
 *
 * Under the release step's lock (scripts/migration-lock.ts), so it can't race a
 * release step marking or bringing back the same extension, with every check
 * made again under it. Any failure rolls all of it back. Dropping an app's
 * schema is checked on both sides: before, that the schema and the role are
 * the app's own (the schema owned by the role; the role with no powers, no
 * memberships and no use in another database); after, that nothing outside the
 * schema went with it, and that the role holds nothing else. Otherwise nothing
 * is deleted. It is audited as `<kind>.data.delete`, with what it deleted, in
 * the same transaction.
 */

import type { Sql, TransactionSql } from "postgres";
import { takeMigrationLock } from "../../../scripts/migration-lock";
import type { AdminActor } from "../apps/admin-audit";
import { appRoleName, appSchemaName, appSlugProblem } from "../apps/app-identifiers";
import {
  connectorMissingKey,
  connectorReplacedKey,
  connectorSwitchKey,
  connectorWritableKey,
} from "../connectors/switch-keys";
import { sql as platformSql } from "../db/client";
import { describeBuildKey, recentBuildsCarrying, RECENT_BUILD_HOURS } from "../platform/builds-seen";
import { EXTENSION_NAME_PATTERN } from "./backup";
import type {
  AppDataCounts,
  ConnectorDataCounts,
  DataCounts,
  DataDeleted,
  DataKind,
  DataPreview,
} from "./delete-data-outcomes";
import { identitySettingKey } from "./identity";
import type { NoticeTone, Refusal } from "./pending-outcomes";

export type DataRefusalCode =
  | "not-a-name"
  | "in-this-build"
  | "nothing-kept"
  | "not-marked"
  | "shared-database"
  | "carried-elsewhere"
  | "not-its-schema"
  | "role-not-its-own"
  | "outside-schema"
  | "role-holds-more"
  | "busy";

/** Why Delete data refused. Thrown inside the transaction, it rolls everything back. */
export class DataRefusalError extends Error {
  constructor(
    readonly code: DataRefusalCode,
    message: string,
    readonly tone: NoticeTone = "info",
  ) {
    super(message);
    this.name = "DataRefusalError";
  }
}

/** A refusal, as the admin pages show it. */
export function asRefusal(err: DataRefusalError): Refusal {
  return { ok: false, code: err.code, message: err.message, tone: err.tone };
}

/** What decides, besides the database. */
export interface DataCheckOptions {
  /** Whether the build serving this instance carries it. */
  inServingBuild: boolean;
  /** This instance's own key in platform_builds_seen, which doesn't count. Null when it has none. */
  ownBuildKey: string | null;
  /**
   * Set only by the Remove dialog, right after this checkout's registry was
   * regenerated without it. On a local database that counts as the release
   * step's mark; on a shared one, named by `hosts`, it doesn't.
   */
  afterRemoval?: { localDatabase: boolean; hosts: string };
  /** Tests: another database. The platform's own otherwise. */
  sql?: Sql;
}

export interface DeleteDataOptions extends DataCheckOptions {
  /** Who the audit row names. */
  actor: AdminActor;
  /** How long to wait for the release step's lock, and for the extension's tables. */
  lockTimeoutMs?: number;
}

type Query = Sql | TransactionSql;

const PAGE: Record<DataKind, string> = { app: "Admin > Apps", connector: "Admin > Connectors" };

function assertName(slug: string): void {
  if (!EXTENSION_NAME_PATTERN.test(slug)) {
    throw new DataRefusalError(
      "not-a-name",
      `"${slug.replace(/[^\x20-\x7e]/g, "?")}" isn't the name of an app or a connector.`,
      "warning",
    );
  }
}

/** "just now", "12 minutes ago", "3 hours ago". */
function ago(at: Date, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - at.getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}

/** A name for SQL text: only an app's schema or role, which app-identifiers.ts built from a valid slug. */
function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/* -------------------------------------------------------------------------- */
/*  What this database keeps                                                   */
/* -------------------------------------------------------------------------- */

interface RoleRow {
  oid: string;
  rolsuper: boolean;
  rolcanlogin: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
}

interface Kept {
  /** The name the database recorded for an app, or the connector's name. */
  name: string;
  /** Whether there is anything to delete: an app's row, or any of a connector's rows. */
  exists: boolean;
  /** When a release step marked it missing (ISO 8601), or null. */
  markedAt: string | null;
  counts: DataCounts;
  /** An app's schema and role, by name, and what the catalog says of each. Null for a connector. */
  database: {
    schema: string;
    role: string;
    /** The schema's owner, or null when there is no such schema. */
    schemaOwner: string | null;
    roleRow: RoleRow | null;
  } | null;
}

async function keptByApp(q: Query, slug: string): Promise<Kept> {
  const [row] = await q<{ name: string; missing_since: Date | null }[]>`
    select name, missing_since from public.apps where slug = ${slug}
  `;
  // A slug that can't name a schema never had one (../apps/app-identifiers.ts).
  const names = appSlugProblem(slug) === null ? { schema: appSchemaName(slug), role: appRoleName(slug) } : null;
  const [schemaRow] = names
    ? await q<{ owner: string }[]>`
        select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = ${names.schema}
      `
    : [];
  const [roleRow] = names
    ? await q<RoleRow[]>`
        select oid::text as oid, rolsuper, rolcanlogin, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
        from pg_roles where rolname = ${names.role}
      `
    : [];

  const [c] = await q<(Omit<AppDataCounts, "mcpAccess"> & { mcp_tokens: number; mcp_codes: number })[]>`
    select
      (select count(*)::int from public.user_app_grants where app_slug = ${slug}) as grants,
      (select count(*)::int from public.user_apps where app_slug = ${slug}) as installs,
      (select count(*)::int from public.app_passwords where app_slug = ${slug}) as passwords,
      (select count(*)::int from public.dashboard_widgets where app_slug = ${slug}) as widgets,
      (select count(*)::int from public.app_settings where app_slug = ${slug}) as settings,
      (select count(*)::int from public.app_api_keys where app_slug = ${slug}) as "apiKeys",
      (select count(*)::int from public.app_mcp_tool_settings where app_slug = ${slug}) as "mcpToolSwitches",
      (select count(*)::int from public.app_scheduled_jobs where app_slug = ${slug}) as "scheduledJobs",
      (select count(*)::int from public.app_job_runs where app_slug = ${slug}) as "jobRuns",
      (select count(*)::int from public._migrations where app_slug = ${slug}) as migrations,
      (select count(*)::int from public.telemetry_events
        where source_type in ('app', 'route', 'service', 'mcp') and source_slug = ${slug}) as "telemetryEvents",
      (select count(*)::int from public.app_open_events where app_slug = ${slug}) as "appOpens",
      (select count(*)::int from public.oauth_tokens where ${slug} = any(granted_apps)) as mcp_tokens,
      (select count(*)::int from public.oauth_authorization_codes where ${slug} = any(granted_apps)) as mcp_codes,
      (select count(*)::int from pg_class k join pg_namespace n on n.oid = k.relnamespace
        where n.nspname = ${names?.schema ?? null} and k.relkind in ('r', 'p')) as tables
  `;
  const counts: AppDataCounts = {
    tables: schemaRow ? c.tables : 0,
    grants: c.grants,
    installs: c.installs,
    passwords: c.passwords,
    widgets: c.widgets,
    settings: c.settings,
    apiKeys: c.apiKeys,
    mcpToolSwitches: c.mcpToolSwitches,
    scheduledJobs: c.scheduledJobs,
    jobRuns: c.jobRuns,
    migrations: c.migrations,
    telemetryEvents: c.telemetryEvents,
    appOpens: c.appOpens,
    mcpAccess: c.mcp_tokens + c.mcp_codes,
  };
  return {
    name: row?.name ?? slug,
    exists: row !== undefined,
    markedAt: row?.missing_since ? row.missing_since.toISOString() : null,
    counts,
    database: names
      ? { ...names, schemaOwner: schemaRow?.owner ?? null, roleRow: roleRow ?? null }
      : null,
  };
}

/** The keys a connector has in platform_settings. */
function connectorKeys(name: string): string[] {
  return [
    connectorMissingKey(name),
    identitySettingKey("connector", name),
    connectorSwitchKey(name),
    connectorWritableKey(name),
    connectorReplacedKey(name),
  ];
}

async function keptByConnector(q: Query, name: string): Promise<Kept> {
  const [c] = await q<(ConnectorDataCounts & { marked_at: string | null })[]>`
    select
      (select count(*)::int from public.connector_configs where connector_name = ${name}) as credentials,
      (select count(*)::int from public.user_connector_oauth where connector_name = ${name}) as connections,
      (select count(*)::int from public.connector_scope_status where connector_name = ${name}) as "scopeStatus",
      (select count(*)::int from public.connector_webhook_events where connector_name = ${name}) as "webhookEvents",
      (select count(*)::int from public.telemetry_events
        where source_type = 'connector' and source_slug = ${name}) as "telemetryEvents",
      (select count(*)::int from public.platform_settings where key = any(${connectorKeys(name)})) as settings,
      (select value from public.platform_settings where key = ${connectorMissingKey(name)}) as marked_at
  `;
  const counts: ConnectorDataCounts = {
    credentials: c.credentials,
    connections: c.connections,
    scopeStatus: c.scopeStatus,
    webhookEvents: c.webhookEvents,
    telemetryEvents: c.telemetryEvents,
    settings: c.settings,
  };
  return {
    name,
    exists: Object.values(counts).some((count) => count > 0),
    markedAt: c.marked_at,
    counts,
    database: null,
  };
}

function kept(q: Query, kind: DataKind, slug: string): Promise<Kept> {
  return kind === "app" ? keptByApp(q, slug) : keptByConnector(q, slug);
}

/* -------------------------------------------------------------------------- */
/*  The checks                                                                 */
/* -------------------------------------------------------------------------- */

/** The rules: whether its data is still in use by this build, or by any other. */
async function ruleRefusal(
  q: Query,
  kind: DataKind,
  slug: string,
  k: Kept,
  opts: DataCheckOptions,
): Promise<DataRefusalError | null> {
  if (opts.inServingBuild) {
    return new DataRefusalError(
      "in-this-build",
      `This server's build has ${slug}, so its data is in use here. Remove its code and deploy first.`,
    );
  }
  if (!k.exists) {
    return new DataRefusalError("nothing-kept", `This database keeps nothing for ${slug}.`);
  }
  const removedHere = opts.afterRemoval?.localDatabase === true;
  if (k.markedAt === null && !removedHere) {
    if (opts.afterRemoval) {
      return new DataRefusalError(
        "shared-database",
        `This checkout's database is on ${opts.afterRemoval.hosts}, which other instances may use too, so ` +
          `its data is deleted only once a release step has run without ${slug}. Run \`npm run migrate:apps\` ` +
          `here, or deploy the removal, then use Delete data on ${PAGE[kind]}.`,
      );
    }
    return new DataRefusalError(
      "not-marked",
      `No release step has run on this database without ${slug} yet. Deploy the build that removed it, or ` +
        "run `npm run migrate:apps` in a checkout, then try again.",
    );
  }
  const others = await recentBuildsCarrying(q, kind, slug, opts.ownBuildKey);
  if (others.length > 0) {
    const [first] = others;
    const more =
      others.length > 1
        ? ` ${others.length - 1} more seen in the last ${RECENT_BUILD_HOURS} hours ${others.length === 2 ? "has" : "have"} it too.`
        : "";
    return new DataRefusalError(
      "carried-elsewhere",
      `Another build that uses this database still has ${slug}: ${describeBuildKey(first.key)}, seen ` +
        `${ago(first.lastSeenAt)}.${more} Its data can be deleted once no build that has it has used this ` +
        `database for ${RECENT_BUILD_HOURS} hours.`,
    );
  }
  return null;
}

/**
 * An app's schema and role have to be its own: the schema owned by the role,
 * and the role one the release step could have made. Anything else was changed
 * by hand, and is left for a person.
 */
async function databaseRefusal(q: Query, k: Kept): Promise<DataRefusalError | null> {
  const db = k.database;
  if (!db) return null;
  if (db.schemaOwner !== null && db.schemaOwner !== db.role) {
    return new DataRefusalError(
      "not-its-schema",
      `The schema ${db.schema} belongs to ${db.schemaOwner}, not to ${db.role}, so it isn't this app's. ` +
        "Nothing was deleted.",
      "warning",
    );
  }
  const role = db.roleRow;
  if (!role) return null;
  const powers = (
    [
      ["SUPERUSER", role.rolsuper],
      ["LOGIN", role.rolcanlogin],
      ["CREATEROLE", role.rolcreaterole],
      ["CREATEDB", role.rolcreatedb],
      ["REPLICATION", role.rolreplication],
      ["BYPASSRLS", role.rolbypassrls],
    ] as const
  )
    .filter(([, has]) => has)
    .map(([power]) => power);
  if (powers.length > 0) {
    return new DataRefusalError(
      "role-not-its-own",
      `The role ${db.role} has ${powers.join(", ")}, which MixOS never gives an app's role. Nothing was deleted.`,
      "warning",
    );
  }
  const memberOf = await q<{ rolname: string }[]>`
    select r.rolname from pg_auth_members m join pg_roles r on r.oid = m.roleid
    where m.member = ${role.oid}::oid
    order by r.rolname
  `;
  if (memberOf.length > 0) {
    return new DataRefusalError(
      "role-not-its-own",
      `The role ${db.role} is a member of ${memberOf.map((r) => r.rolname).join(", ")}, which MixOS never makes ` +
        "an app's role. Nothing was deleted.",
      "warning",
    );
  }
  const elsewhere = await q<{ name: string }[]>`
    select distinct coalesce(d.datname, 'a shared object') as name
    from pg_shdepend s
    left join pg_database d on d.oid = s.dbid
    where s.refclassid = 'pg_authid'::regclass
      and s.refobjid = ${role.oid}::oid
      and s.dbid <> (select oid from pg_database where datname = current_database())
    order by 1
  `;
  if (elsewhere.length > 0) {
    return new DataRefusalError(
      "role-not-its-own",
      `The role ${db.role} is also used by ${elsewhere.map((r) => r.name).join(", ")}. Roles belong to the ` +
        "whole server, so it is left as it is. Nothing was deleted.",
      "warning",
    );
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  The preview                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What deleting `kind`/`slug`'s data would delete, and why it would be refused
 * now, if it would. Reads only, without the lock: the deletion checks again.
 * Throws DataRefusalError for a name that isn't one.
 */
export async function previewExtensionData(
  kind: DataKind,
  slug: string,
  opts: DataCheckOptions,
): Promise<DataPreview> {
  assertName(slug);
  const q = opts.sql ?? platformSql;
  const k = await kept(q, kind, slug);
  const refusal = (await ruleRefusal(q, kind, slug, k, opts)) ?? (k.exists ? await databaseRefusal(q, k) : null);
  return {
    kind,
    slug,
    name: k.name,
    counts: k.counts,
    schema: k.database?.schemaOwner ? k.database.schema : null,
    role: k.database?.roleRow ? k.database.role : null,
    markedAt: k.markedAt,
    refusal: refusal ? asRefusal(refusal) : null,
  };
}

/* -------------------------------------------------------------------------- */
/*  Deleting it                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Every object outside `schema` that dropping it could take with it, by
 * catalog row, with its kind and its schema-qualified name: relations and
 * their columns, defaults, constraints, triggers, rules and policies on them,
 * and functions and types. The system's own schemas are left out.
 */
async function outsideObjects(tx: TransactionSql, schema: string): Promise<Map<string, string>> {
  const rows = await tx<{ id: string; what: string | null }[]>`
    with ns as (
      select oid from pg_namespace
      where nspname <> ${schema} and nspname !~ '^pg_' and nspname <> 'information_schema'
    ),
    rel as (
      select oid from pg_class where relnamespace in (select oid from ns)
    ),
    objects (id, classid, objid, subid) as (
      select 'class:' || c.oid, 'pg_class'::regclass, c.oid, 0
        from pg_class c where c.oid in (select oid from rel)
      union all
      select 'column:' || a.attrelid || ':' || a.attnum, 'pg_class'::regclass, a.attrelid, a.attnum::int
        from pg_attribute a where a.attrelid in (select oid from rel) and a.attnum > 0 and not a.attisdropped
      union all
      select 'default:' || d.oid, 'pg_attrdef'::regclass, d.oid, 0
        from pg_attrdef d where d.adrelid in (select oid from rel)
      union all
      select 'constraint:' || k.oid, 'pg_constraint'::regclass, k.oid, 0
        from pg_constraint k where k.connamespace in (select oid from ns)
      union all
      select 'trigger:' || t.oid, 'pg_trigger'::regclass, t.oid, 0
        from pg_trigger t where t.tgrelid in (select oid from rel)
      union all
      select 'rule:' || r.oid, 'pg_rewrite'::regclass, r.oid, 0
        from pg_rewrite r where r.ev_class in (select oid from rel)
      union all
      select 'policy:' || p.oid, 'pg_policy'::regclass, p.oid, 0
        from pg_policy p where p.polrelid in (select oid from rel)
      union all
      select 'function:' || f.oid, 'pg_proc'::regclass, f.oid, 0
        from pg_proc f where f.pronamespace in (select oid from ns)
      union all
      select 'type:' || y.oid, 'pg_type'::regclass, y.oid, 0
        from pg_type y where y.typnamespace in (select oid from ns)
    )
    select o.id, i.type || ' ' || i.identity as what
    from objects o
    cross join lateral pg_identify_object(o.classid, o.objid, o.subid) i
  `;
  return new Map(rows.map((r) => [r.id, r.what ?? r.id]));
}

const ZERO_APP: AppDataCounts = {
  tables: 0,
  grants: 0,
  installs: 0,
  passwords: 0,
  widgets: 0,
  settings: 0,
  apiKeys: 0,
  mcpToolSwitches: 0,
  scheduledJobs: 0,
  jobRuns: 0,
  migrations: 0,
  telemetryEvents: 0,
  appOpens: 0,
  mcpAccess: 0,
};

async function deleteApp(tx: TransactionSql, slug: string, k: Kept): Promise<AppDataCounts> {
  const counts: AppDataCounts = { ...ZERO_APP };
  const db = k.database;
  const hasSchema = db !== null && db.schemaOwner !== null;
  const before = hasSchema ? await outsideObjects(tx, db.schema) : null;

  // The rows keyed by its slug alone, each by its own column.
  counts.migrations = (await tx`delete from public._migrations where app_slug = ${slug}`).count;
  counts.settings = (await tx`delete from public.app_settings where app_slug = ${slug}`).count;
  counts.apiKeys = (await tx`delete from public.app_api_keys where app_slug = ${slug}`).count;
  counts.scheduledJobs = (await tx`delete from public.app_scheduled_jobs where app_slug = ${slug}`).count;
  counts.jobRuns = (await tx`delete from public.app_job_runs where app_slug = ${slug}`).count;
  counts.telemetryEvents = (
    await tx`
      delete from public.telemetry_events
      where source_type in ('app', 'route', 'service', 'mcp') and source_slug = ${slug}
    `
  ).count;
  counts.appOpens = (await tx`delete from public.app_open_events where app_slug = ${slug}`).count;

  // MCP authorizations keep every other app they list.
  counts.mcpAccess =
    (
      await tx`
        update public.oauth_tokens set granted_apps = array_remove(granted_apps, ${slug})
        where ${slug} = any(granted_apps)
      `
    ).count +
    (
      await tx`
        update public.oauth_authorization_codes set granted_apps = array_remove(granted_apps, ${slug})
        where ${slug} = any(granted_apps)
      `
    ).count;

  // Its row, and what hangs off it by foreign key.
  const [hanging] = await tx<
    { grants: number; installs: number; passwords: number; widgets: number; mcpToolSwitches: number }[]
  >`
    select
      (select count(*)::int from public.user_app_grants where app_slug = ${slug}) as grants,
      (select count(*)::int from public.user_apps where app_slug = ${slug}) as installs,
      (select count(*)::int from public.app_passwords where app_slug = ${slug}) as passwords,
      (select count(*)::int from public.dashboard_widgets where app_slug = ${slug}) as widgets,
      (select count(*)::int from public.app_mcp_tool_settings where app_slug = ${slug}) as "mcpToolSwitches"
  `;
  Object.assign(counts, hanging);
  await tx`delete from public.apps where slug = ${slug}`;

  if (db && hasSchema) {
    counts.tables = (k.counts as AppDataCounts).tables;
    await tx.unsafe(`drop schema ${ident(db.schema)} cascade`);
    const after = await outsideObjects(tx, db.schema);
    const gone = [...before!.entries()].filter(([id]) => !after.has(id)).map(([, what]) => what);
    if (gone.length > 0) {
      const shown = gone.slice(0, 3).join(", ") + (gone.length > 3 ? ` and ${gone.length - 3} more` : "");
      throw new DataRefusalError(
        "outside-schema",
        `Dropping ${db.schema} would also drop ${shown}, outside it. Nothing was deleted.`,
        "warning",
      );
    }
  }

  if (db?.roleRow) {
    const [{ held }] = await tx<{ held: number }[]>`
      select count(*)::int as held from pg_shdepend
      where refclassid = 'pg_authid'::regclass
        and refobjid = ${db.roleRow.oid}::oid
        and dbid = (select oid from pg_database where datname = current_database())
    `;
    if (held > 0) {
      throw new DataRefusalError(
        "role-holds-more",
        `The role ${db.role} still owns or has access to something outside ${db.schema}. Nothing was deleted.`,
        "warning",
      );
    }
    await tx.unsafe(`drop role ${ident(db.role)}`);
  }
  return counts;
}

async function deleteConnector(tx: TransactionSql, name: string): Promise<ConnectorDataCounts> {
  return {
    credentials: (await tx`delete from public.connector_configs where connector_name = ${name}`).count,
    connections: (await tx`delete from public.user_connector_oauth where connector_name = ${name}`).count,
    scopeStatus: (await tx`delete from public.connector_scope_status where connector_name = ${name}`).count,
    webhookEvents: (await tx`delete from public.connector_webhook_events where connector_name = ${name}`).count,
    telemetryEvents: (
      await tx`delete from public.telemetry_events where source_type = 'connector' and source_slug = ${name}`
    ).count,
    settings: (await tx`delete from public.platform_settings where key = any(${connectorKeys(name)})`).count,
  };
}

/** Postgres's lock_not_available: the lock or a table wasn't free in time. */
function isLockTimeout(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "55P03";
}

/**
 * Delete what this database keeps for `kind`/`slug`, in one transaction under
 * the release step's lock, or throw DataRefusalError and change nothing. Any
 * other error has rolled everything back too.
 */
export async function deleteExtensionData(
  kind: DataKind,
  slug: string,
  opts: DeleteDataOptions,
): Promise<DataDeleted> {
  assertName(slug);
  const db = opts.sql ?? platformSql;
  const timeout = Math.max(1, Math.trunc(opts.lockTimeoutMs ?? 15_000));
  try {
    return await db.begin(async (tx) => {
      // SET LOCAL takes no parameters; the value is an integer built here.
      await tx.unsafe(`set local lock_timeout = '${timeout}ms'`);
      await takeMigrationLock(tx);
      // No build records itself while this decides and deletes.
      await tx`lock table public.platform_builds_seen in share mode`;

      const k = await kept(tx, kind, slug);
      const refusal = (await ruleRefusal(tx, kind, slug, k, opts)) ?? (await databaseRefusal(tx, k));
      if (refusal) throw refusal;

      const counts = kind === "app" ? await deleteApp(tx, slug, k) : await deleteConnector(tx, slug);
      const result: DataDeleted = {
        kind,
        slug,
        counts,
        schema: k.database?.schemaOwner ? k.database.schema : null,
        role: k.database?.roleRow ? k.database.role : null,
      };
      await tx`
        insert into public.admin_audit_log (actor_id, actor_email, action, target_type, target_id, details)
        values (
          ${opts.actor.id}, ${opts.actor.email}, ${`${kind}.data.delete`}, ${kind}, ${slug},
          ${tx.json({
            via: "button",
            ...(opts.afterRemoval ? { afterRemoval: true } : {}),
            markedAt: k.markedAt,
            counts,
            ...(result.schema ? { schema: result.schema } : {}),
            ...(result.role ? { role: result.role } : {}),
          } as never)}
        )
      `;
      return result;
    });
  } catch (err) {
    if (isLockTimeout(err)) {
      throw new DataRefusalError(
        "busy",
        "A release step or another deletion is running on this database, or the extension's tables are in use. " +
          "Nothing was deleted. Try again in a moment.",
        "neutral",
      );
    }
    throw err;
  }
}
