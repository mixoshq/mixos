/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// `npm run register` — the second half of installing an app or a connector
// from the Registry, in this checkout.
//
//   npm run register                              list what is waiting in .mixos/pending/
//   npm run register -- <kind>/<slug>             register it
//   npm run register -- <slug>                    the same, when only one kind has it pending
//   npm run register -- app/<slug> --smoke        register it, then migrate, activate, grant and
//                                                 smoke-test it in this checkout's local database
//   npm run register -- <kind>/<slug> --discard   delete it from pending
//   npm run register -- --recover                 tidy up after one that stopped midway
//   npm run register -- --break-lock              show who holds the checkout lock, and ask
//
// Registering moves the extension into apps/ or connectors/ and runs the
// registry generator, which loads its code for the first time. It holds the
// register lock in the database and the checkout lock (.mixos/lock) while it
// works, and records an audit row as `cli:<os user>@<hostname>`.
//
// It finds the database the way the other scripts do (scripts/load-env.ts), and
// runs the generator with PATH and TMPDIR only. With `npm run dev:docker`, run
// it from your terminal: it reaches the stack's database as the dev server does.
//
// The work is in scripts/register-cli.ts and src/lib/repository/register.ts,
// and for --smoke, scripts/register-smoke.ts.

import path from "path";
import readline from "readline";
import type { Sql } from "postgres";

const ROOT = path.resolve(__dirname, "..");

// Before anything is imported: src/lib/repository/install.ts and
// src/lib/platform/build.ts read the checkout from the working directory.
process.chdir(ROOT);

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

async function main(): Promise<number> {
  const { loadEnv } = await import("./load-env");
  loadEnv();
  const { runCli } = await import("./register-cli");

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
      root: ROOT,
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

// Ended by running out of work rather than by process.exit(), which can cut
// off what is still being written to a pipe (`npm run register | tee`). If
// anything were left holding the process open, it ends a few seconds later.
const finish = (code: number) => {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 5000).unref();
};
main().then(finish, (err) => {
  console.error(err instanceof Error ? err.message : err);
  finish(1);
});
