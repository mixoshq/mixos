/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Stops everything `scripts/docker-up.ts` started, in the reverse order: the app
// containers first (they hold open Postgres connections), then the Supabase
// stack.
//
// Two modes:
//
//   npm run docker:down    stop everything, keep the database
//   npm run docker:reset   stop everything and DELETE the database volume
//
// `docker:down` is safe and routine — the seeded admin, connector credentials
// and any app data survive, which is the whole point of using
// `supabase migration up` rather than `supabase db reset` on the way in.
// `docker:reset` is the escape hatch for a corrupted or half-migrated local
// database, and it is destructive, so it asks first.
//
// Both steps are individually skippable and individually fault-tolerant: a
// half-finished setup (no compose file yet, Supabase never initialised, Docker
// not even running) must not turn "stop my stack" into a stack trace.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { dockerInstallHint, hostPlatform } from "./host-platform";
import { resolveInstance } from "./instance";
import { notYourInstance, ownedElsewhere } from "./instance-claims";
import readline from "node:readline/promises";

const ROOT = path.resolve(__dirname, "..");

/**
 * Which instance to take down.
 *
 * Resolved from `.env.instance` exactly as docker-up.ts does, so a `down` in a
 * checkout stops that checkout's stack and leaves another instance's running.
 * A literal here was what made the two scripts have to agree by hand.
 *
 * The one name is both halves of the instance: the compose project, and the
 * Supabase project id, which supabase/config.toml reads from MIXOS_INSTANCE.
 * Stopping Supabase by any other name would stop — and with `--reset`, delete
 * the data of — a different instance than the app containers just stopped.
 */
const INSTANCE = resolveInstance();

const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;
const c = {
  dim: (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
};

class TeardownError extends Error {
  readonly next: string;
  constructor(message: string, next: string) {
    super(message);
    this.name = "TeardownError";
    this.next = next;
  }
}

/** Argument arrays only — never a shell string. See scripts/docker-up.ts. */
function stream(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: "inherit" });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(
          new TeardownError(
            `\`${cmd}\` is not on your PATH.`,
            cmd === "docker"
              ? dockerInstallHint(hostPlatform())
              : "Run `npm ci` in the repo root.",
          ),
        );
        return;
      }
      reject(err);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function succeeds(cmd: string, args: string[]): boolean {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "ignore" });
  return !r.error && r.status === 0;
}

function supabaseBin(): string | null {
  const bin = path.join(ROOT, "node_modules", ".bin", "supabase");
  return fs.existsSync(bin) ? bin : null;
}

/**
 * Ask before destroying data.
 *
 * Refuses rather than assuming "yes" when stdin is not a terminal: this script
 * is reachable from `/mixos init` and from CI-ish contexts, and a silently
 * auto-confirmed database wipe is exactly the surprise worth engineering
 * against. `--yes` is the explicit opt-in.
 */
async function confirmReset(assumeYes: boolean): Promise<void> {
  if (assumeYes) return;

  if (!process.stdin.isTTY) {
    throw new TeardownError(
      "`--reset` deletes the local database, and there is no terminal here to confirm on.",
      "Re-run interactively, or pass --yes: `npm run docker:reset -- --yes`.",
    );
  }

  console.log("");
  console.log(
    c.yellow(
      c.bold(
        INSTANCE.isDefault
          ? "  This deletes the local Postgres volume."
          : `  This deletes the local Postgres volume of instance "${INSTANCE.name}".`,
      ),
    ),
  );
  console.log("");
  console.log("  Gone for good:");
  console.log("    - every user account, including the seeded admin");
  console.log("    - every connector credential you have configured locally");
  console.log("    - every app's tables and rows");
  console.log("");
  console.log(
    c.dim("  Nothing on Vercel or in a hosted Supabase project is touched."),
  );
  console.log(
    c.dim(
      "  The next `npm run dev:docker` re-applies migrations and re-seeds the admin.",
    ),
  );
  console.log("");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (await rl.question("  Type 'reset' to continue: ")).trim();
    if (answer !== "reset") {
      console.log("\nCancelled. Nothing was stopped or deleted.");
      process.exit(0);
    }
  } finally {
    rl.close();
  }
}

type Args = { reset: boolean; yes: boolean; help: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { reset: false, yes: false, help: false };
  for (const arg of argv) {
    switch (arg) {
      case "--reset":
        args.reset = true;
        break;
      case "--yes":
      case "-y":
        args.yes = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new TeardownError(
          `Unknown option "${arg}".`,
          "Run `npx tsx scripts/docker-down.ts --help` to see the accepted flags.",
        );
    }
  }
  return args;
}

const HELP = `
Stop the local MixOS stack.

  npm run docker:down             stop the app and Supabase, keep the database
  npm run docker:reset            also delete the database (asks first)

Flags (pass through npm with --, e.g. \`npm run docker:reset -- --yes\`):
  --reset     delete the local Postgres volume after stopping
  --yes, -y   skip the --reset confirmation prompt
  --help      this text
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP.trim());
    return;
  }

  // Before the reset prompt, so nobody confirms deleting a database that is
  // not even this checkout's. One name, one owner (scripts/instance-claims.ts):
  // a checkout that only shares the name would stop that owner's MixOS, and
  // with --reset delete its data.
  const owner = ownedElsewhere(INSTANCE.name, ROOT);
  if (owner) {
    throw new TeardownError(
      `Not stopping \`${INSTANCE.name}\`: it belongs to another checkout.`,
      notYourInstance(INSTANCE.name, owner, args.reset ? "a reset" : "stopping it"),
    );
  }

  if (args.reset) await confirmReset(args.yes);

  // Nothing below can succeed without a daemon, and "Cannot connect to the
  // Docker daemon" three times over is a worse answer than the true one.
  if (!succeeds("docker", ["info"])) {
    console.log(
      `\n${c.green("Docker is not running")}, so nothing is up to stop.` +
        (args.reset
          ? `\n${c.yellow("Note:")} the database volume was NOT deleted — start Docker Desktop and re-run to reset it.`
          : ""),
    );
    return;
  }

  const failures: string[] = [];

  // ── 1. app containers ──
  // Skipped rather than attempted when the compose inputs are absent: compose
  // refuses to parse a file whose `env_file:` targets are missing, and
  // .env.docker.local is generated by docker-up.ts, so its absence means the app
  // side was never brought up in the first place.
  const composeFile = path.join(ROOT, "docker-compose.yml");
  const generatedEnv = path.join(ROOT, ".env.docker.local");
  if (!fs.existsSync(composeFile)) {
    console.log(
      `\n${c.dim("docker-compose.yml not found — skipping the app containers.")}`,
    );
  } else if (!fs.existsSync(generatedEnv)) {
    console.log(
      `\n${c.dim(".env.docker.local not found — the app containers were never started, skipping.")}`,
    );
  } else {
    console.log(`\n${c.bold("Stopping the app containers...")}`);
    // Both profiles, always: a service belonging to an inactive profile is
    // invisible to compose, so a `down` for only the dev profile would leave a
    // prod `app` container running and still holding port 3000.
    const code = await stream("docker", [
      "compose",
      "-p",
      INSTANCE.name,
      "--profile",
      "dev",
      "--profile",
      "prod",
      "down",
    ]);
    if (code !== 0) failures.push(`\`docker compose down\` exited ${code}`);
  }

  // ── 2. Supabase ──
  const supabase = supabaseBin();
  const supabaseConfig = path.join(ROOT, "supabase", "config.toml");
  if (!supabase) {
    console.log(
      `\n${c.dim("Supabase CLI not installed (run `npm ci`) — skipping Supabase.")}`,
    );
  } else if (!fs.existsSync(supabaseConfig)) {
    console.log(
      `\n${c.dim("supabase/config.toml not found — no local stack to stop.")}`,
    );
  } else {
    console.log(
      `\n${c.bold(args.reset ? "Stopping Supabase and deleting its data..." : "Stopping Supabase...")}`,
    );
    // --project-id scopes this to this instance's stack. Without it a developer
    // with another Supabase project running loses it too, and `--all` does that
    // on purpose — never use it here. The command is idempotent: on an
    // already-stopped stack it exits 0 with {"message":"Stopped supabase local
    // development setup."}.
    const stopArgs = ["stop", "--project-id", INSTANCE.name];
    // --no-backup is the flag that discards the data volumes; plain `stop`
    // snapshots them so the next `start` restores your data.
    if (args.reset) stopArgs.push("--no-backup");
    const code = await stream(supabase, stopArgs);
    if (code !== 0) failures.push(`\`supabase stop\` exited ${code}`);
  }

  console.log("");
  if (failures.length > 0) {
    throw new TeardownError(
      `Teardown finished with errors:\n    - ${failures.join("\n    - ")}`,
      "Scroll up for the underlying error. `docker ps` shows what is still running; " +
        "`docker rm -f <id>` removes a stuck container by hand.",
    );
  }

  console.log(
    c.green(
      args.reset
        ? "Stack stopped and local database deleted."
        : "Stack stopped.",
    ),
  );
  if (args.reset) {
    console.log(
      c.dim(
        "  The compose volumes holding the dev container's node_modules and .next cache\n" +
          `  are kept — drop them too with \`docker volume ls | grep ${INSTANCE.name}\` if you need to.`,
      ),
    );
  }
  console.log(c.dim("  Start it again with `npm run dev:docker`."));
}

function reportAndExit(err: unknown): never {
  if (err instanceof TeardownError) {
    console.error(`\n${c.red("docker-down failed:")} ${err.message}`);
    console.error(`\n${c.bold("What to do:")} ${err.next}\n`);
  } else {
    console.error(`\n${c.red("docker-down failed unexpectedly.")}`);
    console.error(err);
    console.error(
      `\n${c.bold("What to do:")} this is a bug in scripts/docker-down.ts — the stack trace above is the report.\n`,
    );
  }
  process.exit(1);
}

process.on("unhandledRejection", reportAndExit);

main().catch(reportAndExit);
