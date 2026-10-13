/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Git's own object ids, worked out here, so a proposal can check that what
 * GitHub stored is the tree that was verified (./propose.ts).
 *
 * A blob's id is the SHA-1 of `blob <length>\0` and its bytes. A tree's is the
 * SHA-1 of `tree <length>\0` and its entries, each `<mode> <name>\0` and the
 * entry's id as 20 bytes, sorted by name as git sorts them: a folder as if its
 * name ended in `/`. Every file here is mode 100644, as install writes them.
 *
 * Nothing here trusts these ids for security: SHA-1 is git's choice. They
 * catch GitHub storing other bytes than were sent, such as text it re-encoded.
 */

import { createHash } from "node:crypto";

/** A file in a tree, by its path inside it. */
export interface GitFile {
  path: string;
  data: Buffer;
}

/** `git hash-object` of `data`. */
export function gitBlobSha(data: Buffer): string {
  return createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
}

/** A folder: each name holds a file's blob id, or a folder. */
type Folder = Map<string, string | Folder>;

/**
 * The id of the tree that holds `files`, every one mode 100644: what
 * `git write-tree` gives for a folder holding them. Throws for two files with
 * one path, or a file where a folder has to be.
 */
export function gitTreeSha(files: readonly GitFile[]): string {
  const root: Folder = new Map();
  for (const file of files) {
    const names = file.path.split("/");
    let folder = root;
    for (const name of names.slice(0, -1)) {
      let next = folder.get(name);
      if (next === undefined) {
        next = new Map();
        folder.set(name, next);
      }
      if (typeof next === "string") throw new Error(`${file.path}: a file is where a folder has to be.`);
      folder = next;
    }
    const name = names[names.length - 1];
    if (folder.has(name)) throw new Error(`${file.path} is in the tree twice.`);
    folder.set(name, gitBlobSha(file.data));
  }
  return writeTree(root);
}

function writeTree(folder: Folder): string {
  const entries = [...folder.entries()].map(([name, value]) =>
    typeof value === "string"
      ? { name, mode: "100644", id: value, sortAs: name }
      : { name, mode: "40000", id: writeTree(value), sortAs: `${name}/` },
  );
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.sortAs, "utf8"), Buffer.from(b.sortAs, "utf8")));
  const body = Buffer.concat(
    entries.flatMap((e) => [Buffer.from(`${e.mode} ${e.name}\0`, "utf8"), Buffer.from(e.id, "hex")]),
  );
  return createHash("sha1").update(`tree ${body.length}\0`).update(body).digest("hex");
}

/**
 * Whether `data` can go into a tree as text, in the `content` of a tree entry,
 * and come out byte for byte: UTF-8 that decodes and encodes back to itself,
 * with no NUL. Anything else is sent as a blob of its own, in base64.
 */
export function isInlineText(data: Buffer): boolean {
  if (data.includes(0)) return false;
  return Buffer.from(data.toString("utf8"), "utf8").equals(data);
}
