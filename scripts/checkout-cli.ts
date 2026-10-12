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
}

/** A command module: scripts/register-cli.ts or scripts/remove-cli.ts. */
export interface CheckoutCommand {
  runCli(
    args: readonly string[],
    options: { root: string; signal: AbortSignal; io: TerminalIo },
  ): Promise<number>;
}

/** Ask on the terminal. No answer, a closed input or Ctrl-C is no. */
function ask(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    rl.on("SIGINT", () => rl.close());
    rl.on("close", () => {
      if (!answered) {
        process.stdout.write("\n");
        resolve(false);
      }
    });
    rl.question(`${question} [y/N] `, (answer) => {
      answered = true;
      rl.close();
      resolve(/^\s*y(es)?\s*$/i.test(answer));
    });
  });
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
      },
    });
  } finally {
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
