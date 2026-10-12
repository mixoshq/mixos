/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What `npm run remove` does with its arguments (scripts/remove.ts runs it).
// The work is src/lib/repository/remove.ts: this reads the arguments, shows
// what removing would do and what stays, asks, and prints the hand-back
// (src/lib/repository/hand-back.ts): the commit that deletes the folder.
//
// It asks git two things, read-only, which the admin pages can't, because the
// server never runs git: whether the folder holds work that isn't committed,
// which removing it deletes (uncommittedPaths()), and whether git tracks the
// folder at all, since one never committed leaves nothing to commit
// (trackedByGit()).
//
// `--recover` and `--break-lock` are `npm run register`'s
// (scripts/register-cli.ts): one recovery for whatever an install, a
// registration or a removal left, and one lock.
//
// Library only. Exported for its tests, which give it a checkout, a stand-in
// generator and their own input and output.

import { spawnSync } from "child_process";
import type { AdminActor } from "../src/lib/apps/admin-audit";
import { extensionFolder, isExtensionName } from "../src/lib/repository/backup";
import { removalHandBackLines } from "../src/lib/repository/hand-back";
import { kindDir, pathExists } from "../src/lib/repository/pending";
import {
  describeRemoveFailure,
  extensionFolders,
  planRemoval,
  removeExtension,
  type RemovalPlan,
} from "../src/lib/repository/remove";
import { KEPT_BEFORE } from "../src/lib/repository/remove-outcomes";
import { sourceHost } from "../src/lib/repository/provenance";
import { EXTENSION_KINDS, type ExtensionKind } from "../src/lib/repository/types";
import { breakLock, cliActor, printable, recover, type CliIo } from "./register-cli";

export const USAGE = `Usage:
  npm run remove                                   list the extensions in this checkout
  npm run remove -- <app|connector|theme>/<slug>   remove its code from this checkout; its data stays
  npm run remove -- <slug>                         the same, when only one kind has that name
  npm run remove -- --recover                      tidy up after a removal, install or registration that stopped midway
  npm run remove -- --break-lock                   show who holds this checkout's lock, and ask before removing it`;

export type Command = { mode: "list" } | { mode: "remove"; target: string } | { mode: "recover" } | { mode: "break-lock" };

/** The command in `args`, or why there isn't one. */
export function parseArgs(args: readonly string[]): Command | { error: string } {
  const flags = args.filter((a) => a.startsWith("--"));
  const words = args.filter((a) => !a.startsWith("--"));
  const unknown = flags.filter((f) => !["--recover", "--break-lock"].includes(f));
  if (unknown.length > 0) return { error: `Unknown option ${unknown[0]}.` };
  if (flags.length > 1) return { error: "Give one of --recover or --break-lock at a time." };
  if (flags.length === 1) {
    if (words.length > 0) return { error: `${flags[0]} takes no extension.` };
    return { mode: flags[0] === "--recover" ? "recover" : "break-lock" };
  }
  if (words.length > 1) return { error: "Name one extension at a time." };
  return words.length === 0 ? { mode: "list" } : { mode: "remove", target: words[0] };
}

const KIND_WORDS: Record<string, ExtensionKind> = {
  app: "app",
  apps: "app",
  connector: "connector",
  connectors: "connector",
  theme: "theme",
  themes: "theme",
};

/**
 * `<kind>/<slug>`, or a name alone when exactly one kind has a folder of that
 * name. The kind may be singular or plural, as `apps/` spells it.
 */
export function resolveTarget(root: string, target: string): { kind: ExtensionKind; slug: string } | { error: string } {
  const parts = target.split("/");
  if (parts.length > 2) return { error: `"${printable(target)}" is not <kind>/<slug>.` };
  const slug = parts[parts.length - 1];
  if (!isExtensionName(slug)) return { error: `"${printable(slug)}" is not the name of an extension.` };

  if (parts.length === 2) {
    const kind = KIND_WORDS[parts[0]];
    if (!kind) return { error: `"${printable(parts[0])}" is not app, connector or theme.` };
    return { kind, slug };
  }
  const found = EXTENSION_KINDS.filter((kind) => pathExists(extensionFolder(root, kind, slug).dir));
  if (found.length === 1) return { kind: found[0], slug };
  if (found.length > 1) {
    return { error: `More than one kind has one named ${slug}. Say ${found.map((k) => `${k}/${slug}`).join(" or ")}.` };
  }
  return { error: `Nothing named ${slug} is in apps/, connectors/ or themes/.` };
}

/**
 * The paths under the folder `folder` (repo-relative) holding work git hasn't
 * committed: changed, staged, deleted or never added. Null when git can't say,
 * because this isn't a work tree or git can't be run. Read-only:
 * `git status`, which changes nothing. `run` is for tests.
 */
export function uncommittedPaths(root: string, folder: string, run: typeof spawnSync = spawnSync): string[] | null {
  const result = run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", folder], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) return null;
  const fields = String(result.stdout ?? "").split("\0");
  const out: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    out.push(entry.slice(3));
    // A rename or a copy is followed by the path it came from.
    if (/[RC]/.test(entry.slice(0, 2))) i += 1;
  }
  return out;
}

/** Whether git tracks anything in the folder `folder`, or null when it can't say. Read-only: `git ls-files`. */
export function trackedByGit(root: string, folder: string, run: typeof spawnSync = spawnSync): boolean | null {
  const result = run("git", ["ls-files", "-z", "--", folder], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout ?? "").length > 0;
}

export interface CliOptions {
  /** The checkout. */
  root: string;
  io: CliIo;
  /** Who the audit row names; the CLI's own actor unless a test says otherwise. */
  actor?: AdminActor;
  /** Tests: a script in the registry generator's place. */
  generator?: string;
  /** Stops a removal at its next safe point (Ctrl-C). */
  signal?: AbortSignal;
  /** Tests: what runs git. */
  git?: typeof spawnSync;
}

/** Run one command. Returns the exit code: 0 done, 1 refused, declined or failed, 2 a usage error. */
export async function runCli(args: readonly string[], options: CliOptions): Promise<number> {
  const { io } = options;
  const command = parseArgs(args);
  if ("error" in command) {
    io.err(`${command.error}\n\n${USAGE}`);
    return 2;
  }
  const say = (line: string) => io.out(printable(line));
  const shared = {
    actor: options.actor ?? cliActor(),
    via: "cli" as const,
    root: options.root,
    generator: options.generator,
    signal: options.signal,
    notice: say,
  };

  try {
    switch (command.mode) {
      case "list":
        return list(options.root, say);
      case "break-lock":
        return await breakLock(options.root, say, io);
      case "recover":
        return await recover({ ...shared, command: "npm run remove -- --recover" }, say, io);
      case "remove": {
        const target = resolveTarget(options.root, command.target);
        if ("error" in target) {
          io.err(printable(target.error));
          return 1;
        }
        const plan = await planRemoval(target.kind, target.slug, options.root);
        show(plan, say);
        if (plan.blockers.length > 0) {
          say("Nothing was changed.");
          return 1;
        }
        const uncommitted = uncommittedPaths(options.root, plan.path, options.git);
        if (uncommitted && uncommitted.length > 0) {
          say(
            `Git lists ${uncommitted.length === 1 ? "1 path" : `${uncommitted.length} paths`} in ${plan.path} with ` +
              "work that isn't committed. Removing it deletes that work:",
          );
          for (const p of uncommitted.slice(0, 10)) say(`    ${p}`);
          if (uncommitted.length > 10) say(`    and ${uncommitted.length - 10} more`);
        }
        const tracked = trackedByGit(options.root, plan.path, options.git);
        if (!(await io.ask(`Remove ${plan.kind}/${plan.slug} from this checkout?`))) {
          say("Nothing was changed.");
          return 1;
        }

        say(`Removing ${plan.kind}/${plan.slug}, and regenerating the registry without it...`);
        const result = await removeExtension(plan.kind, plan.slug, shared);
        say(result.nextStep);
        if (result.discardedPending) say(`The install waiting in ${result.discardedPending}/ was discarded with it.`);
        for (const line of removalHandBackLines(result.handBack, { tracked })) say(line);
        return 0;
      }
    }
  } catch (err) {
    const failure = describeRemoveFailure(err);
    io.err(printable(failure.message));
    if (failure.detail) io.err(`\n${printable(failure.detail).replace(/^/gm, "    ")}`);
    return 1;
  }
}

/** What removing it would do, what stays, and what stands in its way, before asking. */
function show(plan: RemovalPlan, say: (line: string) => void): void {
  say(`${plan.name}, ${plan.kind}/${plan.slug}, in ${plan.path}/:`);
  say(`  Removing it deletes ${plan.path}/ from this checkout and regenerates the registry without it.`);
  say(
    plan.installed
      ? `  It was installed from ${sourceHost(plan.installed.source)} · ${plan.installed.version}, and its ` +
          "install record goes with it."
      : "  It has no install record: it was written here, or installed before installs kept one.",
  );
  if (plan.pending) say(`  The install waiting in ${plan.pending}/ is discarded with it.`);
  say(`  ${KEPT_BEFORE[plan.kind]}`);
  if (plan.blockers.length > 0) {
    say("");
    say("It can't be removed yet:");
    for (const note of plan.blockers) say(`  ${note.message}`);
  }
  if (plan.warnings.length > 0 && plan.blockers.length === 0) {
    say("");
    for (const note of plan.warnings) say(`Note: ${note.message}`);
  }
  say("");
}

function list(root: string, say: (line: string) => void): number {
  const found = EXTENSION_KINDS.flatMap((kind) => extensionFolders(root, kind).map((slug) => `${kind}/${slug}`));
  if (found.length === 0) {
    say(`Nothing to remove: there is no extension in ${EXTENSION_KINDS.map((k) => `${kindDir(k)}/`).join(", ")}.`);
  } else {
    say("Extensions in this checkout:");
    for (const name of found) say(`  ${name}`);
  }
  say(`\n${USAGE}`);
  return 0;
}
