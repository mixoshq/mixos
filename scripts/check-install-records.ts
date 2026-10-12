/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every extension folder installed from a Registry still matches its install
 * record, `.registry.json` (src/lib/repository/install-record.ts): the record
 * reads as one and names its own folder, and the files hash recomputed from the
 * folder, the record left out, is the one install wrote.
 *
 *   npx tsx scripts/check-install-records.ts
 *
 * The pull-request check runs it (.github/workflows/extensions.yml), before any
 * extension's code runs there. It hashes the folders as git checked them out,
 * so a file the commit left out counts as a change, the same as an edit: either
 * way, what would deploy isn't what install verified. That includes a file the
 * repository's .gitignore keeps out (`*.pem`, `.npmrc`, `.env*`), which
 * `npm run register` warns about. A Docker build context wouldn't do here:
 * .dockerignore drops every `.DS_Store` and `node_modules`, and install hashed
 * whatever the package held.
 *
 * Folders the registry generator skips, with a leading `_` or `.`, are skipped
 * here too. A folder with no record is a local extension, and isn't checked.
 *
 * Exit code: 0 when every installed folder matches, 1 when any doesn't.
 */

import fs from "node:fs";
import path from "node:path";
import { contentHashesMatch } from "../src/lib/repository/content-hash";
import {
  FolderReadError,
  INSTALL_RECORD_FILE,
  folderFilesHash,
  readInstallRecord,
  recordMismatch,
  recordSourceUrl,
} from "../src/lib/repository/install-record";
import { sourceHost } from "../src/lib/repository/provenance";
import type { ExtensionKind } from "../src/lib/repository/types";

const KIND_DIRS: readonly { kind: ExtensionKind; dir: string }[] = [
  { kind: "app", dir: "apps" },
  { kind: "connector", dir: "connectors" },
  { kind: "theme", dir: "themes" },
];

export interface RecordProblem {
  /** Repo-relative: `apps/files`. */
  folder: string;
  /** What is wrong, in a sentence or two. */
  problem: string;
  /** How to fix it, one way per line. */
  fixes: string[];
}

export interface RecordCheck {
  /** Every folder with a record, matching or not, repo-relative. */
  checked: string[];
  problems: RecordProblem[];
}

/** The fixes for a record that can't be used as this folder's. */
function recordFixes(folder: string): string[] {
  return [
    "Install the extension again from the Registry, which writes a new record.",
    `Or delete ${folder}/${INSTALL_RECORD_FILE} to keep the folder as a local extension.`,
  ];
}

/** Check every installed folder under the checkout at `root`. */
export function checkInstallRecords(root: string): RecordCheck {
  const checked: string[] = [];
  const problems: RecordProblem[] = [];

  for (const { kind, dir } of KIND_DIRS) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
      const folder = `${dir}/${entry.name}`;
      const full = path.join(root, dir, entry.name);
      const read = readInstallRecord(full);
      if (read.state === "missing") continue;
      checked.push(folder);

      const file = `${folder}/${INSTALL_RECORD_FILE}`;
      if (read.state === "invalid") {
        problems.push({
          folder,
          problem: `${file} can't be read as an install record: ${read.reason}.`,
          fixes: recordFixes(folder),
        });
        continue;
      }
      const record = read.record;
      const mismatch = recordMismatch(record, kind, entry.name);
      if (mismatch) {
        problems.push({ folder, problem: `${file} isn't this folder's: ${mismatch}.`, fixes: recordFixes(folder) });
        continue;
      }

      let found: string | null = null;
      let why = "";
      try {
        found = folderFilesHash(full);
      } catch (err) {
        if (!(err instanceof FolderReadError)) throw err;
        why = ` ${err.message}`;
      }
      if (found !== null && contentHashesMatch(found, record.filesHash)) continue;

      const release = `${record.version} from ${sourceHost(record.source)}`;
      const source = recordSourceUrl(record);
      problems.push({
        folder,
        problem:
          `${folder}/ doesn't match its ${INSTALL_RECORD_FILE}.${why} Its files changed after ` +
          `${release} was installed, or one is missing from the commit.` +
          (source ? ` Compare it with the release: ${source}` : ""),
        fixes: [
          "Commit the missing file. Your .gitignore may keep it out: add it with `git add -f <file>`.",
          "Or install the release again, to undo an edit.",
          `Or delete ${file} to keep your changes as a local extension. The next release step on ` +
            "each instance then treats it as a different extension, so an app is switched off until " +
            "an admin types its slug.",
        ],
      });
    }
  }
  return { checked, problems };
}

/** What the command prints. */
export function formatRecordCheck(result: RecordCheck): string[] {
  const { checked, problems } = result;
  if (checked.length === 0) return ["No folder in apps/, connectors/ or themes/ was installed from a Registry."];
  if (problems.length === 0) {
    return [`${checked.length} installed folder(s) match their ${INSTALL_RECORD_FILE}: ${checked.join(", ")}.`];
  }
  const lines: string[] = [];
  for (const p of problems) {
    lines.push(p.problem);
    for (const fix of p.fixes) lines.push(`  ${fix}`);
    lines.push("");
  }
  lines.push(`${problems.length} of ${checked.length} installed folder(s) don't match their ${INSTALL_RECORD_FILE}.`);
  return lines;
}

if (require.main === module) {
  const result = checkInstallRecords(path.resolve(__dirname, ".."));
  const lines = formatRecordCheck(result);
  const write = result.problems.length > 0 ? console.error : console.log;
  for (const line of lines) write(line);
  process.exitCode = result.problems.length > 0 ? 1 : 0;
}
