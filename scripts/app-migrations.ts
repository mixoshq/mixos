/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Applies per-app migrations from apps/<slug>/migrations/.
//
// Scope note: this handles APP migrations only. The platform's own schema lives
// in supabase/migrations/ and is applied first, by scripts/platform-migrations.ts
// (`npm run db:migrate`) or the Supabase CLI.
//
// EACH APP'S SQL RUNS AS THE APP, IN A SCHEMA OF ITS OWN. An app that declares
// `"database": true` gets a schema, app_<slug>, owned by a role,
// mixos_app_<slug>, that cannot log in and holds nothing else
// (src/lib/apps/app-identifiers.ts). Its files run through a SECURITY DEFINER
// function owned by that role, with the schema first on the function's search
// path. `create table notes` lands in app_<slug>.notes with nothing rewritten,
// and Postgres refuses a statement that reaches past the schema. Postgres also
// refuses SET ROLE and SET SESSION AUTHORIZATION inside such a function, which
// is why the role switch happens there and not on the connection.
//
// Before any of that, every statement is checked against what an app migration
// may say (scripts/app-sql-policy.ts). The role bounds what a migration does
// while it runs; the check bounds what it leaves behind, such as a default or a
// view. The app's own queries run as its role too, through the app's runner
// (ensureAppRunner), but the platform reads and writes the app's tables as
// itself, and that is when what the migration left behind would run with the
// platform's privileges.
//
// Each release puts every app's runner in place and checks it (probeAppRunner),
// so a runner that's missing or was changed fails the release, not every query
// after it.
//
// Which apps: those in this build's registry with `"database": true`. A folder
// the registry generator did not accept never has its SQL run, and an app that
// ships migrations/ without declaring a database is refused. Applied files are
// recorded in public._migrations, so each runs exactly once.
//
// Safe to run twice at once, like the platform migrations: every write below
// happens in a transaction that first takes the release step's lock
// (scripts/migration-lock.ts), and each step re-reads what it is about to
// change once the lock is held, so a second runner finds the work done.
//
// Library only: scripts/migrate.ts (`npm run migrate:apps`) and
// scripts/release.ts are the entry points.

import fs from "fs";
import path from "path";
import type { Sql, TransactionSql } from "postgres";
import { appRegistry } from "../src/generated/app-registry";
import { appIdentifierProblems, appRoleName, appSchemaName } from "../src/lib/apps/app-identifiers";
import type { AppManifest } from "../src/lib/apps/types";
import { RUNNER, runThrough } from "../src/lib/db/query";
import { describeIdentity } from "../src/lib/repository/identity";
import type { RegistryInstall } from "../src/lib/repository/install-record";
import { listAppMigrations, undeclaredMigrations } from "./app-migration-files";
import { checkAppMigrationSql, formatSqlProblems, lineAtCharacter } from "./app-sql-policy";
import { takeMigrationLock } from "./migration-lock";
import { syncAppRegistry, type MirroredApp } from "./sync-app-registry";

const ROOT = path.resolve(__dirname, "..");
const APPS_DIR = path.join(ROOT, "apps");

/** What the runner reads of each app the registry accepted. */
export type MigratedApp = MirroredApp & Pick<AppManifest, "database" | "updatedAt" | "sync">;

export interface MigrateAppsOptions {
  /** The apps this build accepted. Defaults to the generated registry. */
  apps?: readonly MigratedApp[];
  /** Where their folders are. Defaults to this checkout's apps/. */
  appsDir?: string;
  /** What this build installed from a Registry. Defaults to the generated list. */
  installs?: readonly RegistryInstall[];
}

/**
 * A name for SQL text. Everything passed here is an app's schema or role, or a
 * table or column the build checked is a plain identifier.
 */
function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Return the set of migration files already applied for the given app slug.
 * `_migrations` is created by the platform schema (supabase/migrations/
 * 0001_platform_schema.sql). SQLSTATE `42P01` (undefined_table) therefore means the
 * platform schema has not been pushed yet, which is a setup error worth
 * reporting rather than swallowing.
 */
async function getAppliedMigrations(
  sql: Sql,
  appSlug: string,
): Promise<Set<string>> {
  try {
    const rows = await sql<{ migration_file: string }[]>`
      SELECT migration_file
      FROM public._migrations
      WHERE app_slug = ${appSlug}
    `;
    return new Set(rows.map((r) => r.migration_file));
  } catch (err) {
    const e = err as { code?: string };
    if (e?.code === "42P01") {
      throw new Error(
        "public._migrations does not exist. Apply the platform schema first: " +
          "`npm run db:migrate` against any Postgres, `npm run db:local` for " +
          "the local Docker stack (or just re-run `npm run dev:docker`), or " +
          "`npm run db:push` against a linked hosted project.",
      );
    }
    throw err;
  }
}

interface RoleRow {
  oid: number;
  rolsuper: boolean;
  rolcanlogin: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
}

/**
 * An app role that already exists has to be one this file could have created:
 * no attribute beyond NOLOGIN, a member of no other role, and used in no other
 * database. Its migrations run with whatever it holds, so anything more is
 * refused rather than inherited.
 *
 * The last check is there because roles belong to the server, not to one
 * database. Two MixOS databases on one server would share mixos_app_<slug>, and
 * each database's own role, being a member of it, would reach the other's app
 * data.
 */
async function assertRoleContained(tx: TransactionSql, role: string, row: RoleRow): Promise<void> {
  const powers = (
    [
      ["SUPERUSER", row.rolsuper],
      ["LOGIN", row.rolcanlogin],
      ["CREATEROLE", row.rolcreaterole],
      ["CREATEDB", row.rolcreatedb],
      ["REPLICATION", row.rolreplication],
      ["BYPASSRLS", row.rolbypassrls],
    ] as const
  )
    .filter(([, has]) => has)
    .map(([name]) => name);
  if (powers.length > 0) {
    throw new Error(
      `The role ${role} has ${powers.join(", ")}. An app's migrations run as its role, ` +
        `so it must have none of these. Remove them (ALTER ROLE ${role} NO...) and run this again.`,
    );
  }

  const memberOf = await tx<{ rolname: string }[]>`
    select r.rolname
    from pg_auth_members m
    join pg_roles r on r.oid = m.roleid
    where m.member = ${row.oid}::oid
  `;
  if (memberOf.length > 0) {
    throw new Error(
      `The role ${role} is a member of ${memberOf.map((r) => r.rolname).join(", ")}. ` +
        `An app's migrations run as its role and would hold that role's privileges too. ` +
        `Revoke the membership and run this again.`,
    );
  }

  const elsewhere = await tx<{ name: string }[]>`
    select distinct coalesce(d.datname, 'a shared object') as name
    from pg_shdepend s
    left join pg_database d on d.oid = s.dbid
    where s.refclassid = 'pg_authid'::regclass
      and s.refobjid = ${row.oid}::oid
      and s.dbid <> (select oid from pg_database where datname = current_database())
  `;
  if (elsewhere.length > 0) {
    throw new Error(
      `The role ${role} is also used in ${elsewhere.map((r) => r.name).join(", ")}. ` +
        `Roles are shared by every database on a server, so two MixOS databases there would ` +
        `share this app's role and reach each other's app data through it. Give each MixOS ` +
        `database its own server.`,
    );
  }
}

/**
 * Make the role running this a member of the app's role, so it can read and
 * write the app's tables as `context.db` and hand the role what it creates.
 *
 * Postgres 16 split membership into options. Before it, a member uses a role's
 * privileges whenever the member itself has INHERIT, the default; from it, the
 * grant has to say so, and has to allow SET ROLE for ownership to be given to
 * the role. A superuser holds every role already.
 */
async function joinAppRole(tx: TransactionSql, role: string): Promise<void> {
  const [{ version }] = await tx<{ version: number }[]>`
    select current_setting('server_version_num')::int as version
  `;
  const options = version >= 160000;
  const held = async () => {
    const [row] = options
      ? await tx<{ ok: boolean }[]>`
          select pg_has_role(current_user, ${role}, 'USAGE')
             and pg_has_role(current_user, ${role}, 'SET') as ok
        `
      : await tx<{ ok: boolean }[]>`select pg_has_role(current_user, ${role}, 'USAGE') as ok`;
    return row.ok;
  };
  if (await held()) return;

  await tx.unsafe(`grant ${ident(role)} to current_user${options ? " with inherit true, set true" : ""}`);
  if (!(await held())) {
    throw new Error(
      `This database role was granted ${role} but cannot use its privileges. ` +
        `It needs INHERIT (ALTER ROLE <this role> INHERIT) to read the app's tables.`,
    );
  }
}

/**
 * The app's role and schema: created where missing, checked where present.
 * The catalog is the record of what exists, so there is no marker to fall out
 * of step with it. Roles are not in a database dump, for one: a restored
 * database has the schema and no role, and this creates the role again.
 */
export async function ensureAppDatabase(sql: Sql, slug: string): Promise<void> {
  const schema = appSchemaName(slug);
  const role = appRoleName(slug);

  await sql.begin(async (tx) => {
    await takeMigrationLock(tx);

    const [existing] = await tx<RoleRow[]>`
      select oid, rolsuper, rolcanlogin, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
      from pg_roles
      where rolname = ${role}
    `;
    if (!existing) {
      // NOLOGIN: nothing ever connects as it, so no host's password rules apply.
      await tx.unsafe(`create role ${ident(role)} nologin`);
      console.log(`  ${slug}: created role ${role}`);
    } else {
      await assertRoleContained(tx, role, existing);
    }

    await joinAppRole(tx, role);

    const [namespace] = await tx<{ owner: string }[]>`
      select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = ${schema}
    `;
    if (!namespace) {
      await tx.unsafe(`create schema ${ident(schema)} authorization ${ident(role)}`);
      console.log(`  ${slug}: created schema ${schema}`);
    } else if (namespace.owner !== role) {
      throw new Error(
        `The schema ${schema} already exists and belongs to ${namespace.owner}, not ${role}. ` +
          `It is not this app's, so its migrations will not run in it.`,
      );
    }
  });
}

/**
 * The body of every app's runner, the function each `context.db` statement
 * runs through (`run` in src/lib/db/query.ts). `probeAppRunner` compares the
 * catalog against this text, so it is one constant.
 */
const RUNNER_BODY = `
begin
  if read_only then
    perform set_config('transaction_read_only', 'on', true);
  end if;
  return query execute stmt using params;
end
`;

/** The runner's one setting. Every name the builder writes is schema-qualified. */
const RUNNER_SEARCH_PATH = "search_path=pg_catalog, pg_temp";

function runnerSignature(slug: string): string {
  return `${ident(appSchemaName(slug))}.${RUNNER}(text, json, boolean)`;
}

/**
 * Put the app's runner in place: `app_<slug>.mixos_run(stmt, params,
 * read_only)`, a SECURITY DEFINER function owned by the app's role, which
 * nobody else may execute. Every `context.db` statement runs inside it, so it
 * runs as the app's role, and Postgres refuses a role change while it does.
 *
 * Replaced on every release, owner and grants included, after the app's
 * migrations: the migration check refuses CREATE, ALTER and DROP FUNCTION, and
 * this would undo one that got past it anyway, before the probe looks.
 */
export async function ensureAppRunner(sql: Sql, slug: string): Promise<void> {
  const fn = runnerSignature(slug);
  await sql.begin(async (tx) => {
    await takeMigrationLock(tx);
    await tx.unsafe(`
      create or replace function ${ident(appSchemaName(slug))}.${RUNNER}(stmt text, params json, read_only boolean)
      returns setof json
      language plpgsql
      volatile
      security definer
      set search_path = pg_catalog, pg_temp
      as $mixos_run$${RUNNER_BODY}$mixos_run$
    `);
    await tx.unsafe(`alter function ${fn} owner to ${ident(appRoleName(slug))}`);
    await tx.unsafe(`revoke all on function ${fn} from public`);
  });
}

/**
 * Check the app's runner before any request uses it: in the catalog, that it
 * is the one `ensureAppRunner` makes (SECURITY DEFINER, owned by the app's
 * role, its search path and body, executable by that role alone); then by
 * calling it, read-write and read-only, the way `context.db` will, and asking
 * the database who the statement ran as.
 *
 * Fails closed, and there is no setting to skip it: a SECURITY DEFINER runner
 * owned by anyone else would run the app's statements as them.
 */
export async function probeAppRunner(sql: Sql, slug: string): Promise<void> {
  const schema = appSchemaName(slug);
  const role = appRoleName(slug);
  const [runner] = await sql<
    { definer: boolean; owner: string; config: string[] | null; body: string; others: string[] }[]
  >`
    select p.prosecdef as definer,
           pg_get_userbyid(p.proowner) as owner,
           p.proconfig as config,
           p.prosrc as body,
           array(
             select coalesce(pg_get_userbyid(nullif(a.grantee, 0)), 'PUBLIC')
               from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
              where a.grantee <> p.proowner
           ) as others
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = ${schema}
       and p.proname = ${RUNNER}
       and pg_get_function_identity_arguments(p.oid) = 'stmt text, params json, read_only boolean'
  `;
  const problem = !runner
    ? "is missing"
    : !runner.definer
      ? "isn't SECURITY DEFINER, so it would run the app's statements as whoever calls it"
      : runner.owner !== role
        ? `belongs to ${runner.owner}, not ${role}, so it would run the app's statements as ${runner.owner}`
        : JSON.stringify(runner.config) !== JSON.stringify([RUNNER_SEARCH_PATH])
          ? `has settings ${JSON.stringify(runner.config)}, not ${JSON.stringify([RUNNER_SEARCH_PATH])}`
          : runner.body !== RUNNER_BODY
            ? "has a different body from the one the release step writes"
            : runner.others.length > 0
              ? `may be executed by ${runner.others.join(", ")}`
              : null;
  if (problem) {
    throw new Error(
      `${slug}: the function its queries run through, ${schema}.${RUNNER}, ${problem}. ` +
        `Run the release step again, which replaces it; if it changes again, something other than MixOS is changing it.`,
    );
  }

  const ask = "select json_build_object('who', current_user, 'ro', current_setting('transaction_read_only'))";
  let answers: { who: string; ro: string }[];
  try {
    answers = [
      (await runThrough(sql, { schema }, ask))[0],
      (await runThrough(sql, { schema, readOnly: true }, ask))[0],
    ];
  } catch (err) {
    throw new Error(
      `${slug}: this database login can't run queries through ${schema}.${RUNNER}: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `It needs to be a member of ${role}, as the release step makes it.`,
    );
  }
  const [rw, ro] = answers;
  if (rw?.who !== role || ro?.who !== role || rw.ro !== "off" || ro.ro !== "on") {
    throw new Error(
      `${slug}: a query through ${schema}.${RUNNER} ran as ${rw?.who}, read-only ${rw?.ro} ` +
        `(read-only client: ${ro?.who}, ${ro?.ro}), not as ${role}.`,
    );
  }
}

/** The function an app's migration file runs through. It exists only while that file runs. */
const APPLY_FUNCTION = "mixos_apply_migration";

/**
 * An error from applying `file`, prefixed with where it happened. A statement
 * Postgres rejected while parsing carries its position in the file, which
 * becomes a line number.
 */
function located(err: unknown, file: string, sqlText: string): unknown {
  const e = err as { message?: unknown; internal_position?: unknown; internal_query?: unknown };
  if (typeof e?.message !== "string") return err;
  const position = Number(e.internal_position);
  const line =
    e.internal_query === sqlText && Number.isInteger(position) && position > 0
      ? `:${lineAtCharacter(sqlText, position - 1)}`
      : "";
  return new Error(`${file}${line}: ${e.message}`, { cause: err });
}

/**
 * Apply one migration file as the app's role, in one transaction with its
 * ledger row, so a partial apply rolls back cleanly.
 *
 * The function the file runs through is created, given to the app's role,
 * called and dropped inside that transaction. It is made afresh for every
 * file: the app's role owns it while it runs, and nothing a file did to it can
 * carry over to the next one. Its search path puts the app's schema first and
 * pg_temp last, and it fixes standard_conforming_strings to what the checking
 * parser assumed, the one setting that moves where a string literal ends.
 *
 * The ledger is read again under the lock, because the caller's read happened
 * before it: another runner may have applied this file in between.
 *
 * It does not check the SQL: migrateApps does that, for every pending file,
 * before it applies any. Exported for the test that shows what the role alone
 * holds back when that check is skipped.
 */
export async function applyMigration(
  sql: Sql,
  slug: string,
  file: string,
  sqlText: string,
): Promise<"applied" | "already"> {
  const schema = ident(appSchemaName(slug));
  const fn = `${schema}.${APPLY_FUNCTION}`;
  try {
    return await sql.begin(async (tx) => {
      await takeMigrationLock(tx);
      const done = await tx`
        SELECT 1 FROM public._migrations
        WHERE app_slug = ${slug} AND migration_file = ${file}
      `;
      if (done.length > 0) return "already" as const;

      await tx.unsafe(`
        create or replace function ${fn}(migration text)
        returns void
        language plpgsql
        security definer
        set search_path = ${schema}, pg_temp
        set standard_conforming_strings = on
        as $mixos$
        begin
          execute migration;
        end
        $mixos$
      `);
      await tx.unsafe(`alter function ${fn}(text) owner to ${ident(appRoleName(slug))}`);
      await tx.unsafe(`select ${fn}($1)`, [sqlText]);
      await tx.unsafe(`drop function ${fn}(text)`);

      await tx`
        INSERT INTO public._migrations (app_slug, migration_file)
        VALUES (${slug}, ${file})
      `;
      return "applied" as const;
    });
  } catch (err) {
    throw located(err, `apps/${slug}/migrations/${file}`, sqlText);
  }
}

/**
 * Create the platform-owned `_sync_state` table for any app declaring a `sync`.
 *
 * Watermark, window size and last status are the platform's bookkeeping, not the
 * app's — `runSync` is the only writer, and `docs/apps/data-freshness.md` lists
 * "persisting a provider cursor in your state table" as the single most
 * expensive mistake in this codebase. There is deliberately no cursor column: a
 * cursor lives inside one run and there is nowhere here to put it.
 *
 * It sits in the app's schema and belongs to the platform's role, so the app's
 * migrations cannot alter it, and the app's role has no privilege on it:
 * `context.db` can't read or write it. `runSync` reaches it through the
 * platform's own handle (`createPlatformScopedClient`).
 */
async function ensureSyncState(sql: Sql, app: MigratedApp): Promise<void> {
  if (!app.sync || app.sync.length === 0) return;
  const schema = appSchemaName(app.slug);
  const table = `${ident(schema)}."_sync_state"`;

  // Under the lock: two `create table` at once can still collide on the type
  // the table creates, rather than one of them skipping.
  await sql.begin(async (tx) => {
    await takeMigrationLock(tx);
    const [{ exists }] = await tx<{ exists: boolean }[]>`
      select to_regclass(${`${schema}._sync_state`}) is not null as exists
    `;
    if (exists) return;
    await tx.unsafe(`
      create table ${table} (
        name           text primary key,
        synced_through timestamptz,
        window_days    int,
        last_status    text,
        last_run_at    timestamptz
      )
    `);
    await tx.unsafe(`alter table ${table} enable row level security`);
    console.log(`  ${app.slug}: sync state ready`);
  });
}

/** The trigger mixos_touch_updated_at() is installed as, for one column. */
function updatedAtTrigger(column: string): string {
  return `mixos_updated_at_${column}`.slice(0, 63);
}

/**
 * Put the platform's updated_at trigger (`mixos_touch_updated_at`, in
 * supabase/migrations/0001_platform_schema.sql) on each
 * column the app lists under `updatedAt`, and take it off any it no longer
 * lists. After the app's migrations, so the tables exist.
 *
 * Each column is checked against the database itself: the build only read the
 * migration files. An app's own SQL cannot create, drop or rename a trigger,
 * so every trigger running this function in the app's schema is one this put
 * there.
 */
async function syncUpdatedAtTriggers(sql: Sql, app: MigratedApp): Promise<void> {
  const schema = appSchemaName(app.slug);
  const wanted = new Map(
    (app.updatedAt ?? []).map((c) => [`${c.table}.${updatedAtTrigger(c.column)}`, c]),
  );

  await sql.begin(async (tx) => {
    await takeMigrationLock(tx);
    const [{ touch }] = await tx<{ touch: string | null }[]>`
      select to_regprocedure('public.mixos_touch_updated_at()')::oid::text as touch
    `;
    if (!touch) {
      if (wanted.size === 0) return;
      throw new Error(
        "public.mixos_touch_updated_at() does not exist. Apply the platform schema first (`npm run db:migrate`).",
      );
    }

    for (const c of wanted.values()) {
      const [column] = await tx<{ relkind: string; timestamp: boolean }[]>`
        select c.relkind, a.atttypid in ('timestamptz'::regtype, 'timestamp'::regtype) as timestamp
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid
        where n.nspname = ${schema}
          and c.relname = ${c.table}
          and a.attname = ${c.column}
          and a.attnum > 0
          and not a.attisdropped
      `;
      if (!column || column.relkind !== "r") {
        throw new Error(
          `apps/${app.slug}/app.json lists ${c.table}.${c.column} under "updatedAt", ` +
            `but the app's migrations leave no such column on a table.`,
        );
      }
      if (!column.timestamp) {
        throw new Error(
          `apps/${app.slug}/app.json lists ${c.table}.${c.column} under "updatedAt", ` +
            `but it is not a timestamptz or timestamp column.`,
        );
      }
    }

    const existing = await tx<{ table: string; trigger: string }[]>`
      select c.relname as table, t.tgname as trigger
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${schema}
        and not t.tgisinternal
        and t.tgfoid = ${touch}::oid
    `;
    const present = new Set(existing.map((e) => `${e.table}.${e.trigger}`));

    for (const e of existing) {
      if (wanted.has(`${e.table}.${e.trigger}`)) continue;
      await tx.unsafe(`drop trigger ${ident(e.trigger)} on ${ident(schema)}.${ident(e.table)}`);
      console.log(`  ${app.slug}: no longer keeping ${e.table} current (${e.trigger})`);
    }
    for (const [key, c] of wanted) {
      if (present.has(key)) continue;
      await tx.unsafe(
        `create trigger ${ident(updatedAtTrigger(c.column))} ` +
          `before update on ${ident(schema)}.${ident(c.table)} ` +
          `for each row execute function public.mixos_touch_updated_at('${c.column.replace(/'/g, "''")}')`,
      );
      console.log(`  ${app.slug}: ${c.table}.${c.column} set on every update`);
    }
  });
}

/**
 * Enable RLS on every table in `public` and in the apps' schemas that lacks it,
 * and report what changed.
 *
 * The platform schema states the rule in its own header: RLS on, zero policies,
 * because Supabase publishes `public` through PostgREST to the `anon` role and
 * the anon key is publishable rather than secret. A table with RLS off is
 * readable by anyone holding it.
 *
 * App tables are swept too. An app's own schema is not one PostgREST publishes
 * unless someone configures it to, and the role that owns its tables is not
 * the one the app connects as; the platform's role reaches them as a member of
 * the owner, which RLS treats as the owner. With RLS on and no policies, any
 * other role that could see them, by any route, reads nothing.
 *
 * Sweeping the catalog rather than tracking names is deliberate: the platform
 * schema tried the hand-kept list and the list is what rotted. Idempotent, so
 * running migrations twice hardens nothing the second time.
 */
async function hardenRowLevelSecurity(sql: Sql, appSchemas: readonly string[]) {
  return sql.begin(async (tx) => {
    await takeMigrationLock(tx);
    const rows = await tx<{ schema: string; relname: string }[]>`
      select n.nspname as schema, c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any(${["public", ...appSchemas]})
        and c.relkind = 'r'
        and not c.relrowsecurity
        and not exists (
          select 1
          from pg_depend d
          where d.objid = c.oid
            and d.deptype = 'e'
        )
      order by n.nspname, c.relname
    `;

    for (const { schema, relname } of rows) {
      await tx.unsafe(`alter table ${ident(schema)}.${ident(relname)} enable row level security`);
      console.log(`  RLS enabled: ${schema === "public" ? relname : `${schema}.${relname}`}`);
    }

    return rows.length;
  });
}

async function migrateApps(
  sql: Sql,
  apps: readonly MigratedApp[],
  appsDir: string,
): Promise<void> {
  // Every refusal comes before anything is applied, so a release that cannot
  // run all of its app SQL runs none of it.
  const undeclared = undeclaredMigrations(appsDir, apps);
  if (undeclared.length > 0) {
    throw new Error(
      undeclared
        .map(
          ({ slug, files }) =>
            `apps/${slug}/migrations/ holds ${files.join(", ")}, but apps/${slug}/app.json ` +
            `does not set "database": true. An app without a database has no schema to migrate.`,
        )
        .join("\n"),
    );
  }

  // The same listing the build stamps for the readiness probe, so what this
  // applies and what a deployment waits for are one set of files.
  const listed = listAppMigrations(appsDir, apps);
  const identifiers = appIdentifierProblems(listed.map((a) => a.slug));
  if (identifiers.length > 0) throw new Error(identifiers.join("\n"));

  const bySlug = new Map(apps.map((a) => [a.slug, a]));
  const plan: {
    app: MigratedApp;
    files: { file: string; text: string | null }[];
  }[] = [];
  const refused: string[] = [];

  for (const { slug, files } of listed) {
    const applied = files.length > 0 ? await getAppliedMigrations(sql, slug) : new Set<string>();
    const entries: { file: string; text: string | null }[] = [];
    for (const file of files) {
      if (applied.has(file)) {
        entries.push({ file, text: null });
        continue;
      }
      const text = fs.readFileSync(path.join(appsDir, slug, "migrations", file), "utf-8");
      const problems = await checkAppMigrationSql(text, appSchemaName(slug));
      if (problems.length > 0) refused.push(formatSqlProblems(`apps/${slug}/migrations/${file}`, problems));
      entries.push({ file, text });
    }
    plan.push({ app: bySlug.get(slug)!, files: entries });
  }

  if (refused.length > 0) {
    throw new Error(
      `App migrations refused, and none applied:\n${refused.join("\n")}\n` +
        "docs/apps/database.md lists what an app migration may contain.",
    );
  }

  for (const { app, files } of plan) {
    await ensureAppDatabase(sql, app.slug);

    // The platform owns the sync watermark table, so an app that declares a
    // `sync` never writes a migration for it — and never gets the chance to
    // shape it wrongly. Created before the app's own migrations so one of them
    // could reference it.
    await ensureSyncState(sql, app);

    for (const { file, text } of files) {
      if (text === null) {
        console.log(`  ${app.slug}/${file}: already applied`);
        continue;
      }
      console.log(`  ${app.slug}/${file}: applying...`);
      const outcome = await applyMigration(sql, app.slug, file, text);
      console.log(
        outcome === "applied"
          ? `  ${app.slug}/${file}: applied`
          : `  ${app.slug}/${file}: already applied by another run`,
      );
    }

    await syncUpdatedAtTriggers(sql, app);
    await ensureAppRunner(sql, app.slug);
    await probeAppRunner(sql, app.slug);
  }
}

/**
 * Everything `npm run migrate:apps` does, in order: mirror the app registry
 * into public.apps, apply each app's pending migrations, then harden RLS on
 * whatever those migrations created.
 *
 * `options` is for tests: a release runs this build's registry against this
 * checkout's apps/.
 */
export async function migrateAppSchemas(
  sql: Sql,
  options: MigrateAppsOptions = {},
): Promise<void> {
  const apps = options.apps ?? appRegistry;
  const appsDir = options.appsDir ?? APPS_DIR;

  console.log("Syncing the app registry into public.apps...");
  const sync = await syncAppRegistry(sql, apps, appsDir, options.installs);
  console.log(`  ${sync.upserted} app(s) in the registry`);
  // Reported as it happens, so whoever reads a deploy's log learns that an app
  // left the build from the log, not from the first person who can't open it.
  for (const slug of sync.missing) {
    console.log(
      `  ${slug}: not in this build — marked missing; its activation, grants, settings and data are kept`,
    );
  }
  // One line per app: an app that came back as a different extension is
  // reported as that, below, and not as a return.
  for (const { slug, codeChanged, identityChanged } of sync.returned) {
    if (identityChanged) continue;
    console.log(
      codeChanged
        ? `  ${slug}: back in the build with different code — inactive until an admin activates it`
        : `  ${slug}: back in the build, unchanged`,
    );
  }
  for (const r of sync.replaced) {
    const back = sync.returned.some((a) => a.slug === r.slug) ? "back in the build, and " : "";
    console.log(
      `  ${r.slug}: ${back}a different extension than before (was ${describeIdentity(r.previous)}; ` +
        `now ${describeIdentity(r.identity)}) — inactive, with ${r.apiKeysRevoked} API key(s) revoked ` +
        `and ${r.mcpToolSwitchesReset} MCP tool switch(es) reset` +
        (r.connectorCredentialsDeleted > 0
          ? `, and its own credentials for ${r.connectorCredentialsDeleted} connector(s) deleted`
          : "") +
        `, until an admin activates it by typing its slug`,
    );
  }
  for (const { slug, roleOnly, lost } of sync.globalEnded) {
    console.log(
      lost > 0
        ? `  ${slug}: no longer global — only the people granted it have it; ` +
            `${lost} who had it without a grant don't now, ${roleOnly} of them with a role kept`
        : `  ${slug}: no longer global — everyone who had it was granted it`,
    );
  }
  if (sync.stillMissing.length > 0) {
    console.log(`  still missing, data kept: ${sync.stillMissing.join(", ")}`);
  }

  console.log("\nApplying app migrations...");
  await migrateApps(sql, apps, appsDir);

  // After the app SQL, never before: a table created by this run has to be
  // hardened by this run. See hardenRowLevelSecurity for why it sweeps.
  console.log("\nChecking row-level security...");
  const hardened = await hardenRowLevelSecurity(
    sql,
    apps.filter((a) => a.database).map((a) => appSchemaName(a.slug)),
  );
  console.log(
    hardened === 0
      ? "  all tables already protected"
      : `  hardened ${hardened} table(s)`,
  );

  if (apps.some((a) => a.database)) await warnPublicCreate(sql);
}

/**
 * Before Postgres 15, every role may create tables in `public`, every app's
 * role included. Platform migration 0004 takes that away where this login
 * owns `public`. Where it doesn't, only the owner can, so this says so on
 * every release. App SQL is still checked so it can't name `public`; the
 * database just doesn't refuse it as well.
 */
async function warnPublicCreate(sql: Sql): Promise<void> {
  const [{ open }] = await sql<{ open: boolean }[]>`
    select has_schema_privilege('public', 'public', 'CREATE') as open
  `;
  if (!open) return;
  console.warn(
    "  warning: every role, each app's included, may create tables in the public schema " +
      "(the default before Postgres 15). The owner of the public schema can end that with " +
      "`revoke create on schema public from public`.",
  );
}
