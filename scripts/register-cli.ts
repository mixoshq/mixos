/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What `npm run register` does with its arguments (scripts/register.ts runs
// it). The work itself is src/lib/repository/register.ts: this reads the
// arguments, asks before anything a person should agree to, and prints.
//
// After a registration it says what install left out of the package, if
// anything (src/lib/repository/left-out.ts), then prints the hand-back
// (src/lib/repository/hand-back.ts): what to commit and how. It also asks git,
// read-only, whether the checkout's ignore rules would leave any of the new
// files out of the commit (ignoredByGit()), which the admin pages can't,
// because the server never runs git.
//
// Library only. Exported for its tests, which give it a checkout, a stand-in
// generator and their own input and output.

import { spawnSync } from "child_process";
import os from "os";
import type { AdminActor } from "../src/lib/apps/admin-audit";
import { cliActorName } from "../src/lib/apps/audit-actors";
import {
  breakCheckoutLock,
  describeCheckoutLockHolder,
  pidRunning,
  readCheckoutLock,
} from "../src/lib/platform/checkout-lock";
import { handBackLines, type IgnoredPath } from "../src/lib/repository/hand-back";
import { folderFiles } from "../src/lib/repository/install-record";
import { leftOutLine } from "../src/lib/repository/left-out";
import {
  MIXOS_DIR,
  liveLocation,
  listPendingInstalls,
  pathExists,
  pendingLocation,
  type PendingKind,
} from "../src/lib/repository/pending";
import {
  describeRegisterFailure,
  discardPending,
  recoverCheckout,
  registerPending,
  type RecoverOptions,
  type RecoveryItem,
} from "../src/lib/repository/register";
import { SlugSchema } from "../src/lib/repository/types";

export const USAGE = `Usage:
  npm run register                                 list what is waiting in ${MIXOS_DIR}/pending/
  npm run register -- <app|connector>/<slug>       register it: move it into place and run its code
  npm run register -- <slug>                       the same, when only one kind has that slug pending
  npm run register -- <kind>/<slug> --discard      delete it from ${MIXOS_DIR}/pending/
  npm run register -- --recover                    tidy up after an install or registration that stopped midway
  npm run register -- --break-lock                 show who holds this checkout's lock, and ask before removing it`;

export type Command =
  | { mode: "list" }
  | { mode: "register"; target: string }
  | { mode: "discard"; target: string }
  | { mode: "recover" }
  | { mode: "break-lock" };

/** The command in `args`, or why there isn't one. */
export function parseArgs(args: readonly string[]): Command | { error: string } {
  const flags = args.filter((a) => a.startsWith("--"));
  const words = args.filter((a) => !a.startsWith("--"));
  const unknown = flags.filter((f) => !["--discard", "--recover", "--break-lock"].includes(f));
  if (unknown.length > 0) return { error: `Unknown option ${unknown[0]}.` };
  if (new Set(flags).size !== flags.length || flags.length > 1) {
    return { error: "Give one of --discard, --recover or --break-lock at a time." };
  }
  const flag = flags[0];

  if (flag === "--recover" || flag === "--break-lock") {
    if (words.length > 0) return { error: `${flag} takes no extension.` };
    return { mode: flag === "--recover" ? "recover" : "break-lock" };
  }
  if (words.length > 1) return { error: "Name one extension at a time." };
  if (flag === "--discard") {
    if (words.length === 0) return { error: "--discard needs the extension to discard: <kind>/<slug>." };
    return { mode: "discard", target: words[0] };
  }
  return words.length === 0 ? { mode: "list" } : { mode: "register", target: words[0] };
}

const KIND_WORDS: Record<string, PendingKind | "theme"> = {
  app: "app",
  apps: "app",
  connector: "connector",
  connectors: "connector",
  theme: "theme",
  themes: "theme",
};

/**
 * `<kind>/<slug>`, or a slug alone when exactly one kind has it pending. The
 * kind may be singular or plural, as `.mixos/pending/apps/` spells it.
 */
export function resolveTarget(root: string, target: string): { kind: PendingKind; slug: string } | { error: string } {
  const parts = target.split("/");
  if (parts.length > 2) return { error: `"${printable(target)}" is not <kind>/<slug>.` };
  const slug = parts[parts.length - 1];
  if (!SlugSchema.safeParse(slug).success) return { error: `"${printable(slug)}" is not an extension slug.` };

  if (parts.length === 2) {
    const kind = KIND_WORDS[parts[0]];
    if (!kind) return { error: `"${printable(parts[0])}" is not app or connector.` };
    if (kind === "theme") {
      return { error: "A theme is registered when it is installed, so none waits in pending." };
    }
    return { kind, slug };
  }

  const found = (["app", "connector"] as const).filter((kind) => {
    const where = pendingLocation(root, kind, slug);
    return pathExists(where.folder) || pathExists(where.sidecar);
  });
  if (found.length === 1) return { kind: found[0], slug };
  if (found.length === 2) {
    return { error: `Both an app and a connector named ${slug} are pending. Say app/${slug} or connector/${slug}.` };
  }
  return { error: `Nothing named ${slug} is waiting in ${MIXOS_DIR}/pending/.` };
}

/** Text from a file, a lock or a hostname, made safe to print in a terminal. */
export function printable(text: string): string {
  return text.replace(/[\p{Cc}\p{Bidi_Control}\p{Zl}\p{Zp}]/gu, (c) =>
    c === "\n" ? "\n" : `\\u{${c.codePointAt(0)!.toString(16).toUpperCase()}}`,
  );
}

/**
 * The files of the registered folder `folder` (repo-relative) that git would
 * leave out of `git add <folder>`, by this checkout's ignore rules, each with
 * the rule that does it. `files` are paths in the folder.
 *
 * Read-only: `git check-ignore`, which changes nothing. Empty when this isn't
 * a git work tree or git can't be run, since there is then no `git add` to
 * warn about. A rule that starts with `!` keeps a file in, and is skipped.
 * `run` is for tests.
 */
export function ignoredByGit(
  root: string,
  folder: string,
  files: readonly string[],
  run: typeof spawnSync = spawnSync,
): IgnoredPath[] {
  if (files.length === 0) return [];
  const result = run("git", ["check-ignore", "--verbose", "-z", "--stdin"], {
    cwd: root,
    input: `${files.map((f) => `${folder}/${f}`).join("\0")}\0`,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 10_000,
  });
  // 0: some are ignored. 1: none are. Anything else: no answer.
  if (result.error || (result.status !== 0 && result.status !== 1)) return [];
  const fields = String(result.stdout ?? "").split("\0");
  const out: IgnoredPath[] = [];
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const [source, line, pattern, pathname] = fields.slice(i, i + 4);
    if (!pathname || !pattern || pattern.startsWith("!")) continue;
    out.push({ path: pathname, rule: `${source}:${line}:${pattern}` });
  }
  return out;
}

/** The audit's name for whoever runs this: `cli:<os user>@<hostname>`. */
export function cliActor(): AdminActor {
  let user: string | undefined;
  try {
    user = os.userInfo().username;
  } catch {
    // A container's user may have no passwd entry.
    user = process.env.USER ?? process.env.LOGNAME;
  }
  return { id: null, email: cliActorName(user, os.hostname()) };
}

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  /** A yes-or-no question; anything but yes is no, and so is no answer at all. */
  ask(question: string): Promise<boolean>;
}

export interface CliOptions {
  /** The checkout. */
  root: string;
  io: CliIo;
  /** Who the audit row names; the CLI's own actor unless a test says otherwise. */
  actor?: AdminActor;
  /** Tests: a script in the registry generator's place. */
  generator?: string;
  /** Stops a registration at its next safe point (Ctrl-C). */
  signal?: AbortSignal;
  /** Tests: what runs `git check-ignore`. */
  git?: typeof spawnSync;
}

/** Run one command. Returns the exit code: 0 done, 1 refused or failed, 2 a usage error. */
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
        return await recover(shared, say, io);
      case "register":
      case "discard": {
        const target = resolveTarget(options.root, command.target);
        if ("error" in target) {
          io.err(printable(target.error));
          return 1;
        }
        if (command.mode === "discard") {
          const result = await discardPending(target.kind, target.slug, shared);
          say(`Discarded ${target.kind}/${target.slug}: deleted ${result.pendingPath}/ and its record.`);
          return 0;
        }
        say(`Registering ${target.kind}/${target.slug}. This runs its code for the first time...`);
        const result = await registerPending(target.kind, target.slug, shared);
        say(
          `Registered ${result.kind}/${result.slug} ${result.version}` +
            (result.gitTag ? ` (${result.gitTag})` : "") +
            ` from commit ${result.commitSha.slice(0, 12)}.`,
        );
        say(result.nextStep);
        const leftOut = leftOutLine(result.leftOut);
        if (leftOut) say(leftOut);
        const live = liveLocation(options.root, result.kind, result.slug);
        const ignored = ignoredByGit(
          options.root,
          live.rel,
          folderFiles(live.dir).map((f) => f.path),
          options.git,
        );
        for (const line of handBackLines(result.handBack, { isApp: result.kind === "app", ignored })) say(line);
        return 0;
      }
    }
  } catch (err) {
    const failure = describeRegisterFailure(err);
    io.err(printable(failure.message));
    if (failure.detail) io.err(`\n${printable(failure.detail).replace(/^/gm, "    ")}`);
    return 1;
  }
}

function list(root: string, say: (line: string) => void): number {
  const pending = listPendingInstalls(root);
  if (pending.length === 0) {
    say(`Nothing is waiting in ${MIXOS_DIR}/pending/. Install an app or a connector from the Registry in Admin first.`);
    say(`\n${USAGE}`);
    return 0;
  }
  say(`Waiting in ${MIXOS_DIR}/pending/:`);
  for (const p of pending) {
    const s = p.sidecar;
    say(
      `  ${p.kind}/${p.slug}` +
        (p.record ? ` ${p.record.version}` : "") +
        (s ? `${p.record ? "," : ""} installed ${new Date(s.installedAt).toLocaleString(undefined, { hour12: false })} by ${s.installedBy}` : ""),
    );
    say(p.problem ? `    ${p.problem}` : `    npm run register -- ${p.kind}/${p.slug}`);
  }
  return 0;
}

async function breakLock(root: string, say: (line: string) => void, io: CliIo): Promise<number> {
  const state = readCheckoutLock(root);
  if (!state.exists) {
    say("This checkout isn't locked.");
    return 0;
  }
  if (state.holder) {
    const holder = state.holder;
    say(`The checkout lock (${MIXOS_DIR}/lock) is held by ${describeCheckoutLockHolder(holder)}.`);
    if (holder.hostname === os.hostname()) {
      say(
        pidRunning(holder.pid)
          ? "That process is still running. Breaking its lock lets another install, registration " +
              "or registry run change this checkout while it does."
          : "That process isn't running, so the next operation that needs the lock takes it over " +
              "anyway.",
      );
    } else {
      say(
        "It was taken on another machine, such as a dev container, so nothing here can tell " +
          "whether that process is still running. Break it only if you know it isn't.",
      );
    }
  } else {
    say(
      `The checkout lock (${MIXOS_DIR}/lock) is there, but its file can't be read as one, so ` +
        "nothing can tell who holds it. Break it only if no install, registration or registry " +
        "run is going on in this checkout.",
    );
  }
  if (!(await io.ask("Break the lock?"))) {
    say("Left as it was.");
    return 1;
  }
  if (breakCheckoutLock(root, state.raw)) {
    say("Removed the checkout lock.");
    return 0;
  }
  say("The lock changed while you were deciding, so it was left alone. Run this again to see who holds it now.");
  return 1;
}

async function recover(
  shared: Omit<RecoverOptions, "confirm">,
  say: (line: string) => void,
  io: CliIo,
): Promise<number> {
  const show = (items: RecoveryItem[]) => {
    for (const item of items) {
      say(`  ${item.path}`);
      say(`    ${item.found}`);
      say(item.blocked ? `    Left alone: ${item.blocked}` : `    Recovery will: ${item.does}`);
      if (item.warning) say(`    Note: ${item.warning}`);
    }
  };
  const result = await recoverCheckout({
    ...shared,
    confirm: async (items) => {
      say("Found:");
      show(items);
      return io.ask("Go ahead?");
    },
  });

  if (result.items.length === 0) {
    say("Nothing to recover: no install, registration or discard was left unfinished.");
    return 0;
  }
  if (result.cancelled) {
    say("Nothing was changed.");
    return 1;
  }
  if (result.acted.length === 0) {
    say("Found, and left alone:");
    show(result.items);
    return 1;
  }
  say(`Done: ${result.acted.map((i) => i.path).join(", ")}.`);
  if (result.regenerated) {
    say(
      result.regenerated.ok
        ? "Regenerated the registry."
        : "Regenerating the registry failed, so src/generated/ may be out of date: run `npm run registry`.",
    );
    if (!result.regenerated.ok) io.err(printable(result.regenerated.output).replace(/^/gm, "    "));
  }
  const blocked = result.items.filter((i) => i.blocked);
  if (blocked.length > 0) {
    say("Left alone:");
    show(blocked);
    return 1;
  }
  return result.regenerated && !result.regenerated.ok ? 1 : 0;
}
