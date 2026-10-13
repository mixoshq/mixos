/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What `npm run register` and `npm run remove` share as programs
// (scripts/register.ts, scripts/remove.ts): finding the database the way the
// other scripts do (scripts/load-env.ts), asking on the terminal, stopping at
// the next safe point on the first Ctrl-C and at once on the second, and
// closing the database pool before exiting.
//
// Each entry changes to the checkout before it starts this, because
// src/lib/repository/install.ts and src/lib/platform/build.ts read the
// checkout from the working directory when they load. So nothing here imports
// them: the command's own module is loaded after the environment.

import readline from "readline";
import type { Sql } from "postgres";

/** The terminal, as a command's runCli() takes it. */
export interface TerminalIo {
  out(line: string): void;
  err(line: string): void;
  ask(question: string): Promise<boolean>;
  /** One of `keys`, as typed after `question`, or null for anything else, no answer or Ctrl-C. */
  choose(question: string, keys: readonly string[]): Promise<string | null>;
}

/** A command module: scripts/register-cli.ts or scripts/remove-cli.ts. */
export interface CheckoutCommand {
  runCli(
    args: readonly string[],
    options: { root: string; signal: AbortSignal; io: TerminalIo },
  ): Promise<number>;
}

/** A line typed at the terminal after `prompt`. No answer, a closed input or Ctrl-C is null. */
function typed(prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    rl.on("SIGINT", () => rl.close());
    rl.on("close", () => {
      if (!answered) {
        process.stdout.write("\n");
        resolve(null);
      }
    });
    rl.question(prompt, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Answers piped in, read as one stream and handed out a line at a time, so
 * `printf 'k\ny\n' | npm run register -- --recover` answers two questions. An
 * interface for each question, as at a terminal, would read the whole pipe for
 * the first and leave the next one nothing.
 */
class PipedAnswers {
  private readonly lines: string[] = [];
  private waiting: ((line: string | null) => void) | null = null;
  private ended = false;
  private rl: readline.Interface | null = null;

  next(): Promise<string | null> {
    if (!this.rl) {
      this.rl = readline.createInterface({ input: process.stdin, terminal: false });
      this.rl.on("line", (line) => {
        const waiting = this.waiting;
        this.waiting = null;
        if (waiting) waiting(line);
        else this.lines.push(line);
      });
      this.rl.on("close", () => {
        this.ended = true;
        const waiting = this.waiting;
        this.waiting = null;
        waiting?.(null);
      });
    }
    if (this.lines.length > 0) return Promise.resolve(this.lines.shift()!);
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  /** Stop reading, so the process can end. */
  close(): void {
    this.rl?.close();
  }
}

const piped = new PipedAnswers();

/** The answer to `prompt`, typed or piped in. */
async function answer(prompt: string): Promise<string | null> {
  if (process.stdin.isTTY) return typed(prompt);
  process.stdout.write(prompt);
  const line = await piped.next();
  process.stdout.write("\n");
  return line;
}

/** Ask on the terminal. No answer, a closed input or Ctrl-C is no. */
async function ask(question: string): Promise<boolean> {
  return /^\s*y(es)?\s*$/i.test((await answer(`${question} [y/N] `)) ?? "");
}

/** Ask for one of `keys`, or a word that starts with one. Anything else is null. */
async function choose(question: string, keys: readonly string[]): Promise<string | null> {
  const said = ((await answer(`${question} [${keys.join("/")}/N] `)) ?? "").trim().toLowerCase();
  return said ? (keys.find((key) => said === key || said.startsWith(key)) ?? null) : null;
}

async function main(root: string, load: () => Promise<CheckoutCommand>): Promise<number> {
  const { loadEnv } = await import("./load-env");
  loadEnv();
  const { runCli } = await load();

  // The first Ctrl-C stops at the next safe point, ending a generator run in
  // progress, so the locks are released and what was left is said. A second
  // one quits at once.
  const controller = new AbortController();
  let interrupts = 0;
  const interrupt = () => {
    interrupts += 1;
    if (interrupts > 1) process.exit(130);
    controller.abort();
    process.stderr.write("\nStopping at the next safe point. Press Ctrl-C again to quit now.\n");
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  process.on("SIGHUP", interrupt);

  try {
    return await runCli(process.argv.slice(2), {
      root,
      signal: controller.signal,
      io: {
        out: (line) => console.log(line),
        err: (line) => console.error(line),
        ask,
        choose,
      },
    });
  } finally {
    piped.close();
    // The pool the register lock and the audit used, if they used one.
    const pool = (globalThis as { __pg?: Sql }).__pg;
    await pool?.end({ timeout: 5 }).catch(() => {});
  }
}

/**
 * Run a command in the checkout at `root`, which the caller has already made
 * the working directory. `load` imports the command's module.
 *
 * It ends by running out of work rather than by process.exit(), which can cut
 * off what is still being written to a pipe (`npm run register | tee`). If
 * anything were left holding the process open, it ends a few seconds later.
 */
export function runCheckoutCli(root: string, load: () => Promise<CheckoutCommand>): void {
  const finish = (code: number) => {
    process.exitCode = code;
    setTimeout(() => process.exit(code), 5000).unref();
  };
  main(root, load).then(finish, (err) => {
    console.error(err instanceof Error ? err.message : err);
    finish(1);
  });
}
