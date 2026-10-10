/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The code hash: a fingerprint of the files in an app's folder, read from disk.
//
// The release step's registry sync (scripts/sync-app-registry.ts) records it
// for every app in the build, and keeps an app's row when the app leaves the
// build. When the slug comes back, this is how the sync tells the same app
// returning (a rollback, or a skip by the registry generator that ended) from
// different code under the same name: the first comes back as it left, the
// second comes back switched off until an admin activates it.
//
// THE SERIALISATION is the content hash's (src/lib/repository/content-hash.ts),
// over every file under apps/<slug>/, with three differences:
//
//   - Every file mode reads as 644. A mode change runs nothing different in an
//     app, and modes don't survive every copy alike (a checkout with
//     core.fileMode off, a build context, an image).
//   - Dot entries are left out, at any depth: editor and system litter
//     (.DS_Store) and files about the folder rather than the app.
//   - node_modules/ is left out, at any depth: it is installed, not written.
//
// Symlinks are followed, as the build follows them. A link back up the tree is
// read once rather than forever.
//
// The release step reads the same files on every host: a checkout and Vercel's
// build have the folder, and the image carries apps/** at the same paths
// (outputFileTracingIncludes in next.config.ts).
//
// Library only.

import fs from "fs";
import path from "path";
import { hashFileTree } from "../src/lib/repository/content-hash";
import type { TarEntry } from "../src/lib/repository/tar";

/** Directory names left out wherever they appear, besides dot entries. */
const SKIPPED_DIRECTORIES = new Set(["node_modules"]);

/**
 * The code hash of the app folder at `dir`, as `sha256-<base64>`, or null when
 * there is no folder there to read.
 */
export function appCodeHash(dir: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;

  const entries: TarEntry[] = [];
  collect(dir, "", [], entries);
  return hashFileTree(entries);
}

/**
 * Every file under `dir`, with paths relative to the app's folder. `above` is
 * the real path of each directory between the folder and `dir`, so a symlink
 * that points back up the tree ends the walk there.
 */
function collect(dir: string, relative: string, above: string[], into: TarEntry[]): void {
  const real = fs.realpathSync(dir);
  if (above.includes(real)) return;
  const trail = [...above, real];

  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(".") || SKIPPED_DIRECTORIES.has(name)) continue;
    const full = path.join(dir, name);
    // POSIX separators, so a Windows checkout hashes the same paths.
    const rel = relative ? `${relative}/${name}` : name;

    let stat: fs.Stats;
    try {
      // stat, not lstat: through a symlink to what it points at.
      stat = fs.statSync(full);
    } catch {
      continue; // a symlink to nothing
    }
    if (stat.isDirectory()) collect(full, rel, trail, into);
    else if (stat.isFile()) into.push({ path: rel, mode: 0o644, data: fs.readFileSync(full) });
  }
}
