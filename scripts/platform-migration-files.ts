/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The platform migrations a checkout carries: supabase/migrations/NNNN_name.sql.
//
// One listing for every reader. The runner (scripts/platform-migrations.ts)
// applies these files, the registry generator stamps the highest number into
// the build as the schema it expects, the local stack (scripts/docker-up.ts)
// checks them before the Supabase CLI applies them, and Danger (dangerfile.ts)
// checks the ones a pull request adds. Each deciding for itself which files
// count would let a build expect a number the runner never applies, which holds
// every deploy out of service.
//
// ── One file per number ──────────────────────────────────────────────────────
// The ledger records a migration by its number (the Supabase CLI's `version`),
// not by its file name. Of two files with one number, the runner applies the
// first and skips the second as already applied, on every database, and reports
// success. Two branches that each took the next number merge without a git
// conflict, because the files have different names, so every reader refuses a
// number used twice and names the files and the next free number. Numbers
// compare as numbers, as the build and the sort compare them: 0012 and 12 are
// one number.
//
// Library only, with nothing beyond Node's own modules: dangerfile.ts loads it
// through Danger's compiler, and the registry generator before it has written
// anything.

import fs from "fs";
import path from "path";

/** `NNNN_name.sql`. Anything else in the directory is not a migration. */
const MIGRATION_FILE = /^(\d+)_(.+)\.sql$/;

export interface PlatformMigration {
  /** The file's numeric prefix, as written: the ledger's key. */
  version: string;
  name: string;
  /** As the caller gave it: a file name, or a path. */
  file: string;
}

/**
 * The migrations among `files` (file names or paths), in the order they apply.
 * Anything not named like one is left out.
 */
export function platformMigrations(files: readonly string[]): PlatformMigration[] {
  return files
    .map((file) => ({ file, m: MIGRATION_FILE.exec(path.basename(file)) }))
    .filter((x): x is { file: string; m: RegExpExecArray } => x.m !== null)
    .map(({ file, m }) => ({ version: m[1], name: m[2], file }))
    .sort((a, b) => Number(a.version) - Number(b.version) || a.file.localeCompare(b.file));
}

export interface DuplicateMigrationNumber {
  /** The number, as the first of its files writes it. */
  version: string;
  /** Every file that has it, in the order the runner would meet them. */
  files: string[];
}

/** Each number more than one of `files` has. Empty when every number has one file. */
export function duplicateMigrationNumbers(files: readonly string[]): DuplicateMigrationNumber[] {
  const byNumber = new Map<number, PlatformMigration[]>();
  // A file listed twice is still one file.
  for (const m of platformMigrations([...new Set(files)])) {
    const n = Number(m.version);
    byNumber.set(n, [...(byNumber.get(n) ?? []), m]);
  }
  return [...byNumber.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({ version: group[0].version, files: group.map((m) => m.file) }));
}

/**
 * The numbers the migrations a change adds (`added`) would share once they sit
 * beside the ones already there (`existing`). A number only `existing` repeats
 * is not the change's doing, and is left out.
 */
export function duplicatesAdded(
  added: readonly string[],
  existing: readonly string[],
): DuplicateMigrationNumber[] {
  const ours = new Set(added);
  return duplicateMigrationNumbers([...existing, ...added]).filter((d) =>
    d.files.some((f) => ours.has(f)),
  );
}

/**
 * The number the next migration takes: one past the highest among `files`,
 * zero-padded as wide as theirs (0011 after 0010).
 */
export function nextMigrationNumber(files: readonly string[]): string {
  const migrations = platformMigrations(files);
  if (migrations.length === 0) return "0001";
  const highest = Math.max(...migrations.map((m) => Number(m.version)));
  const width = Math.max(...migrations.map((m) => m.version.length));
  return String(highest + 1).padStart(width, "0");
}

function joinAnd(items: readonly string[]): string {
  return items.length <= 2
    ? items.join(" and ")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * What the runner and the generator say about `duplicates`: the files that
 * share each number, why that is refused, and the number to move to.
 */
export function describeDuplicateMigrations(
  duplicates: readonly DuplicateMigrationNumber[],
  next: string,
): string {
  const shared =
    duplicates.length === 1
      ? [`Platform migrations share the number ${duplicates[0].version}: ${joinAnd(duplicates[0].files)}.`]
      : [
          "Platform migrations share numbers:",
          ...duplicates.map((d) => `  ${d.version}: ${joinAnd(d.files)}`),
        ];
  // Of each number's files, one can keep it.
  const toMove = duplicates.reduce((n, d) => n + d.files.length - 1, 0);
  return [
    ...shared,
    "The ledger records a migration by its number, so a database would apply one file per " +
      "number and skip the rest as already applied. Nothing is applied while two files share a number.",
    toMove === 1
      ? `Renumber the one your branch added to ${next}, the next free number, and set ` +
        `platform_schema_version to '${Number(next)}' in it.`
      : `Renumber the ones your branch added from ${next}, the next free number, and set ` +
        `platform_schema_version in each to its new number.`,
  ].join("\n");
}

/**
 * The platform migrations in `dir`, in the order they apply. Throws when two
 * files share a number, naming them and the next free number.
 */
export function listPlatformMigrations(dir: string): PlatformMigration[] {
  if (!fs.existsSync(dir)) {
    throw new Error(`No platform migrations at ${dir}.`);
  }
  const files = fs.readdirSync(dir);
  const duplicates = duplicateMigrationNumbers(files);
  if (duplicates.length > 0) {
    throw new Error(describeDuplicateMigrations(duplicates, nextMigrationNumber(files)));
  }
  return platformMigrations(files);
}
