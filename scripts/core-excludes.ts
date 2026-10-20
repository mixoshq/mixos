/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * In a checkout of the core itself, keeps the extensions the core doesn't
 * carry out of `git status`. Where `origin` is mixoshq/mixos, one marked block
 * in `.git/info/exclude` ignores everything under apps/, connectors/ and
 * themes/ except each kind's AGENTS.md and the core's own extensions
 * (./core-extensions.ts). Anywhere else, someone's own copy of MixOS, a fork
 * or a copy with no `origin`, the block is removed: a copy's own extensions
 * are what it commits (docs/hosting/install.md).
 *
 * Not the committed .gitignore, which would hide a copy's own extensions too
 * and come back with every release it merges. `.git/info/exclude` belongs to
 * the checkout and is never committed. The block goes in the common git dir,
 * so a checkout's worktrees share it.
 *
 *   npx tsx scripts/core-excludes.ts    # write, refresh or remove the block
 *
 * package.json's `prepare` runs it on `npm ci` and `npm install`, and
 * `/mixos init` runs it once `origin` no longer names mixoshq/mixos. It never
 * changes a line outside its block, writes only when the block should change,
 * and does nothing where git can't be run or the folder isn't the top of a git
 * work tree, as in a Docker build. It never fails an install.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CORE_EXTENSIONS } from "./core-extensions";

/** The block's first line. A line starting with BEGIN_MARK opens it, so a later wording still finds it. */
export const BEGIN_MARK = "# BEGIN MixOS core checkout";
export const BEGIN = `${BEGIN_MARK}: the extensions the core doesn't carry. Written by scripts/core-excludes.ts; don't edit.`;
/** The block's last line. */
export const END = "# END MixOS core checkout";

/** The rules, in order: each kind's folder, then what of it the core carries. */
export function coreExcludeRules(): string[] {
  const rules: string[] = [];
  for (const [kind, own] of Object.entries(CORE_EXTENSIONS) as [string, readonly string[]][]) {
    rules.push(`/${kind}/*`, `!/${kind}/AGENTS.md`, ...own.map((name) => `!/${kind}/${name}/`));
  }
  return rules;
}

// https://github.com/mixoshq/mixos(.git), with or without a user, git@github.com:mixoshq/mixos(.git),
// ssh://git@github.com/mixoshq/mixos(.git), and ssh.github.com on port 443.
const CORE_ORIGIN =
  /^(?:(?:https?|git):\/\/(?:[^@/\s]+@)?github\.com\/|ssh:\/\/(?:[^@/\s]+@)?(?:ssh\.)?github\.com(?::\d+)?\/|[\w.-]+@github\.com:)mixoshq\/mixos(?:\.git)?\/?$/i;

/** Whether `url`, as `remote.origin.url` holds it, is mixoshq/mixos on GitHub. */
export function isCoreOrigin(url: string | null): boolean {
  return url !== null && CORE_ORIGIN.test(url.trim());
}

/**
 * `text` with the block holding `rules`, or without it when `rules` is null.
 * An existing block is replaced where it is; a new one goes at the end. Every
 * other line stays as it is. Null when a BEGIN line has no END after it: that
 * file is left for a person to fix rather than guessed at.
 */
export function withBlock(text: string, rules: readonly string[] | null): string | null {
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const kept: string[] = [];
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(BEGIN_MARK)) {
      let end = i + 1;
      while (end < lines.length && !lines[end].startsWith(END)) end++;
      if (end === lines.length) return null;
      if (at === -1) at = kept.length;
      i = end;
      continue;
    }
    kept.push(lines[i]);
  }
  if (rules !== null) kept.splice(at === -1 ? kept.length : at, 0, BEGIN, ...rules, END);
  return kept.length === 0 ? "" : `${kept.join("\n")}\n`;
}

/** Runs git in `cwd`: its trimmed output, or null when it fails or can't be run. */
export type GitRunner = (cwd: string, args: string[]) => string | null;

/** git in `cwd`, never in a repository the environment names instead. */
export const runGit: GitRunner = (cwd, args) => {
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[name];
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
  return result.error || result.status !== 0 ? null : String(result.stdout).trim();
};

export type ExcludesResult =
  | { action: "written" | "removed" | "unchanged"; file: string }
  | { action: "skipped"; reason: string; file?: string };

/** Sets the block in the exclude file of the repository whose top is `root`, as its `origin` calls for. */
export function syncCoreExcludes(root: string, git: GitRunner = runGit): ExcludesResult {
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  if (top === null) return { action: "skipped", reason: "no git work tree here, or no git" };
  if (fs.realpathSync(top) !== fs.realpathSync(root)) {
    return { action: "skipped", reason: `${root} isn't the top of its git work tree` };
  }
  const common = git(root, ["rev-parse", "--git-common-dir"]);
  if (common === null) return { action: "skipped", reason: "git couldn't name the repository's directory" };
  const file = path.join(path.resolve(root, common), "info", "exclude");
  const rules = isCoreOrigin(git(root, ["config", "--get", "remote.origin.url"])) ? coreExcludeRules() : null;
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const after = withBlock(before, rules);
  if (after === null) {
    return { action: "skipped", reason: `${file} has a "${BEGIN_MARK}" line with no "${END}" after it`, file };
  }
  if (after === before) return { action: "unchanged", file };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, after, "utf8");
  fs.renameSync(tmp, file);
  return { action: rules !== null ? "written" : "removed", file };
}

if (require.main === module) {
  try {
    const result = syncCoreExcludes(path.resolve(__dirname, ".."));
    if (result.action === "written") {
      console.log(`core-excludes: ${result.file} ignores the extensions the core doesn't carry, as in a checkout of mixoshq/mixos.`);
    } else if (result.action === "removed") {
      console.log(`core-excludes: removed the core checkout's block from ${result.file}, so this copy's own extensions can be committed.`);
    } else if (result.action === "skipped" && result.file) {
      console.warn(`core-excludes: left ${result.file} alone: ${result.reason}.`);
    }
  } catch (err) {
    // Never fail an install over this.
    console.warn(`core-excludes: ${err instanceof Error ? err.message : String(err)}`);
  }
}
