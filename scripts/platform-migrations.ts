/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Applies the platform schema — supabase/migrations/*.sql — to any Postgres.
//
// The Supabase CLI used to be the only way to apply these files, which made it
// the only way to run MixOS. This does the same job with nothing but a
// DATABASE_URL, so a plain Postgres, Neon, RDS or a container works, and so
// does Supabase itself.
//
// ── The ledger is the Supabase CLI's own ─────────────────────────────────────
// Applied files are recorded in supabase_migrations.schema_migrations, the table
// `supabase db push` and `supabase migration up` keep, with the same version
// (the file's numeric prefix) and name. That is deliberate: a database the CLI
// migrated is seen as migrated here, and the reverse, so an install can move
// between the two without replaying anything. On a plain Postgres the schema is
// simply created; the name is the CLI's, not a dependency on Supabase.
//
// ── Safe to run twice at once ────────────────────────────────────────────────
// Each file is applied in its own transaction, together with its ledger row,
// under a transaction-scoped advisory lock, and the ledger is re-read once the
// lock is held. Two runners started together — two instances booting, a deploy
// overlapping a manual run — therefore apply each file exactly once. A
// session-scoped lock would not survive a transaction pooler (see 0007's notes
// on _platform_locks); a transaction-scoped one does.
//
// Library only: scripts/db-migrate.ts and scripts/release.ts are the entry
// points.

import fs from "fs";
import path from "path";
import type { Sql, TransactionSql } from "postgres";

const MIGRATION_FILE = /^(\d+)_(.+)\.sql$/;

/** gen_random_uuid() is built in from 13; the schema calls it everywhere. */
const MIN_SERVER_VERSION = 130000;

export interface PlatformMigration {
  version: string;
  name: string;
  file: string;
}

export function listPlatformMigrations(dir: string): PlatformMigration[] {
  if (!fs.existsSync(dir)) {
    throw new Error(`No platform migrations at ${dir}.`);
  }
  return fs
    .readdirSync(dir)
    .map((file) => ({ file, m: MIGRATION_FILE.exec(file) }))
    .filter((x): x is { file: string; m: RegExpExecArray } => x.m !== null)
    .map(({ file, m }) => ({ version: m[1], name: m[2], file }))
    .sort((a, b) => Number(a.version) - Number(b.version) || a.file.localeCompare(b.file));
}

async function lock(tx: TransactionSql): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext('mixos:platform-migrations'))`;
}

export interface PlatformMigrationResult {
  applied: string[];
  alreadyApplied: number;
}

export async function migratePlatform(
  sql: Sql,
  dir: string,
  log: (line: string) => void = console.log,
): Promise<PlatformMigrationResult> {
  const [{ server_version_num }] = await sql<{ server_version_num: string }[]>`
    show server_version_num
  `;
  if (Number(server_version_num) < MIN_SERVER_VERSION) {
    throw new Error(
      `Postgres ${server_version_num} is too old. MixOS needs Postgres 13 or later.`,
    );
  }

  const migrations = listPlatformMigrations(dir);

  await sql.begin(async (tx) => {
    await lock(tx);
    // Checked first rather than `if not exists`, which would announce on every
    // run that there was nothing to do.
    const [{ exists }] = await tx<{ exists: boolean }[]>`
      select to_regclass('supabase_migrations.schema_migrations') is not null as exists
    `;
    if (exists) return;
    await tx`create schema if not exists supabase_migrations`;
    await tx`
      create table supabase_migrations.schema_migrations (
        version    text primary key,
        statements text[],
        name       text
      )
    `;
  });

  const applied: string[] = [];
  let alreadyApplied = 0;

  for (const m of migrations) {
    const outcome = await sql.begin(async (tx) => {
      await lock(tx);
      const done = await tx`
        select 1 from supabase_migrations.schema_migrations where version = ${m.version}
      `;
      if (done.length > 0) return "already" as const;

      const text = fs.readFileSync(path.join(dir, m.file), "utf-8");
      log(`  ${m.file}: applying...`);
      await tx.unsafe(text);
      await tx`
        insert into supabase_migrations.schema_migrations (version, name, statements)
        values (${m.version}, ${m.name}, array[${text}::text])
      `;
      return "applied" as const;
    });

    if (outcome === "applied") {
      applied.push(m.file);
      log(`  ${m.file}: applied`);
    } else {
      alreadyApplied++;
    }
  }

  return { applied, alreadyApplied };
}
