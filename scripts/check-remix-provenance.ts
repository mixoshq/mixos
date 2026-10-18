/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A remix entry is a moment in time: written once, never edited (decision 19
 * of docs/plans/20261015_2343-remix.md). This refuses a commit that changes an
 * existing entry in any staged `apps/<slug>/app.json`'s `remixedFrom`. Adding an
 * entry is a new remix, and deleting one says the remix is gone from the app;
 * both pass.
 *
 *   npx tsx scripts/check-remix-provenance.ts
 *
 * .githooks/pre-commit runs it, comparing each staged manifest with HEAD's.
 * Danger makes the same comparison for a pull request (dangerfile.ts), against
 * the commit the branch left its base at. Both use editedRemixEntries() in
 * src/lib/apps/remix.ts, which identifies an entry by its source app, the
 * component pointed at and the day, and compares contents with keys in a fixed
 * order, so reformatting the file changes nothing.
 *
 * Exit code: 0 when no entry was edited, 1 when one was.
 */

import { execFileSync } from "node:child_process";
import { editedRemixEntries, remixEntriesFromAppJson } from "../src/lib/apps/remix";

const APP_JSON = /^apps\/[^/]+\/app\.json$/;

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

export interface EditedRemix {
  file: string;
  /** "<source app> <first anchor> <remixedAt>" for each edited entry. */
  entries: string[];
}

/** Every staged app manifest whose `remixedFrom` edits an entry HEAD has. */
export function stagedRemixEdits(cwd: string = process.cwd()): EditedRemix[] {
  const staged = (git(cwd, ["-c", "core.quotePath=false", "diff", "--cached", "--name-only", "--diff-filter=AMR"]) ?? "")
    .split("\n")
    .filter((f) => APP_JSON.test(f));
  const edits: EditedRemix[] = [];
  for (const file of staged) {
    const before = remixEntriesFromAppJson(git(cwd, ["show", `HEAD:${file}`]));
    const after = remixEntriesFromAppJson(git(cwd, ["show", `:${file}`]));
    const entries = editedRemixEntries(before, after);
    if (entries.length > 0) edits.push({ file, entries });
  }
  return edits;
}

function main(): number {
  const edits = stagedRemixEdits();
  if (edits.length === 0) return 0;
  console.error("[pre-commit] A remix entry is a record of the moment it was taken, and isn't edited:");
  for (const { file, entries } of edits) {
    for (const entry of entries) console.error(`  ${file}: remixedFrom entry "${entry}" changed`);
  }
  console.error(
    "  Put the entry back as it was: `git checkout HEAD -- <file>` and re-apply your other changes.\n" +
      "  The remixed code is yours to change; the entry describes the moment it was taken.\n" +
      "  Remixing again from a newer version is a new entry. See docs/apps/remix.md.",
  );
  return 1;
}

if (require.main === module) process.exit(main());
