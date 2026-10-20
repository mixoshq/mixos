/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Within a major version a connector only adds. This refuses a commit whose
 * staged `connectors/<name>/connector.json` breaks that against HEAD's: a
 * version that goes backwards, or a method removed or made into a write without
 * a new major version. An app names the version it was built against, and a
 * later release of the same major version must still have what it calls.
 *
 *   npx tsx scripts/check-connector-contract.ts
 *
 * .githooks/pre-commit runs it, and Danger makes the same comparison for a pull
 * request (dangerfile.ts). Both use contractProblems() in
 * src/lib/connectors/requirements.ts. Adding a method needs no new version per
 * commit: a release's version is checked against the one before it where it is
 * published, by mixos.org.
 *
 * A connector installed from a Registry is skipped: its folder is its
 * publisher's, and Register holds a new release to the apps installed here.
 *
 * Exit code: 0 when nothing breaks the contract, 1 when something does.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connectorSurfaceOf, contractProblems } from "../src/lib/connectors/requirements";
import { INSTALL_RECORD_FILE } from "../src/lib/repository/install-record";

const CONNECTOR_JSON = /^connectors\/([^/_.][^/]*)\/connector\.json$/;

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

export interface ContractBreak {
  file: string;
  problems: string[];
}

/** Every staged connector manifest that breaks the contract against HEAD's. */
export function stagedContractBreaks(cwd: string = process.cwd()): ContractBreak[] {
  const staged = (git(cwd, ["-c", "core.quotePath=false", "diff", "--cached", "--name-only", "--diff-filter=AMR"]) ?? "")
    .split("\n")
    .filter((f) => CONNECTOR_JSON.test(f));
  const breaks: ContractBreak[] = [];
  for (const file of staged) {
    if (fs.existsSync(path.join(cwd, path.dirname(file), INSTALL_RECORD_FILE))) continue;
    const before = connectorSurfaceOf(git(cwd, ["show", `HEAD:${file}`]));
    const after = connectorSurfaceOf(git(cwd, ["show", `:${file}`]));
    // A new connector has nothing to keep faith with yet.
    if (!before || !after) continue;
    const problems = contractProblems(before, after);
    if (problems.length > 0) breaks.push({ file, problems });
  }
  return breaks;
}

function main(): number {
  const breaks = stagedContractBreaks();
  if (breaks.length === 0) return 0;
  console.error("[pre-commit] Within a major version a connector only adds:");
  for (const { file, problems } of breaks) {
    for (const problem of problems) console.error(`  ${file}: ${problem}`);
  }
  console.error(
    "  Apps name the connector version they were built against, and any later release with the same\n" +
      "  major version must still have what they call. Put the method back, or raise the major version.\n" +
      "  See connectors/AGENTS.md.",
  );
  return 1;
}

if (require.main === module) process.exit(main());
