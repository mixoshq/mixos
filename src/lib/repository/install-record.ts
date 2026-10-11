/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The install record: `.registry.json` at the root of an extension installed
 * from a Registry, saying where it came from and what was verified.
 *
 *   {
 *     "source": "https://mixos.org",        the catalogue, repositoryBaseUrl()
 *     "kind": "app",
 *     "slug": "files",
 *     "version": "1.2.0",                   dotted, or a short commit SHA
 *     "gitTag": "v1.2.0",                   null for a release with no tag
 *     "commitSha": "<40 hex>",
 *     "contentHash": "sha256-…",            as published, and verified
 *     "filesHash": "sha256-…",              the files written, modes ignored
 *     "repository": { "owner": "acme", "name": "mixos-files", "subpath": null },
 *     "requiresMixOS": "0.4.0"
 *   }
 *
 * Install writes it into the tree it stages, after the download is verified and
 * pre-flight has passed (./install.ts), so it waits in `.mixos/pending/` with
 * the extension and moves into `apps/` or `connectors/` at Register. A theme,
 * which registers as it installs, gets it in `themes/<slug>/`. It is committed
 * with the folder. The registry generator reads it on every run and writes
 * what it finds to `src/generated/registry-installs.ts`, the only copy a
 * deployment reads.
 *
 * ── WHAT IS IN IT, AND WHAT ISN'T ───────────────────────────────────────────
 *
 * Every value is one install verified or chose, and each is validated here, so
 * code that builds text from a record (a commit message, a link) builds it
 * only from identifiers. `repository` comes from the download URL that was
 * verified, not from the listing. There is no install date and no admin: the
 * file is committed, and the commit and the audit row say when and who.
 *
 * ── filesHash ───────────────────────────────────────────────────────────────
 *
 * The content hash records each file's execute bit, as a git tree does, and
 * covers the package as published. Install writes every file 0644 and leaves
 * out any `.gitignore` or `.gitattributes` (./left-out.ts), so a folder on disk
 * can't reproduce it. The files hash is the content hash's serialisation over
 * the files install wrote, with every mode read as 644 (filesHash() in
 * ./content-hash.ts), and it can be recomputed from the folder:
 * folderFilesHash() below, which counts every file but the record itself.
 * Register refuses a pending folder that no longer matches, and the generator
 * marks a registered one `modified`.
 *
 * It checks for change after install, by an editor, a tool or another process
 * in the checkout. It is not a signature: anyone who can write the folder can
 * write the record too. A publisher can't ship one, though: pre-flight refuses
 * a package holding a file of this name at any depth.
 *
 * Library only, with no import a script can't load: the generator and the
 * pre-commit stamp read records too.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { filesHash } from "./content-hash";
import type { TarEntry } from "./tar";
import {
  CONTENT_HASH_PATTERN,
  CommitShaSchema,
  ExtensionKindSchema,
  KIND_SEGMENT,
  SlugSchema,
  type ExtensionKind,
} from "./types";

/** The record's file name, at the root of the extension's folder. */
export const INSTALL_RECORD_FILE = ".registry.json";

/** The largest record this reads. A real one is well under a kilobyte. */
const MAX_RECORD_BYTES = 64 * 1024;

/* -------------------------------------------------------------------------- */
/*  What each field may hold                                                   */
/* -------------------------------------------------------------------------- */

/** GitHub's own rules for an account and a repository name. */
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_REPO = /^[A-Za-z0-9._-]{1,100}$/;

/** Semantic versioning 2.0, as mixos.org reads a release's tag. */
const DOTTED_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** A release published from the website is named by its commit, abbreviated. */
const HEX_VERSION = /^[0-9a-f]{7,40}$/;

/**
 * A version as a record holds one: dotted, or the hex of a commit. The update
 * check holds the catalogue's latest version to the same rule (./updates.ts):
 * a release named any other way is one install would refuse to record.
 */
export function isRecordedVersion(version: string): boolean {
  return version.length <= 128 && (DOTTED_VERSION.test(version) || HEX_VERSION.test(version));
}

/** A tag as mixos.org accepts one at publish (its `isValidTagName()`). */
function isTagName(tag: string): boolean {
  if (!tag || tag.length > 128) return false;
  if (!/^[A-Za-z0-9._\-/@+]+$/.test(tag)) return false;
  if (tag.startsWith("/") || tag.endsWith("/") || tag.endsWith(".")) return false;
  if (tag.includes("..") || tag.includes("//") || tag.endsWith(".lock")) return false;
  return tag.split("/").every((segment) => segment !== "" && !segment.startsWith("."));
}

/** A folder inside a repository, as mixos.org accepts one: no `.`, `..` or empty segment. */
function isSubpath(subpath: string): boolean {
  if (subpath.length > 256 || !/^[A-Za-z0-9._\-/]+$/.test(subpath)) return false;
  return subpath.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** An origin, as repositoryBaseUrl() returns one: a scheme, a host and a port, nothing more. */
function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value;
  } catch {
    return false;
  }
}

const HashSchema = z.string().regex(CONTENT_HASH_PATTERN, "expected a sha256- hash");

export const RecordedRepositorySchema = z.strictObject({
  owner: z.string().regex(GITHUB_OWNER, "expected a GitHub account name"),
  name: z
    .string()
    .regex(GITHUB_REPO, "expected a GitHub repository name")
    .refine((name) => !/^\.+$/.test(name), "expected a GitHub repository name"),
  /** The extension's folder in the repository, or null for its root. */
  subpath: z.string().refine(isSubpath, "expected a folder in the repository").nullable(),
});
export type RecordedRepository = z.infer<typeof RecordedRepositorySchema>;

export const InstallRecordSchema = z.strictObject({
  /** The catalogue it came from: repositoryBaseUrl() when it was installed. */
  source: z.string().max(256).refine(isOrigin, "expected an origin, such as https://mixos.org"),
  kind: ExtensionKindSchema,
  slug: SlugSchema,
  version: z.string().refine(isRecordedVersion, "expected a dotted version or a commit's hex"),
  gitTag: z.string().refine(isTagName, "expected a git tag").nullable(),
  commitSha: CommitShaSchema,
  contentHash: HashSchema,
  filesHash: HashSchema,
  repository: RecordedRepositorySchema,
  /** The release's declared floor, as the catalogue gave it. Printable ASCII. */
  requiresMixOS: z
    .string()
    .regex(/^[\x21-\x7e](?:[\x20-\x7e]{0,62}[\x21-\x7e])?$/, "expected a version floor")
    .nullable(),
});
export type InstallRecord = z.infer<typeof InstallRecordSchema>;

/**
 * One extension in this build installed from a Registry, as the generator
 * writes it to `src/generated/registry-installs.ts`: its record, less the
 * hashes, and whether its folder still matches it.
 */
export interface RegistryInstall {
  kind: ExtensionKind;
  slug: string;
  version: string;
  gitTag: string | null;
  commitSha: string;
  source: string;
  repository: RecordedRepository;
  requiresMixOS: string | null;
  /** True when the folder's files no longer match the record's files hash. */
  modified: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Writing and reading                                                        */
/* -------------------------------------------------------------------------- */

/** A record as file text: validated, its keys in one order, two-space indent. */
export function serializeInstallRecord(record: InstallRecord): string {
  const r = InstallRecordSchema.parse(record);
  const ordered: InstallRecord = {
    source: r.source,
    kind: r.kind,
    slug: r.slug,
    version: r.version,
    gitTag: r.gitTag,
    commitSha: r.commitSha,
    contentHash: r.contentHash,
    filesHash: r.filesHash,
    repository: { owner: r.repository.owner, name: r.repository.name, subpath: r.repository.subpath },
    requiresMixOS: r.requiresMixOS,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** The record as the entry install adds to the tree it stages. */
export function installRecordEntry(record: InstallRecord): TarEntry {
  return { path: INSTALL_RECORD_FILE, mode: 0o644, data: Buffer.from(serializeInstallRecord(record), "utf8") };
}

/** Why a record's text isn't one, in a phrase, or the record. */
export function parseInstallRecord(text: string): { ok: true; record: InstallRecord } | { ok: false; reason: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "it is not JSON" };
  }
  const parsed = InstallRecordSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".");
    return { ok: false, reason: `${where ? `${where}: ` : ""}${issue?.message ?? "not an install record"}` };
  }
  return { ok: true, record: parsed.data };
}

export type RecordRead =
  | { state: "missing" }
  | { state: "invalid"; reason: string }
  | { state: "ok"; record: InstallRecord };

/**
 * The record at the root of the extension folder `dir`. Read as a regular file
 * and never through a link: a record is a file install wrote.
 *
 * `dir` is a runtime path in a checkout, so the join is marked for Turbopack's
 * tracer to leave alone (see ./pending.ts).
 */
export function readInstallRecord(dir: string): RecordRead {
  let text: string;
  try {
    const fd = fs.openSync(
      path.join(/* turbopackIgnore: true */ dir, INSTALL_RECORD_FILE),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) return { state: "invalid", reason: "it is not a regular file" };
      if (stat.size > MAX_RECORD_BYTES) return { state: "invalid", reason: "it is too large to be one install wrote" };
      text = fs.readFileSync(fd, "utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { state: "missing" };
    return { state: "invalid", reason: code === "ELOOP" ? "it is a link" : String(code ?? err) };
  }
  const parsed = parseInstallRecord(text);
  return parsed.ok ? { state: "ok", record: parsed.record } : { state: "invalid", reason: parsed.reason };
}

/** Why a record isn't the record of the `kind` named `slug`, or null when it is. */
export function recordMismatch(record: InstallRecord, kind: ExtensionKind, slug: string): string | null {
  if (record.kind === kind && record.slug === slug) return null;
  return `it records ${record.kind}/${record.slug}, not ${kind}/${slug}`;
}

/* -------------------------------------------------------------------------- */
/*  The folder                                                                 */
/* -------------------------------------------------------------------------- */

export class FolderReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FolderReadError";
  }
}

/** Where a folder walk stops: install's archive limits keep a real package well inside it. */
const MAX_WALKED = 20_000;

/**
 * The files hash of the extension folder `dir`, to compare with its record's:
 * every file at any depth, dot files and `node_modules/` included, since install
 * wrote all of them and any of them could run, except the record at its root.
 * Empty folders count for nothing, as they do in the content hash.
 *
 * Throws FolderReadError for a link or anything else that is not a file or a
 * folder: install writes neither, so the folder has changed.
 *
 * `skip`, given a file's full path, leaves that file out too. Only the
 * generator uses it, to say what a difference is; nothing compares a hash
 * computed with it against a record.
 */
export function folderFilesHash(dir: string, skip?: (full: string) => boolean): string {
  const entries: TarEntry[] = [];
  collect(dir, "", entries, skip);
  return filesHash(entries);
}

function collect(dir: string, relative: string, into: TarEntry[], skip?: (full: string) => boolean): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // POSIX separators, as the archive's paths have.
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (rel === INSTALL_RECORD_FILE) continue;
    const full = path.join(/* turbopackIgnore: true */ dir, entry.name);
    if (skip?.(full)) continue;
    if (entry.isDirectory()) {
      collect(full, rel, into, skip);
    } else if (entry.isFile()) {
      into.push({ path: rel, mode: 0o644, data: readRegularFile(full, rel) });
    } else {
      throw new FolderReadError(
        `${rel} is ${entry.isSymbolicLink() ? "a symbolic link" : "not a regular file"}, which install never writes.`,
      );
    }
  }
}

/** A file's bytes, never through a link put in its place since it was listed. */
function readRegularFile(full: string, rel: string): Buffer {
  let fd: number;
  try {
    fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    throw new FolderReadError(`${rel} could not be read: ${(err as NodeJS.ErrnoException).code ?? err}`);
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw new FolderReadError(`${rel} is not a regular file.`);
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** One file in a folder, for a person: its path in the folder and its size. */
export interface FolderFile {
  path: string;
  bytes: number;
}

/**
 * Every regular file under `dir`, the record included, sorted by path, with
 * its size. For showing what a commit of the folder adds; links and anything
 * else that isn't a file are left out.
 */
export function folderFiles(dir: string): FolderFile[] {
  const out: FolderFile[] = [];
  const walk = (relative: string) => {
    if (out.length >= MAX_WALKED) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(/* turbopackIgnore: true */ dir, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile()) {
        try {
          out.push({ path: rel, bytes: fs.lstatSync(path.join(/* turbopackIgnore: true */ dir, rel)).size });
        } catch {
          // Gone since it was listed.
        }
      }
      if (out.length >= MAX_WALKED) return;
    }
  };
  walk("");
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/* -------------------------------------------------------------------------- */
/*  Where it came from                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The GitHub repository a download URL names, from the three forms install
 * accepts (assertAllowedTarballUrl() in ./fetch-source.ts):
 *
 *   https://codeload.github.com/<owner>/<repo>/tar.gz/<commit>
 *   https://api.github.com/repos/<owner>/<repo>/tarball/<commit>
 *   https://github.com/<owner>/<repo>/archive/<commit>.tar.gz
 *
 * Null for anything else, or an owner or a name GitHub wouldn't accept.
 */
export function repositoryFromTarballUrl(raw: string): { owner: string; name: string } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const segments = url.pathname.split("/").filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return "";
    }
  });
  let found: [string | undefined, string | undefined] = [undefined, undefined];
  if (url.hostname === "codeload.github.com" && ["tar.gz", "legacy.tar.gz"].includes(segments[2] ?? "")) {
    found = [segments[0], segments[1]];
  } else if (url.hostname === "api.github.com" && segments[0] === "repos" && segments[3] === "tarball") {
    found = [segments[1], segments[2]];
  } else if (url.hostname === "github.com" && segments[2] === "archive") {
    found = [segments[0], segments[1]];
  }
  const repository = { owner: found[0] ?? "", name: found[1] ?? "", subpath: null };
  return RecordedRepositorySchema.safeParse(repository).success ? { owner: repository.owner, name: repository.name } : null;
}

/**
 * `https://github.com/<owner>/<repo>/tree/<commit>/<subpath>`: the files at the
 * commit install verified, which a moved tag or a new push can't change. Null
 * when the values don't make a link that can be trusted to mean that: an owner
 * or a name GitHub wouldn't accept, a commit that isn't one, or a subpath that
 * climbs.
 */
export function githubSourceUrl(
  repo: { owner: string; name: string },
  commitSha: string,
  subpath?: string | null,
): string | null {
  if (!GITHUB_OWNER.test(repo.owner) || !GITHUB_REPO.test(repo.name) || /^\.+$/.test(repo.name)) return null;
  if (!/^[0-9a-f]{40}$/.test(commitSha)) return null;
  const segments = (subpath ?? "").split("/").filter(Boolean);
  if (segments.some((s) => s === "." || s === "..")) return null;
  const rest = segments.map(encodeURIComponent).join("/");
  return `https://github.com/${repo.owner}/${repo.name}/tree/${commitSha}${rest ? `/${rest}` : ""}`;
}

/** The record's source on GitHub, at the commit install verified. */
export function recordSourceUrl(record: InstallRecord): string | null {
  return githubSourceUrl(record.repository, record.commitSha, record.repository.subpath);
}

/** The listing on the catalogue the record names: `<source>/extend/<kind segment>/<slug>`. */
export function recordListingUrl(record: Pick<InstallRecord, "source" | "kind" | "slug">): string {
  return `${record.source}/extend/${KIND_SEGMENT[record.kind]}/${record.slug}`;
}
