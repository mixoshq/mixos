/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The content hash: what makes a download from GitHub trustworthy.
 *
 * mixos.org resolves a git tag to a commit ONCE, at publish time, and records
 * what that tree hashed to. An install fetches the commit and recomputes the
 * hash. A moved tag then changes nothing for anyone, and a tampered or
 * truncated download fails here instead of succeeding quietly.
 *
 * ══ THIS DEFINITION IS THE CONTRACT ═════════════════════════════════════════
 *
 * mixos.org's spec names the FORMAT (`sha256-<base64>` of "the published file
 * tree") but not the algorithm that turns a tree into bytes. Two ends that
 * agree on the format and disagree on the serialisation produce a mismatch on
 * every honest package, which is indistinguishable from an attack and would
 * make the check useless in exactly the way that gets it disabled.
 *
 * So the serialisation is written down here, exactly, and mixos.org's publish
 * path must implement the same one. It is versioned by a domain-separation
 * prefix: a future change is a new prefix and a new field, never a silent
 * reinterpretation of the same string.
 *
 *   H = SHA-256 over, in order:
 *
 *     "mixos-tree-v1\n"                        the domain prefix
 *     then, for each regular file, sorted by   sorting is by UTF-8 BYTES of the
 *     path ascending:                          path, not by locale
 *         <mode> " " <path> "\0"               mode is "755" or "644"
 *         <byte length in decimal> "\0"
 *         <the file's bytes>
 *
 *   The result is base64-encoded and prefixed with "sha256-".
 *
 * ── THE CHOICES, AND WHY ────────────────────────────────────────────────────
 *
 * **Paths are included, not just contents.** A hash over concatenated file
 * bytes alone is identical for a tree where two files have swapped names —
 * which for an extension means swapping, say, a page and its API route.
 *
 * **Lengths are included.** Without them the boundary between one file's bytes
 * and the next path is guessable, and two different trees can be made to
 * serialise identically. The length before the bytes is what makes the encoding
 * unambiguous.
 *
 * **Mode is reduced to one bit.** Only the executable bit is recorded, as 755
 * or 644, because that is the only permission distinction a git tree carries.
 * Hashing the full mode would make the hash depend on the umask of whoever
 * built the tarball.
 *
 * **Only regular files.** Directories are implied by the paths inside them, and
 * empty directories carry nothing installable. Symlinks never reach here at all
 * — `tar.ts` rejects the archive outright.
 *
 * **`subpath` roots the tree.** For a monorepo, what was published is the
 * subdirectory, and paths are relative to IT. Hashing the whole repository
 * instead would give every listing in a monorepo the same hash, and would
 * invalidate a release because an unrelated sibling changed.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { TarEntry } from "./tar";

/** Domain separation, and the version of this serialisation. */
const TREE_PREFIX = "mixos-tree-v1\n";

export const CONTENT_HASH_ALGORITHM = "sha256";

/**
 * Serialise and hash a tree.
 *
 * `entries` must already be rooted at the extension — see `rootAt` in
 * `fetch-source.ts`, which applies `subpath` before this is called.
 */
export function hashFileTree(entries: TarEntry[]): string {
  const sorted = [...entries].sort((a, b) =>
    Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")),
  );

  // Duplicate paths would make the serialisation depend on the archive's entry
  // order, which is the ambiguity the length prefixes exist to remove.
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].path === sorted[i - 1].path) {
      throw new Error(
        `The archive contains "${sorted[i].path}" more than once.`,
      );
    }
  }

  const hash = createHash(CONTENT_HASH_ALGORITHM);
  hash.update(TREE_PREFIX, "utf8");
  for (const entry of sorted) {
    // 0o111 is any execute bit. Git records exactly two file modes, and this
    // collapses everything else onto them.
    const mode = entry.mode & 0o111 ? "755" : "644";
    hash.update(`${mode} ${entry.path}\0${entry.data.length}\0`, "utf8");
    hash.update(entry.data);
  }
  return `sha256-${hash.digest("base64")}`;
}

/**
 * Compare two `sha256-<base64>` hashes without leaking where they diverge.
 *
 * A plain `===` on a digest is a textbook timing side channel. It is a weak one
 * here — an attacker who could iterate would still have to produce a preimage —
 * but a constant-time compare costs nothing and removes the need to argue about
 * how weak.
 */
export function contentHashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export class ContentHashMismatch extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      "The downloaded package does not match the checksum the repository " +
        `published. Expected ${expected}, got ${actual}. Nothing was installed.`,
    );
    this.name = "ContentHashMismatch";
  }
}

/**
 * The gate. Throws on mismatch, and callers must not catch it to continue —
 * an unverified download makes every other step here pointless.
 */
export function verifyContentHash(entries: TarEntry[], expected: string): string {
  const actual = hashFileTree(entries);
  if (!contentHashesMatch(actual, expected)) {
    throw new ContentHashMismatch(expected, actual);
  }
  return actual;
}

/**
 * The files hash: the same serialisation over the same entries, with every
 * file's mode read as 644.
 *
 * Install writes every file 0644, so the content hash, which records the
 * execute bit, can't be recomputed from a folder on disk. This one can. Install
 * records it for a tree it has verified, and Register recomputes it from the
 * folder waiting in `.mixos/pending/` and refuses one that no longer matches
 * (./pending.ts). For a tree with no executable file it equals the content
 * hash.
 */
export function filesHash(entries: readonly TarEntry[]): string {
  return hashFileTree(entries.map((entry) => ({ ...entry, mode: 0o644 })));
}
