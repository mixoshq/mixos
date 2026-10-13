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
// because the server never runs git. Registering a pending update swaps it for
// the folder in place, and the hand-back is the change to that folder and how
// to roll it back.
//
// `--smoke` adds a smoke test of an app: checks before Register, and after it
// the app's migrations, its activation and a grant, then the smoke script, in
// this checkout's database only (./register-smoke.ts).
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
  readSidecar,
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
import { SmokeSetupError, normalizeBaseUrl } from "./app-smoke";
import {
  checkoutSmokeSteps,
  smokeAfterRegister,
  smokeBeforeRegister,
  type SmokePlan,
  type SmokeRequest,
  type SmokeSteps,
} from "./register-smoke";

export const USAGE = `Usage:
  npm run register                                 list what is waiting in ${MIXOS_DIR}/pending/
  npm run register -- <app|connector>/<slug>       register it: move it into place and run its code
  npm run register -- <slug>                       the same, when only one kind has that slug pending
  npm run register -- app/<slug> --smoke           register it, then migrate, activate, grant and smoke-test it
                                                   in this checkout's database, which has to be on this machine
  npm run register -- <kind>/<slug> --discard      delete it from ${MIXOS_DIR}/pending/
  npm run register -- --recover                    tidy up after an install, registration, removal or update that stopped midway
  npm run register -- --break-lock                 show who holds this checkout's lock, and ask before removing it

With --smoke:
  --base-url <url>             the running server to test (default http://localhost:3000)
  --confirm-replaces <slug>    go ahead with an app that replaces a different extension under its slug
  --database-is-disposable     allow a database that isn't on this machine, when it is yours alone to throw away
  Sign in with SMOKE_EMAIL and SMOKE_PASSWORD, or SMOKE_COOKIE, as for scripts/smoke-test-app.ts.`;

export type Command =
  | { mode: "list" }
  | { mode: "register"; target: string; smoke?: SmokeRequest }
  | { mode: "discard"; target: string }
  | { mode: "recover" }
  | { mode: "break-lock" };

/** The modes, of which a command gives at most one. */
const MODE_FLAGS = ["--discard", "--recover", "--break-lock"];
/** What only --smoke takes. */
const SMOKE_FLAGS = ["--base-url", "--confirm-replaces", "--database-is-disposable"];
/** Flags with a value: `--flag value` or `--flag=value`. */
const VALUE_FLAGS = ["--base-url", "--confirm-replaces"];

/** The command in `args`, or why there isn't one. */
export function parseArgs(args: readonly string[]): Command | { error: string } {
  const flags: string[] = [];
  const words: string[] = [];
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      words.push(arg);
      continue;
    }
    // `--flag value` or `--flag=value`, for the flags that take one.
    const eq = arg.indexOf("=");
    const name = eq > 0 && VALUE_FLAGS.includes(arg.slice(0, eq)) ? arg.slice(0, eq) : arg;
    if (VALUE_FLAGS.includes(name)) {
      const value = eq > 0 ? arg.slice(eq + 1) : args[++i];
      if (value === undefined || value === "" || (eq < 0 && value.startsWith("--"))) {
        return { error: `${name} needs a value.` };
      }
      values.set(name, value);
    }
    flags.push(name);
  }

  const known = [...MODE_FLAGS, "--smoke", ...SMOKE_FLAGS];
  const unknown = flags.filter((f) => !known.includes(f));
  if (unknown.length > 0) return { error: `Unknown option ${unknown[0]}.` };
  if (new Set(flags).size !== flags.length) {
    const twice = flags.find((f, i) => flags.indexOf(f) !== i);
    return { error: `Give ${twice} once.` };
  }
  const modes = flags.filter((f) => MODE_FLAGS.includes(f));
  if (modes.length > 1) return { error: "Give one of --discard, --recover or --break-lock at a time." };
  const flag = modes[0];

  const smoke = flags.includes("--smoke");
  const smokeOnly = flags.filter((f) => SMOKE_FLAGS.includes(f));
  if (!smoke && smokeOnly.length > 0) return { error: `${smokeOnly[0]} goes with --smoke.` };
  if (smoke && flag) return { error: `--smoke goes with registering an app, not with ${flag}.` };

  if (flag === "--recover" || flag === "--break-lock") {
    if (words.length > 0) return { error: `${flag} takes no extension.` };
    return { mode: flag === "--recover" ? "recover" : "break-lock" };
  }
  if (words.length > 1) return { error: "Name one extension at a time." };
  if (flag === "--discard") {
    if (words.length === 0) return { error: "--discard needs the extension to discard: <kind>/<slug>." };
    return { mode: "discard", target: words[0] };
  }
  if (words.length === 0) {
    return smoke ? { error: "--smoke needs the app to register: app/<slug>." } : { mode: "list" };
  }
  if (!smoke) return { mode: "register", target: words[0] };

  const baseUrl = values.get("--base-url");
  if (baseUrl !== undefined) {
    try {
      normalizeBaseUrl(baseUrl);
    } catch (err) {
      return { error: `${err instanceof SmokeSetupError ? err.message : String(err)}.` };
    }
  }
  const confirmReplaces = values.get("--confirm-replaces");
  return {
    mode: "register",
    target: words[0],
    smoke: {
      databaseIsDisposable: flags.includes("--database-is-disposable"),
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(confirmReplaces !== undefined ? { confirmReplaces } : {}),
    },
  };
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
  /**
   * One of `keys`, or null for anything else, and for no answer at all. Without
   * it, a choice goes the first way offered, which puts things back.
   */
  choose?(question: string, keys: readonly string[]): Promise<string | null>;
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
  /** Tests: stand-ins for what --smoke reaches: the database, the server and its child processes. */
  smoke?: SmokeSteps;
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

        // --smoke: its checks come first, so a refusal leaves nothing registered.
        const smokeSteps = command.smoke ? (options.smoke ?? checkoutSmokeSteps(options.root, options.signal)) : null;
        let plan: SmokePlan | null = null;
        if (command.smoke && smokeSteps) {
          if (target.kind !== "app") {
            io.err(
              `--smoke tests an app's routes, and a ${target.kind} has none of its own. Register it without ` +
                "--smoke, then smoke-test an app that uses it.",
            );
            return 2;
          }
          const typed = command.smoke.confirmReplaces;
          if (typed !== undefined && typed !== target.slug) {
            io.err(printable(`--confirm-replaces names ${typed}, and this registers ${target.slug}. Type the slug of the app you are registering.`));
            return 2;
          }
          const before = await smokeBeforeRegister(target.slug, command.smoke, {
            root: options.root,
            steps: smokeSteps,
            say,
          });
          if (!before.ok) {
            io.err(printable(before.message));
            return 1;
          }
          plan = before.plan;
        }

        const waiting = readSidecar(pendingLocation(options.root, target.kind, target.slug).sidecar);
        const replaces = waiting.state === "ok" ? waiting.sidecar.replaces : undefined;
        say(
          replaces
            ? `Updating ${target.kind}/${target.slug} from ${replaces.version}. This moves ` +
                `${liveLocation(options.root, target.kind, target.slug).rel} aside and runs the new release's code for ` +
                "the first time..."
            : `Registering ${target.kind}/${target.slug}. This runs its code for the first time...`,
        );
        const result = await registerPending(target.kind, target.slug, shared);
        say(
          (result.update
            ? `Updated ${result.kind}/${result.slug} from ${result.update.from.version} to ${result.version}`
            : `Registered ${result.kind}/${result.slug} ${result.version}`) +
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
        if (plan && smokeSteps) return await smokeAfterRegister(plan, { steps: smokeSteps, say, actor: shared.actor.email });
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

/**
 * `--break-lock`: who holds the checkout lock, and, once a person agrees,
 * remove it. `npm run remove -- --break-lock` is the same (scripts/remove-cli.ts).
 */
export async function breakLock(root: string, say: (line: string) => void, io: CliIo): Promise<number> {
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

/**
 * `--recover`: what a stopped install, registration, discard, removal or
 * update left, and, once a person agrees, deal with it. An update stopped with
 * its new release in place can go either way, so it asks which first.
 * `npm run remove -- --recover` is the same (scripts/remove-cli.ts).
 */
export async function recover(
  shared: Omit<RecoverOptions, "confirm" | "choose">,
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
    choose: async (item) => {
      const choices = item.choices ?? [];
      const keys = choices.map((c) => c.label.charAt(0).toLowerCase());
      say("It can go either way:");
      say(`  ${item.path}`);
      say(`    ${item.found}`);
      choices.forEach((c, i) => say(`    ${keys[i]}: ${c.does}`));
      const question = choices.map((c, i) => (i === 0 ? capitalized(c.label) : c.label)).join(", or ");
      const key = io.choose ? await io.choose(`${question}?`, keys) : keys[0];
      return choices[keys.indexOf(key ?? "")]?.action ?? null;
    },
    confirm: async (items) => {
      say("Found:");
      show(items);
      return io.ask("Go ahead?");
    },
  });

  if (result.items.length === 0) {
    say("Nothing to recover: no install, registration, discard, removal or update was left unfinished.");
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
  for (const note of result.notes) say(note);
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

/** "Restore 1.2.0", from "restore 1.2.0". */
function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
