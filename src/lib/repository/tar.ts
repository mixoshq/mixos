/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A minimal, bounded tar reader — enough to read a GitHub source tarball, and
 * deliberately not more.
 *
 * ── WHY NOT SHELL OUT TO `tar` ──────────────────────────────────────────────
 *
 * Three reasons, in order of how much they matter:
 *
 * 1. **Nothing untrusted should reach the filesystem before it is verified.**
 *    Reading entries into memory means the content hash is computed from the
 *    archive itself and checked BEFORE a single byte is written to `apps/`.
 *    Extract-then-verify has a window where a tampered tree exists on disk, and
 *    a rollback path that has to be right for it not to matter.
 * 2. **The path rules are ours.** `tar` has its own defences against `..` and
 *    absolute paths, and they differ between GNU tar and bsdtar — the two this
 *    project actually runs on (bookworm-slim in Docker, macOS in development).
 *    Depending on a behaviour that varies by platform for a security property
 *    is how the property quietly stops holding on one of them.
 * 3. No external binary in the runtime image, and no argument-quoting surface.
 *
 * ── WHAT IT SUPPORTS ────────────────────────────────────────────────────────
 *
 * ustar and the two long-name extensions GitHub's tarballs actually use: pax
 * extended headers (typeflag `x`) and GNU long names (typeflag `L`). Repository
 * paths regularly exceed the 100-byte `name` field, so neither is optional.
 *
 * Everything that is not a regular file or a directory is REJECTED, not
 * skipped: symlinks and hard links can point outside the tree, and device
 * nodes have no business in an extension. Rejecting is louder than ignoring,
 * and an archive containing one is not an archive we want to install from.
 */

import zlib from "node:zlib";

const BLOCK = 512;

/** One regular file from the archive. Directories carry no bytes and are dropped. */
export interface TarEntry {
  /** POSIX-relative path, with the archive's single root directory stripped. */
  path: string;
  /** Permission bits only, masked to 0o7777. */
  mode: number;
  data: Buffer;
}

export interface TarLimits {
  /** Total uncompressed bytes. Also the gunzip output cap — the zip-bomb bound. */
  maxTotalBytes: number;
  /** Number of regular files. A tree with more than this is not an extension. */
  maxFiles: number;
  /** Any single file. */
  maxFileBytes: number;
}

export const DEFAULT_TAR_LIMITS: TarLimits = {
  // Generous for source: the largest thing an extension legitimately carries is
  // a font or a screenshot, and 64 MB of those is already well past plausible.
  maxTotalBytes: 64 * 1024 * 1024,
  maxFiles: 5_000,
  maxFileBytes: 16 * 1024 * 1024,
};

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

/**
 * Decompress a gzipped tarball with a hard cap on the OUTPUT size.
 *
 * `maxOutputLength` is the whole point of this function existing separately: a
 * few hundred kilobytes of gzip can decompress to gigabytes, and a plain
 * `gunzipSync` would happily produce all of them inside a request handler.
 */
export function gunzipBounded(gz: Buffer, maxOutputBytes: number): Buffer {
  try {
    return zlib.gunzipSync(gz, { maxOutputLength: maxOutputBytes });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Node reports the cap as ERR_BUFFER_TOO_LARGE / "buffer too large";
    // either way the honest description is the same.
    throw new ArchiveError(
      `Could not decompress the archive (limit ${maxOutputBytes} bytes): ${message}`,
    );
  }
}

/** Octal fields are NUL/space padded and may be empty. */
function readOctal(block: Buffer, offset: number, length: number): number {
  const raw = block
    .subarray(offset, offset + length)
    .toString("latin1")
    .replace(/\0.*$/, "")
    .trim();
  if (raw === "") return 0;
  const n = parseInt(raw, 8);
  if (!Number.isFinite(n) || n < 0) {
    throw new ArchiveError("The archive has a malformed header field.");
  }
  return n;
}

function readString(block: Buffer, offset: number, length: number): string {
  return block
    .subarray(offset, offset + length)
    .toString("utf8")
    .replace(/\0.*$/, "");
}

/**
 * A header block of all zero bytes marks the end of the archive. Two of them
 * is the formal terminator, but one is enough to stop on — everything after is
 * padding.
 */
function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < block.length; i++) if (block[i] !== 0) return false;
  return true;
}

/** Parse the `key=value` records of a pax extended header. */
function parsePax(data: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) break;
    const len = parseInt(data.subarray(at, space).toString("latin1"), 10);
    if (!Number.isFinite(len) || len <= 0 || at + len > data.length) break;
    const record = data.subarray(space + 1, at + len).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0) out.set(record.slice(0, eq), record.slice(eq + 1).replace(/\n$/, ""));
    at += len;
  }
  return out;
}

/**
 * A path is safe when it is relative, has no `.` or `..` segment, no empty
 * segment, no backslash, and no NUL.
 *
 * Checked on the archive's own path string rather than after joining it to a
 * directory. `path.resolve` normalises `a/../../b` into something that looks
 * fine relative to the wrong root, so the containment check has to happen
 * before any joining — and `install.ts` re-checks after joining as well.
 */
function assertSafePath(p: string): void {
  if (p === "" || p.startsWith("/") || /^[a-zA-Z]:/.test(p)) {
    throw new ArchiveError(`The archive contains an absolute path: ${p}`);
  }
  if (p.includes("\0") || p.includes("\\")) {
    throw new ArchiveError(`The archive contains an illegal path: ${p}`);
  }
  for (const segment of p.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new ArchiveError(`The archive contains a traversing path: ${p}`);
    }
  }
}

/**
 * Read every regular file out of an uncompressed tar.
 *
 * GitHub wraps a source tarball in a single top-level directory named
 * `<owner>-<repo>-<sha7>`. `stripRoot` removes exactly one leading segment, and
 * asserts that every entry shares it — an archive with two roots is not the
 * shape this is reading, and guessing which one to keep would be a choice made
 * on the attacker's behalf.
 */
export function readTar(
  tar: Buffer,
  { stripRoot = true, limits = DEFAULT_TAR_LIMITS }: { stripRoot?: boolean; limits?: TarLimits } = {},
): TarEntry[] {
  const entries: TarEntry[] = [];
  let root: string | null = null;
  let total = 0;
  let at = 0;

  // Carried from a pax `x` or GNU `L` header to the entry that follows it.
  let pendingPath: string | null = null;

  while (at + BLOCK <= tar.length) {
    const header = tar.subarray(at, at + BLOCK);
    at += BLOCK;
    if (isZeroBlock(header)) break;

    const size = readOctal(header, 124, 12);
    const typeflag = readString(header, 156, 1) || "0";
    const dataStart = at;
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    at += padded;
    if (dataStart + size > tar.length) {
      throw new ArchiveError("The archive is truncated.");
    }
    const data = tar.subarray(dataStart, dataStart + size);

    // Metadata entries: they name the NEXT entry rather than describing a file.
    if (typeflag === "x" || typeflag === "X") {
      pendingPath = parsePax(data).get("path") ?? pendingPath;
      continue;
    }
    if (typeflag === "L") {
      pendingPath = data.toString("utf8").replace(/\0.*$/, "");
      continue;
    }
    // A global pax header applies to the rest of the archive; nothing here
    // reads any of its fields, so it is genuinely skippable.
    if (typeflag === "g" || typeflag === "K") continue;

    const prefix = readString(header, 345, 155);
    const name = readString(header, 0, 100);
    const rawPath = pendingPath ?? (prefix ? `${prefix}/${name}` : name);
    pendingPath = null;

    // Directory entries are conventionally trailing-slashed; normalise before
    // the path check so the empty last segment is not read as a traversal.
    const normalized = rawPath.replace(/\/+$/, "");
    assertSafePath(normalized);

    if (typeflag !== "0" && typeflag !== "\0" && typeflag !== "5" && typeflag !== "7") {
      throw new ArchiveError(
        `The archive contains a ${describeType(typeflag)} (${normalized}). ` +
          `Only regular files and directories can be installed.`,
      );
    }

    let relative = normalized;
    if (stripRoot) {
      const slash = normalized.indexOf("/");
      const segment = slash < 0 ? normalized : normalized.slice(0, slash);
      root ??= segment;
      if (segment !== root) {
        throw new ArchiveError(
          `The archive has more than one top-level directory ("${root}" and "${segment}").`,
        );
      }
      if (slash < 0) continue; // the root directory entry itself
      relative = normalized.slice(slash + 1);
    }

    if (typeflag === "5") continue; // directories are implied by their files

    if (size > limits.maxFileBytes) {
      throw new ArchiveError(
        `${relative} is ${size} bytes, over the ${limits.maxFileBytes}-byte per-file limit.`,
      );
    }
    total += size;
    if (total > limits.maxTotalBytes) {
      throw new ArchiveError(
        `The archive exceeds the ${limits.maxTotalBytes}-byte total limit.`,
      );
    }
    if (entries.length >= limits.maxFiles) {
      throw new ArchiveError(
        `The archive contains more than ${limits.maxFiles} files.`,
      );
    }

    entries.push({
      path: relative,
      mode: readOctal(header, 100, 8) & 0o7777,
      // Copy: `subarray` is a view onto the whole decompressed archive, and
      // holding one keeps the entire buffer alive for as long as any entry does.
      data: Buffer.from(data),
    });
  }

  if (entries.length === 0) {
    throw new ArchiveError("The archive contains no files.");
  }
  return entries;
}

function describeType(typeflag: string): string {
  switch (typeflag) {
    case "1":
      return "hard link";
    case "2":
      return "symbolic link";
    case "3":
      return "character device";
    case "4":
      return "block device";
    case "6":
      return "FIFO";
    default:
      return `entry of unsupported type "${typeflag}"`;
  }
}
