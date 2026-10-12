/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Updating an extension installed from a Registry: which way an update goes,
 * what changed in its folder since it was installed, and what the release it
 * goes to changes. Rules and comparisons, with no network. The update dialog's
 * server work (./update-admin.ts) downloads what they compare, and install's
 * update mode (./install.ts) applies the rules again under its locks.
 *
 * ── WHAT AN UPDATE IS ───────────────────────────────────────────────────────
 *
 * Another release of an app or a connector installed from this instance's
 * catalogue, for the same folder. Install downloads, verifies and checks it as
 * it does any release, and leaves it in `.mixos/pending/` with a sidecar that
 * records what it replaces (./pending.ts). Register is what will put it in
 * place, with a backup of the folder it replaces. Until it can, Register
 * refuses a pending update, and Discard deletes one.
 *
 * ── WHICH WAY ───────────────────────────────────────────────────────────────
 *
 * From the versions when both are dotted, in semver's order. Otherwise from
 * the dates the catalogue published the two releases: a release published from
 * mixos.org's website is named by its short commit, which says nothing about
 * order. A publisher who withdraws newer releases can make the catalogue's
 * current release an older one, so "the current release" isn't always
 * forward. An older release, or one whose order can't be told, needs the admin
 * to choose "Install an older release".
 *
 * ── WHAT CHANGED LOCALLY ────────────────────────────────────────────────────
 *
 * Whether the folder changed needs no download: its files hash, against its
 * record's (folderFilesHash() in ./install-record.ts). Which files changed
 * does: the installed release as install wrote it, against the folder. Not
 * counted: the install record itself, file modes, a manifest whose only change
 * is `lastUpdated`, and the git control files install leaves out
 * (./left-out.ts).
 */

import fs from "node:fs";
import path from "node:path";
import { compareReleaseVersions, parseReleaseVersion, parseVersion } from "../platform/version-floor";
import { contentHashesMatch } from "./content-hash";
import { FolderReadError, INSTALL_RECORD_FILE, folderFilesHash, type InstallRecord } from "./install-record";
import { isLeftOutName } from "./left-out";
import type { PendingKind, UpdateDirection } from "./pending";
import { MAX_LINE_CHARS, declaredValues, shownText } from "./review";
import type { TarEntry } from "./tar";
import { isDotted } from "./updates";

export type { UpdateDirection } from "./pending";

/** Each list of names, cut to this many and how many more. */
export const MAX_LISTED = 50;

/** Where a walk of a folder stops: install's archive limits keep a real package well inside it. */
const MAX_WALKED = 20_000;

/** The manifest each kind that can be updated is read from. */
const MANIFEST_FILE: Record<PendingKind, string> = { app: "app.json", connector: "connector.json" };

/* -------------------------------------------------------------------------- */
/*  Which way                                                                  */
/* -------------------------------------------------------------------------- */

/** A release, as the direction of an update is worked out from it. */
export interface ReleaseRef {
  version: string;
  commitSha: string;
  /** When the catalogue says it was published, or null when that isn't known. */
  releasedAt: string | null;
}

/**
 * -1, 0 or 1: semver's order of two dotted versions, a prerelease before the
 * release it leads to, and build metadata ignored. A version semver doesn't
 * read in full (`1.2`, `01.2.0`) goes by its numbers alone, as the notices
 * compare them (./updates.ts).
 */
export function compareDottedVersions(a: string, b: string): number {
  const full = (v: string) => parseReleaseVersion(v.replace(/\+.*$/, ""));
  const x = full(a);
  const y = full(b);
  if (x && y) return compareReleaseVersions(x, y);
  const p = parseVersion(a);
  const q = parseVersion(b);
  if (!p || !q) return 0;
  for (const part of ["major", "minor", "patch"] as const) {
    if (p[part] !== q[part]) return p[part] < q[part] ? -1 : 1;
  }
  return 0;
}

/**
 * Which way an update from the installed release, `from`, to `to` goes. The
 * same commit is the same release. Two dotted versions that differ decide it;
 * otherwise the dates do, when the catalogue gave both and they differ. Failing
 * both, it is `unknown`.
 */
export function updateDirection(from: ReleaseRef, to: ReleaseRef): UpdateDirection {
  if (from.commitSha === to.commitSha) return "same";
  if (isDotted(from.version) && isDotted(to.version)) {
    const order = compareDottedVersions(from.version, to.version);
    if (order !== 0) return order < 0 ? "newer" : "older";
  }
  const was = from.releasedAt ? Date.parse(from.releasedAt) : Number.NaN;
  const now = to.releasedAt ? Date.parse(to.releasedAt) : Number.NaN;
  if (Number.isFinite(was) && Number.isFinite(now) && was !== now) return now > was ? "newer" : "older";
  return "unknown";
}

/** Whether an update that way needs the admin to choose "Install an older release". */
export function needsOlderConsent(direction: UpdateDirection): boolean {
  return direction === "older" || direction === "unknown";
}

/* -------------------------------------------------------------------------- */
/*  What changed locally                                                       */
/* -------------------------------------------------------------------------- */

/** A difference an update finds but doesn't list, because it doesn't change what runs. */
export type IgnoredChange =
  /** The manifest differs only in `lastUpdated`, which the pre-commit stamp writes. */
  | "lastUpdated"
  /** A `.gitignore` or `.gitattributes`, which install never writes. */
  | "git-files";

/** The files of a folder that differ from the release it was installed from. */
export interface LocalChangeList {
  /** In both, with different contents. A link in a file's place counts. */
  changed: string[];
  /** In the folder and not in the release. */
  added: string[];
  /** In the release and not in the folder. */
  removed: string[];
  /** How many more of each there are than the lists name. */
  more: { changed: number; added: number; removed: number };
  /** Differences found and not listed. */
  ignored: IgnoredChange[];
  /** The folder held more than a walk reads, so the lists may be short. */
  incomplete: boolean;
}

/** What an update says about the folder it replaces. */
export type LocalChanges =
  /** Its files match its install record. */
  | { state: "none" }
  /** They don't, and these are the files, against the installed release. */
  | ({ state: "listed" } & LocalChangeList)
  /** They don't, and the installed release couldn't be had to say which: why. */
  | { state: "unlisted"; reason: string };

/**
 * Whether the folder `dir` still matches its install record, from its files
 * hash alone, with nothing downloaded; and that hash, or null when the folder
 * holds something no files hash covers, such as a link, which install never
 * writes.
 */
export function folderState(dir: string, record: Pick<InstallRecord, "filesHash">): {
  modified: boolean;
  folderHash: string | null;
} {
  try {
    const folderHash = folderFilesHash(dir);
    return { modified: !contentHashesMatch(folderHash, record.filesHash), folderHash };
  } catch (err) {
    if (err instanceof FolderReadError) return { modified: true, folderHash: null };
    throw err;
  }
}

/** A list sorted, then cut to MAX_LISTED, with how many it left out. */
function cut(list: string[]): { names: string[]; more: number } {
  const sorted = [...list].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { names: sorted.slice(0, MAX_LISTED), more: Math.max(0, sorted.length - MAX_LISTED) };
}

/**
 * What differs between the folder `dir` and the installed release's files,
 * `release`, as install wrote them: the archive with what it leaves out
 * already left out (leaveOut() in ./install.ts). Reads the folder, never
 * through a link.
 */
export function localChangesBetween(dir: string, kind: PendingKind, release: readonly TarEntry[]): LocalChangeList {
  const expected = new Map(release.map((e) => [e.path, e.data]));
  const seen = new Set<string>();
  const changed: string[] = [];
  const added: string[] = [];
  const ignored = new Set<IgnoredChange>();
  let walked = 0;
  let incomplete = false;

  const walk = (relative: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(/* turbopackIgnore: true */ dir, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (++walked > MAX_WALKED) {
        incomplete = true;
        return;
      }
      // POSIX separators, as the archive's paths have.
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (rel === INSTALL_RECORD_FILE) continue;
      if (entry.isDirectory()) {
        walk(rel);
        if (incomplete) return;
        continue;
      }
      if (entry.isFile() && isLeftOutName(entry.name)) {
        ignored.add("git-files");
        continue;
      }
      seen.add(rel);
      const was = expected.get(rel);
      if (was === undefined) {
        added.push(rel);
        continue;
      }
      const full = path.join(/* turbopackIgnore: true */ dir, rel);
      // A file of another size has changed, without reading it; but the
      // manifest is read whatever its size, since the stamp's rewrite of
      // `lastUpdated` can change its layout.
      const manifest = rel === MANIFEST_FILE[kind];
      const now = entry.isFile()
        ? readRegular(full, (size) => (manifest ? size <= MAX_MANIFEST_BYTES : size === was.length))
        : null;
      if (now !== null && now.equals(was)) continue;
      if (now !== null && manifest && onlyLastUpdated(was, now)) {
        ignored.add("lastUpdated");
        continue;
      }
      changed.push(rel);
    }
  };
  walk("");

  const removed = incomplete ? [] : [...expected.keys()].filter((p) => !seen.has(p));
  const c = cut(changed);
  const a = cut(added);
  const r = cut(removed);
  return {
    changed: c.names,
    added: a.names,
    removed: r.names,
    more: { changed: c.more, added: a.more, removed: r.more },
    ignored: (["lastUpdated", "git-files"] as const).filter((i) => ignored.has(i)),
    incomplete,
  };
}

/** The largest manifest compared by content. The schema keeps a real one far smaller. */
const MAX_MANIFEST_BYTES = 1024 * 1024;

/**
 * A file's bytes when it is a regular file whose size `wanted` accepts, read
 * without following a link; null when it isn't, or the size isn't wanted.
 */
function readRegular(full: string, wanted: (size: number) => boolean): Buffer | null {
  let fd: number;
  try {
    fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || !wanted(stat.size)) return null;
    return fs.readFileSync(fd);
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** A JSON object's text, as an object, or null. */
function jsonObject(bytes: Buffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A JSON value with every object's keys in order, so two spellings of one value compare equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Whether two manifests' texts are the same value but for `lastUpdated`, however each is laid out. */
export function onlyLastUpdated(before: Buffer, after: Buffer): boolean {
  const a = jsonObject(before);
  const b = jsonObject(after);
  if (!a || !b) return false;
  delete a.lastUpdated;
  delete b.lastUpdated;
  return canonical(a) === canonical(b);
}

/* -------------------------------------------------------------------------- */
/*  What the release it goes to changes                                        */
/* -------------------------------------------------------------------------- */

/** One thing a manifest declares, and what an update adds to it and drops from it. */
export interface DeclarationChange {
  /** "Egress", "Env", "Hosts it reaches"…, as the review before Register labels them. */
  label: string;
  added: string[];
  removed: string[];
}

/**
 * What each declaration gains and loses from the manifest `before` to the
 * manifest `after`, by the rows the review before Register shows (declaredBy()
 * in ./review.ts): egress, env, database, connectors, services, hooks and MCP
 * tools for an app, and for a connector the hosts it reaches, its credentials,
 * per-user accounts and webhooks. Only the rows that change, each list cut to
 * MAX_LISTED and then "and N more".
 */
export function compareDeclarations(
  kind: PendingKind,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): DeclarationChange[] {
  const was = declaredValues(kind, before);
  const now = declaredValues(kind, after);
  const listed = (values: string[]) => {
    const { names, more } = cut(values);
    return more > 0 ? [...names, `and ${more} more`] : names;
  };
  return now
    .map((row, i) => {
      const old = new Set(was[i].values);
      const kept = new Set(row.values);
      return {
        label: row.label,
        added: listed(row.values.filter((v) => !old.has(v))),
        removed: listed(was[i].values.filter((v) => !kept.has(v))),
      };
    })
    .filter((row) => row.added.length > 0 || row.removed.length > 0);
}

/** A permission as the publisher states it on the catalogue, made fit to show. */
export interface Claim {
  scope: string;
  reason: string;
}

export interface ClaimChanges {
  /** Scopes the release it goes to claims and the installed one doesn't. */
  added: Claim[];
  /** Scopes the installed release claims and the one it goes to doesn't. */
  removed: Claim[];
  /** Scopes both claim, with the reason the release it goes to gives now. */
  changed: Claim[];
}

/** The publisher's claims, in the catalogue's words, as text fit to show: one per scope. */
export function shownClaims(permissions: readonly { scope: string; reason: string }[]): Claim[] {
  const out = new Map<string, Claim>();
  for (const p of permissions) {
    const scope = shownText(p.scope);
    if (scope && !out.has(scope)) out.set(scope, { scope, reason: shownText(p.reason, MAX_LINE_CHARS) });
  }
  return [...out.values()];
}

/** How the publisher's claims change from one release to another, by scope. */
export function compareClaims(before: readonly Claim[], after: readonly Claim[]): ClaimChanges {
  const was = new Map(before.map((c) => [c.scope, c.reason]));
  const now = new Set(after.map((c) => c.scope));
  return {
    added: after.filter((c) => !was.has(c.scope)),
    removed: before.filter((c) => !now.has(c.scope)),
    changed: after.filter((c) => was.has(c.scope) && was.get(c.scope) !== c.reason),
  };
}

/** How an app's `migrations/*.sql` change from the folder to the release it goes to, by file name. */
export interface MigrationChanges {
  /** In the release and not in the folder: the release step applies them, once each. */
  added: string[];
  /** In both, with different contents. A database that ran one keeps what it did. */
  changed: string[];
  /** In the folder and not in the release. A database that ran one keeps what it did. */
  lacking: string[];
}

/** The largest migration file this compares by content; a larger one counts as changed. */
const MAX_MIGRATION_BYTES = 16 * 1024 * 1024;

const MIGRATION = /^migrations\/[^/]+\.sql$/;

/** An app's `migrations/*.sql`, by file name, from a release's files. */
export function releaseMigrations(entries: readonly TarEntry[]): Map<string, Buffer> {
  return new Map(entries.filter((e) => MIGRATION.test(e.path)).map((e) => [e.path.slice("migrations/".length), e.data]));
}

/**
 * The same, from an app's folder: the regular files directly in `migrations/`
 * whose names end `.sql`, as the release step reads them
 * (scripts/app-migration-files.ts). A file too large to compare has no bytes.
 */
export function folderMigrations(dir: string): Map<string, Buffer | null> {
  const out = new Map<string, Buffer | null>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(/* turbopackIgnore: true */ dir, "migrations"), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".sql")) continue;
    const full = path.join(/* turbopackIgnore: true */ dir, "migrations", entry.name);
    let size = 0;
    try {
      size = fs.lstatSync(full).size;
    } catch {
      continue;
    }
    out.set(entry.name, readRegular(full, (found) => found === size && found <= MAX_MIGRATION_BYTES));
  }
  return out;
}

/** What an update does to an app's migrations. Each list sorted, and in full: a migration is worth naming. */
export function compareMigrations(
  before: ReadonlyMap<string, Buffer | null>,
  after: ReadonlyMap<string, Buffer>,
): MigrationChanges {
  const sorted = (names: string[]) => names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    added: sorted([...after.keys()].filter((name) => !before.has(name))),
    changed: sorted(
      [...after.entries()]
        .filter(([name, data]) => {
          if (!before.has(name)) return false;
          const was = before.get(name);
          return !was || !was.equals(data);
        })
        .map(([name]) => name),
    ),
    lacking: sorted([...before.keys()].filter((name) => !after.has(name))),
  };
}

/** A release's manifest, from its files, as a JSON object, or null. */
export function releaseManifest(entries: readonly TarEntry[], kind: PendingKind): Record<string, unknown> | null {
  const entry = entries.find((e) => e.path === MANIFEST_FILE[kind]);
  return entry ? jsonObject(entry.data) : null;
}
