/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// `npm run dev`: Next's dev server on this computer, with what it takes to be
// easy rather than merely possible. The dev container runs this same script —
// its command is `npm run dev` — and there it is a plain `next dev`, because
// docker-up.ts has settled everything below from outside.
//
// ── THE DATABASE ────────────────────────────────────────────────────────────
// With no database named anywhere (the shell, .env.local, .env) and this
// instance's Supabase stack running, from `npm run dev:docker` or its
// `--db-only`, the server gets that stack's database at its host-facing
// address, with .env.docker's dev-only values beside it. Those are the
// container's own values, so a session or a saved connector credential carries
// over between the two ways of running. They go in through the child's
// environment, never a written file: nothing to go stale, nothing that
// outlives the run. With no stack running either, a person at a terminal is
// offered one.
//
// Gated as scripts/load-env.ts gates the same fallback, and for the same
// reason: .env.docker's PGSSLMODE=disable and its public AUTH_SECRET belong to
// that database only. A checkout with a .env.local, or a database of its own,
// is left exactly as it is.
//
// ── THE PORT ────────────────────────────────────────────────────────────────
// 3000, or `-p`. When something already has it, this says what, and offers the
// next free port — or, when it is this instance's own app container, to stop
// that and take its place. With nobody at the keyboard it exits with the
// command to run instead. Passing `-p` to Next always is deliberate: given no
// port, Next moves to the next one by itself, and the server ends up on a URL
// that nothing printed.
//
// ── THE ANSWER ──────────────────────────────────────────────────────────────
// Next's "Ready" means a process is listening. Once the app answers, this asks
// it the questions in checkApp() (./local-stack), prints the summary, and
// opens the browser for a person at a terminal.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Instance, resolveInstance } from "./instance";
import { ownedElsewhere } from "./instance-claims";
import {
  type Check,
  type Fixes,
  type LocalDatabase,
  ROOT,
  allOk,
  appAnswers,
  appUrl,
  browserWanted,
  c,
  checkApp,
  checkReachable,
  configuredDatabase,
  confirm,
  describeHolder,
  formatSummary,
  identifyPortHolder,
  interactive,
  localSignIn,
  localSupabase,
  nextFreePort,
  openBrowser,
  parseEnvFile,
  portInUse,
  tilde,
} from "./local-stack";

const NEXT = path.join(ROOT, "node_modules", ".bin", "next");

/** How long a first compile may take before the summary reports Next as down. */
const ANSWER_TIMEOUT_MS = 180_000;

export type DevArgs = { port: number | null; noOpen: boolean; rest: string[] };

function toPort(raw: string | undefined, from: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65_535) {
    throw new Error(`${from} wants a port number between 1 and 65535. Got "${raw ?? ""}".`);
  }
  return n;
}

/**
 * Take out what this script owns — the port and `--no-open` — and pass the
 * rest to Next untouched, so `npm run dev -- --turbopack` still means what
 * Next says it means.
 */
export function parseDevArgs(argv: string[]): DevArgs {
  const out: DevArgs = { port: null, noOpen: false, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const inline = /^(-p|--port)=(.*)$/.exec(arg);
    if (arg === "-p" || arg === "--port") out.port = toPort(argv[++i], arg);
    else if (inline) out.port = toPort(inline[2], inline[1]);
    else if (arg === "--no-open") out.noOpen = true;
    else out.rest.push(arg);
  }
  return out;
}

/**
 * Inside the dev container. The compose service says so; /.dockerenv is the
 * fallback for a container started some other way.
 */
function inContainer(): boolean {
  return process.env.MIXOS_CONTAINER === "1" || fs.existsSync("/.dockerenv");
}

function fail(message: string): never {
  console.error(`\n${c.red("npm run dev:")} ${message}\n`);
  process.exit(1);
}

function info(message: string) {
  console.log(`    ${message}`);
}

/**
 * Run `next dev` in the foreground and exit with it. A terminal's Ctrl-C
 * reaches the whole process group, Next included, so this only waits for Next
 * to finish; a signal sent to this process alone — `kill`, or a container stop
 * relayed through tini and npm — is passed on.
 */
function runNext(args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(NEXT, ["dev", ...args], { cwd: ROOT, stdio: "inherit", env });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (err) =>
    fail(`could not start Next (${err.message}). Run \`npm ci\` in the repo root and try again.`),
  );
  child.on("exit", (code, signal) => {
    process.exit(signal ? 128 + (os.constants.signals[signal] ?? 1) : (code ?? 1));
  });
  return child;
}

// ── The database ────────────────────────────────────────────────────────────

type Database =
  /** Named by the person: the shell, .env.local or .env. Never touched. */
  | { kind: "own"; source: string }
  /** This instance's local Supabase stack, handed to Next through its env. */
  | { kind: "local"; db: LocalDatabase; envDocker: Record<string, string> }
  /** A .env.local that names no database: the hosted path, half set up. */
  | { kind: "unnamed" }
  /** This checkout's instance name is another folder's (scripts/instance-claims.ts). */
  | { kind: "shared"; owner: string; instance: string; named: boolean }
  | { kind: "none" };

function findDatabase(instance: Instance): Database {
  const source = configuredDatabase();
  if (source) return { kind: "own", source };
  // load-env.ts's rule: a .env.local means someone is configuring their own
  // database, and the local stack's values must not be mixed into it.
  if (fs.existsSync(path.join(ROOT, ".env.local"))) return { kind: "unnamed" };
  // A stack under this checkout's name that another folder owns is that
  // folder's database, however reachable it is from here.
  const owner = ownedElsewhere(instance.name, ROOT);
  if (owner) {
    return { kind: "shared", owner, instance: instance.name, named: instance.nameSource !== "default" };
  }
  const db = localSupabase();
  if (!db) return { kind: "none" };
  return { kind: "local", db, envDocker: parseEnvFile(path.join(ROOT, ".env.docker")) };
}

/**
 * The child's environment for the local database. The shell still wins over
 * .env.docker, as it does everywhere; the connection is the stack's own, at
 * 127.0.0.1, because this is the host side of the two-address split
 * (docs/local-docker.md). The origin follows the port this run settled on.
 */
function localEnv(database: Extract<Database, { kind: "local" }>, port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(database.envDocker)) {
    if (!(key in env)) env[key] = value;
  }
  env.DATABASE_URL = database.db.dbUrl;
  env.PGSSLMODE = "disable";
  env.NEXTAUTH_URL = process.env.NEXTAUTH_URL ?? appUrl(port);
  return env;
}

function describeDatabase(database: Database): string {
  switch (database.kind) {
    case "own":
      return `yours, from ${database.source}`;
    case "local": {
      const at = new URL(database.db.dbUrl);
      return `the local one at ${at.hostname}:${at.port}, from \`npm run dev:docker\``;
    }
    case "unnamed":
      return c.yellow(".env.local names no database (DATABASE_URL)");
    case "shared":
      return c.yellow(`none of its own: \`${database.instance}\` is ${tilde(database.owner)}'s`);
    case "none":
      return c.yellow("none running — see the summary once the server is up");
  }
}

function fixesFor(database: Database): Fixes {
  const restart = "then restart `npm run dev`";
  return {
    notRunning: "Next didn't come up. Its own output, above, says why.",
    noDatabase:
      database.kind === "own"
        ? `The app can't reach the database named in ${database.source}. Check DATABASE_URL, ` +
          "and PGSSLMODE=disable for a Postgres on this computer."
        : database.kind === "local"
          ? `The local database stopped answering. \`npm run dev:docker -- --db-only\` starts it, ${restart}.`
          : database.kind === "unnamed"
            ? "Add DATABASE_URL to .env.local (docs/hosting/development.md), or remove .env.local to " +
              `use the local database from \`npm run dev:docker -- --db-only\`; ${restart}.`
            : database.kind === "shared"
              ? (database.named
                  ? `MIXOS_INSTANCE names ${tilde(database.owner)}'s instance. Take it out of .env.instance ` +
                    "or the shell, and "
                  : "This checkout has no database of its own yet. ") +
                `\`npm run dev:docker -- --db-only\` gives it one, ${restart}.`
              : `Start the local database with \`npm run dev:docker -- --db-only\`, ${restart}.`,
    schemaBehind:
      database.kind === "own"
        ? "Apply the platform migrations with `npm run db:migrate`, then reload."
        : "Apply the new platform migrations with `npm run db:local`, then reload.",
  };
}

// ── The port ────────────────────────────────────────────────────────────────

/** The port to run on, settled with the person if something already has it. */
async function settlePort(port: number, instance: string): Promise<number> {
  if (!(await portInUse(port))) return port;

  const holder = identifyPortHolder(port, { instance, root: ROOT });
  const url = appUrl(port);
  info(`${c.yellow("!")} ${describeHolder(holder)} is already on ${url}.`);

  if (holder.kind === "this-checkout") {
    fail(`this checkout is already running there. Open ${url}, or stop that server first (Ctrl-C in its terminal).`);
  }

  if (holder.kind === "this-instance") {
    const stop = ["compose", "-p", instance, "stop", holder.service];
    if (!interactive()) {
      fail(
        `MixOS is already running at ${url}, in Docker. Open it, or stop the container first with ` +
          `\`docker ${stop.join(" ")}\` and re-run.`,
      );
    }
    const from = holder.checkout ? ` from ${tilde(holder.checkout)}` : "";
    if (await confirm(`That's this instance's MixOS, in Docker${from}. Stop the container and run here instead?`)) {
      // The cron sidecar is left running: it falls back to this host's port
      // 3000 when the app container is gone (docker-compose.yml).
      if (spawnSync("docker", stop, { cwd: ROOT, stdio: "inherit" }).status !== 0) {
        fail(`\`docker ${stop.join(" ")}\` failed. Docker's own error is above.`);
      }
      return port;
    }
    info(`It's already up: open ${url}.`);
    process.exit(0);
  }

  const next = await nextFreePort(port);
  if (!next) fail(`no port from ${port + 1} to ${port + 20} is free either. Stop something and re-run.`);
  if (interactive() && (await confirm(`Start this one on ${appUrl(next)} instead?`))) return next;
  fail(`run this one on the next free port: \`npm run dev -- -p ${next}\`.`);
}

// ── The answer ──────────────────────────────────────────────────────────────

async function announceWhenUp(
  port: number,
  database: Database,
  noOpen: boolean,
  signal: AbortSignal,
): Promise<void> {
  const url = appUrl(port);
  const deadline = Date.now() + ANSWER_TIMEOUT_MS;
  while (!signal.aborted && Date.now() < deadline && !(await appAnswers(url))) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (signal.aborted) return;

  const checks: Check[] = await checkApp(url, {
    fixes: fixesFor(database),
    signIn: database.kind === "local" ? localSignIn(database.envDocker) : undefined,
  });
  if (database.kind === "local" && database.db.studioUrl) {
    checks.push(
      await checkReachable(
        "Studio",
        database.db.studioUrl,
        "browse and edit the database",
        "`npm run dev:docker -- --db-only` starts it again.",
      ),
    );
  }
  if (signal.aborted) return;

  const ok = allOk(checks);
  process.stdout.write(
    formatSummary({
      headline: ok ? `MixOS is up at ${url}` : `MixOS started at ${url}, but it isn't ready — see below`,
      checks,
      notes: [
        "`npm run status` asks all of this again, any time, from any terminal.",
        "Ctrl-C stops the server.",
      ],
    }),
  );
  if (ok && browserWanted(noOpen)) openBrowser(url);
}

async function main() {
  const argv = process.argv.slice(2);
  if (inContainer()) {
    runNext(argv, process.env);
    return;
  }

  let instance = resolveInstance();
  const args = parseDevArgs(argv);
  const envPort = process.env.PORT ? toPort(process.env.PORT, "PORT") : null;

  console.log(c.bold(`\nMixOS dev server — ${tilde(ROOT)}`));

  // The database first: starting one can give this checkout an instance of
  // its own, and the port question below is about that instance's containers.
  let database = findDatabase(instance);
  // A shared name somebody wrote is theirs to change (docker-up.ts refuses to),
  // so only an unnamed checkout is offered one of its own here.
  const offerable = database.kind === "none" || (database.kind === "shared" && !database.named);
  if (offerable && interactive()) {
    info(
      `${c.yellow("!")} ` +
        (database.kind === "shared"
          ? `This checkout has no database of its own: \`${database.instance}\` is ${tilde(database.owner)}'s.`
          : "No database is set up for this checkout, and its local one isn't running."),
    );
    const offer =
      database.kind === "shared"
        ? "Give this checkout its own, with a fresh database, now? It runs in Docker."
        : "Start the local database now? It runs in Docker, and the first start takes a while.";
    if (await confirm(offer)) {
      // The child resolves the instance itself and may write .env.instance;
      // MIXOS_SHELL_KEYS (scripts/instance.ts) keeps what this process wrote
      // back from passing for the person's own setting.
      const started = spawnSync("npm", ["run", "dev:docker", "--", "--db-only"], {
        cwd: ROOT,
        stdio: "inherit",
      });
      if (started.status !== 0) fail("the database didn't start. Its output, above, says why.");
      instance = resolveInstance();
      database = findDatabase(instance);
    }
  }

  const port = await settlePort(args.port ?? envPort ?? instance.ports.app, instance.name);
  info(`Instance   \`${instance.name}\``);

  info(`Database   ${describeDatabase(database)}`);
  info(`Port       ${port}`);
  info(c.dim("A summary prints here once the server answers."));
  console.log("");

  const env = database.kind === "local" ? localEnv(database, port) : process.env;
  const child = runNext(["-p", String(port), ...args.rest], env);
  const watcher = new AbortController();
  child.on("exit", () => watcher.abort());
  void announceWhenUp(port, database, args.noOpen, watcher.signal);
}

if (require.main === module) {
  main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
}
