/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Boots the whole local stack in one command: Supabase (Postgres + PostgREST +
// Studio) through the Supabase CLI, then MixOS itself through Docker Compose.
//
// The step order is not cosmetic — each step produces something the next one
// needs:
//
//   preflight -> supabase start -> read status -> write .env.docker.local
//             -> platform migrations -> app migrations -> seed admin
//             -> docker compose up
//
// Compose reads `.env.docker.local` at `up` time, so it has to exist before
// step 7; the app migrations need the platform schema (public._migrations)
// that step 5 creates; and seed-admin needs the public.users table from the
// same migration. Reordering any of these produces a failure whose message
// points at the wrong thing.
//
// THE TWO-ADDRESS SPLIT is the single most confusing thing about this setup and
// is worth stating up front. Supabase runs as CLI-managed containers with their
// ports published on the host. Two different consumers therefore need two
// different spellings of the same database:
//
//   host tooling (steps 5-6, and `npm run dev` on the host)  -> 127.0.0.1
//   our containers (app-dev / app / cron)                    -> host.docker.internal
//
// Both are derived from one `supabase status -o json` read rather than written
// down twice, because a hand-copied pair drifts and the failure mode (a
// connection refused from inside a container only) reads like a permissions
// bug rather than an address bug.
//
// ATTACHED VS DETACHED. By default this ends in an *attached* `docker compose
// up` and never returns: the terminal becomes the container log stream, and
// Ctrl-C is how a session ends. Ctrl-C stops the app containers only — the
// Supabase CLI stack this script started stays up, which is why the second run
// of the day is fast. That is the right shape for a human watching logs, and
// the wrong shape for anything scripted: an agent or a CI step that runs this
// as an ordinary foreground command blocks until its own timeout, and the kill
// that follows lands on the compose foreground process group and tears down the
// stack the command just finished building. The caller sees a hang, then a
// half-stopped machine, and never reaches whatever it meant to do next.
//
// `--detach` is the mode for those callers: compose up with -d, then poll
// /api/health/ready until the app genuinely serves, then print the summary and
// exit 0. The poll is the point — `compose up -d` returns as soon as the
// containers are *created*, which is several seconds to several minutes before
// Next has compiled a route and opened a connection to Postgres, so exiting on
// compose's own success would hand the caller a URL that 502s.
//
// "UP" MEANS ASKED, NOT ASSUMED. Either way the run ends on a summary that the
// running app produced: it answers, it reaches Postgres with the schema this
// code expects, and the sign-in page renders — a ✓ or a ✗ with its fix per
// line (checkApp() in ./local-stack). Attached, a watcher polls alongside the
// log stream and prints it the moment the app first answers, then opens the
// browser for a person at a terminal. Detached, it prints after the readiness
// poll. `npm run status` prints the same summary later, from any terminal.
//
// THE APP PORT is 3000, unless another MixOS already has it. Then the
// preflight says which one, and offers the next free port to a person at the
// keyboard; anyone else gets the command that uses it. Whatever port the run
// settles on is the one compose publishes (MIXOS_PORT), the app's own origin
// (NEXTAUTH_URL, set from it in docker-compose.yml), and what the summary
// prints.
//
// Usage:
//   npm run dev:docker            dev profile (bind-mounted source, hot reload)
//   npm run docker:prod           prod profile (standalone image, production parity)
//   npm run dev:docker -- --detach           boot, wait for ready, return to the prompt
//   npm run dev:docker -- --db-only          the database only, for a host `npm run dev`
//   npx tsx scripts/docker-up.ts --check     preflight only, changes nothing

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  PLATFORM_LABEL,
  checkoutOwner,
  composeInstallHint,
  dockerInstallHint,
  hostPlatform,
  windowsDockerDesktop,
} from "./host-platform";
import { resolveInstance } from "./instance";
import {
  type Check,
  allOk,
  appAnswers,
  appUrl,
  browserWanted,
  c,
  capture,
  checkApp,
  checkReachable,
  confirm,
  describeHolder,
  formatSummary,
  identifyPortHolder,
  interactive,
  localSignIn,
  looksLikeDocker,
  nextFreePort,
  openBrowser,
  parseEnvFile,
  portHolder,
  portInUse,
  samePath,
  tilde,
} from "./local-stack";
import { listPlatformMigrations } from "./platform-migration-files";

const ROOT = path.resolve(__dirname, "..");

// Resolved FIRST, because it writes MIXOS_* into process.env and every child
// process below — `docker compose`, the Supabase CLI — reads its identity from
// there. See scripts/instance.ts.
const INSTANCE = resolveInstance();

/** macOS, Linux, or Windows via WSL 2 — see scripts/host-platform.ts. */
const PLATFORM = hostPlatform();

// On Linux and in WSL the dev container must write the checkout as the person
// who owns it, not as root — see checkoutOwner(). Exported here, before any
// child process starts, because compose reads it from the environment when it
// renders docker-compose.yml.
const OWNER = checkoutOwner(PLATFORM);
if (OWNER) {
  process.env.MIXOS_UID = String(OWNER.uid);
  process.env.MIXOS_GID = String(OWNER.gid);
}

/**
 * Compose project name.
 *
 * `mixos` unless this checkout says otherwise in `.env.instance`. It has to
 * match docker-down.ts, which resolves the same way from the same file rather
 * than repeating a literal.
 */
const COMPOSE_PROJECT = INSTANCE.name;

// Used for the *pre-start* port check, when there is no running stack to ask.
// Once the stack is up the real Supabase ports come from `supabase status`,
// which is authoritative even if someone edits supabase/config.toml.
const PORTS = {
  supabaseApi: INSTANCE.ports.supabaseApi,
  supabaseDb: INSTANCE.ports.supabaseDb,
  supabaseStudio: INSTANCE.ports.supabaseStudio,
} as const;

/**
 * Where the app is published on the host. The instance's port (3000 unless
 * MIXOS_PORT says otherwise) until the preflight finds another MixOS on it and
 * the person takes the next free one instead — which is why it is not a
 * constant, and why it is written back to MIXOS_PORT for compose.
 */
let appPort = INSTANCE.ports.app;

/** How long to wait for the Docker daemon after launching Docker Desktop. */
const DOCKER_BOOT_TIMEOUT_MS = 180_000;
const DOCKER_POLL_INTERVAL_MS = 2_000;

/** Docker Desktop's default VM allocation is generous, but not always. */
const MIN_DOCKER_MEMORY_BYTES = 4 * 1024 * 1024 * 1024;

// How long `--detach` waits for the app to answer before giving up. Three
// minutes is sized for the slowest honest case, not the common one: a cold dev
// container compiling the route tree with Turbopack on a first boot, or a prod
// container that still has to start after a fresh image build. The common case
// finishes in a few seconds. Waiting too briefly is the worse failure — it
// reports a working stack as broken and invites the caller to tear it down and
// start over, which is strictly slower than having waited.
const READY_TIMEOUT_MS = 180_000;
const READY_POLL_INTERVAL_MS = 1_000;
/** Per-attempt cap, so a hung socket cannot eat the whole budget in one poll. */
const READY_REQUEST_TIMEOUT_MS = 5_000;

// ── Output helpers ──────────────────────────────────────────────────────────
//
// Colours, capture(), parseEnvFile() and the port probes live in
// ./local-stack, shared with `npm run dev` and `npm run status`.

let stepNumber = 0;
function step(label: string) {
  stepNumber += 1;
  console.log(`\n${c.bold(`[${stepNumber}]`)} ${c.bold(label)}`);
}

function info(message: string) {
  console.log(`    ${message}`);
}

/**
 * A failure the user can act on, as opposed to a bug in this script. Everything
 * thrown deliberately carries a `next` line, because "docker compose exited 1"
 * with no follow-up is the exact experience this whole script exists to avoid.
 */
class SetupError extends Error {
  readonly next: string;
  constructor(message: string, next: string) {
    super(message);
    this.name = "SetupError";
    this.next = next;
  }
}

// ── Process helpers ─────────────────────────────────────────────────────────
//
// Every command is an argument array. Nothing is interpolated into a shell:
// paths here are machine-local and can contain spaces, and a shell would also
// make the service-role key visible in `ps` output.

/** Run a command purely for its exit code. */
function succeeds(cmd: string, args: string[]): boolean {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "ignore" });
  return !r.error && r.status === 0;
}

type StreamOptions = {
  env?: NodeJS.ProcessEnv;
  /**
   * Ignore SIGINT/SIGTERM in this process while the child runs. The terminal
   * delivers Ctrl-C to the whole foreground process group, so without this both
   * we and the child react: we would exit first and orphan the child mid
   * shutdown. Used for the long-lived `docker compose up`.
   */
  childOwnsSignals?: boolean;
};

/** Run a command with its output streaming straight through to the terminal. */
function stream(
  cmd: string,
  args: string[],
  opts: StreamOptions = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      stdio: "inherit",
      env: opts.env ?? process.env,
    });

    const swallow = () => {};
    if (opts.childOwnsSignals) {
      process.on("SIGINT", swallow);
      process.on("SIGTERM", swallow);
    }
    const cleanup = () => {
      if (!opts.childOwnsSignals) return;
      process.off("SIGINT", swallow);
      process.off("SIGTERM", swallow);
    };

    child.on("error", (err: NodeJS.ErrnoException) => {
      cleanup();
      if (err.code === "ENOENT") {
        reject(
          new SetupError(
            `\`${cmd}\` is not on your PATH.`,
            cmd === "docker"
              ? dockerInstallHint(PLATFORM)
              : `Install ${cmd} and re-run.`,
          ),
        );
        return;
      }
      reject(err);
    });

    child.on("close", (code, signal) => {
      cleanup();
      // 128 + signal number is the shell convention; SIGINT is 2.
      resolve(signal ? (signal === "SIGINT" ? 130 : 1) : (code ?? 1));
    });
  });
}

// ── Supabase CLI ────────────────────────────────────────────────────────────

/**
 * Resolve the repo-local Supabase CLI rather than shelling out to `npx`.
 * `npx supabase` would happily download a *different* version from the registry
 * if node_modules were missing, and the local stack's behaviour (config schema,
 * emitted status keys) is version-specific enough that a silent upgrade is a
 * worse outcome than a clear "run npm ci".
 */
function supabaseBin(): string {
  const bin = path.join(ROOT, "node_modules", ".bin", "supabase");
  if (!fs.existsSync(bin)) {
    throw new SetupError(
      "The Supabase CLI is not installed in this repo (node_modules/.bin/supabase is missing).",
      "Run `npm ci` in the repo root, then re-run this command.",
    );
  }
  return bin;
}

/** Exactly the keys `supabase status -o json` emits that we depend on. */
const STATUS_KEYS = {
  apiUrl: "API_URL",
  dbUrl: "DB_URL",
  studioUrl: "STUDIO_URL",
} as const;

type SupabaseStatus = {
  apiUrl: string;
  dbUrl: string;
  studioUrl: string;
};

/**
 * Non-throwing probe used to decide whether `supabase start` is needed at all.
 *
 * With no containers at all the CLI exits 1 with "No such container:
 * supabase_db_<id>" on stderr; with a healthy stack it exits 0 and writes only
 * the JSON object to stdout (warnings and the "Stopped services: [...]" line go
 * to stderr). That makes "exit 0 and parseable" a good enough liveness signal
 * for the fast path. The strict read happens later in readSupabaseStatus(),
 * which is where a partially-up stack gets caught.
 */
function probeSupabaseRunning(): boolean {
  const r = capture(supabaseBin(), ["status", "-o", "json"]);
  if (r.status !== 0) return false;
  try {
    const parsed: unknown = JSON.parse(r.stdout);
    if (typeof parsed !== "object" || parsed === null) return false;
    const obj = parsed as Record<string, unknown>;
    return (
      typeof obj[STATUS_KEYS.apiUrl] === "string" &&
      typeof obj[STATUS_KEYS.dbUrl] === "string"
    );
  } catch {
    return false;
  }
}

/**
 * Read the stack's real addresses.
 *
 * Hardcoding these would be shorter and wrong: the ports follow the instance
 * (scripts/instance.ts) and the CLI's own defaults, and a stale copy fails as a
 * connection error several minutes downstream rather than as "this address is
 * out of date". So we read, and we refuse to continue if any key is absent.
 *
 * Only the database URL reaches the app. MixOS doesn't talk to the Supabase
 * API, so no API key is read; the API and Studio addresses are read for the
 * summary.
 */
function readSupabaseStatus(): SupabaseStatus {
  const r = capture(supabaseBin(), ["status", "-o", "json"]);
  if (r.status !== 0) {
    throw new SetupError(
      `\`supabase status -o json\` failed:\n${r.stderr.trim() || r.stdout.trim()}`,
      "Run `npm run docker:down` and try again; if it persists, `npm run docker:reset` for a clean start.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    throw new SetupError(
      `Could not parse \`supabase status -o json\` output:\n${r.stdout.slice(0, 500)}`,
      "The Supabase CLI's output format may have changed. Check the installed version with `npx supabase --version`.",
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new SetupError(
      "`supabase status -o json` did not return a JSON object.",
      "Check the installed CLI version with `npx supabase --version`.",
    );
  }

  const obj = parsed as Record<string, unknown>;
  const read = (key: string): string | null => {
    const v = obj[key];
    return typeof v === "string" && v.length > 0 ? v : null;
  };

  const apiUrl = read(STATUS_KEYS.apiUrl);
  const dbUrl = read(STATUS_KEYS.dbUrl);
  const studioUrl = read(STATUS_KEYS.studioUrl);

  const missing: string[] = [];
  if (!apiUrl) missing.push(STATUS_KEYS.apiUrl);
  if (!dbUrl) missing.push(STATUS_KEYS.dbUrl);
  if (!studioUrl) missing.push(STATUS_KEYS.studioUrl);

  if (missing.length > 0) {
    throw new SetupError(
      `\`supabase status -o json\` is missing: ${missing.join(", ")}.`,
      "Some Supabase containers are not running. Try `npm run docker:down` then `npm run dev:docker`.",
    );
  }

  return {
    apiUrl: apiUrl!,
    dbUrl: dbUrl!,
    studioUrl: studioUrl!,
  };
}

/**
 * Rewrite a loopback URL so a container can reach it.
 *
 * Parsed rather than string-replaced: a password in the DB URL could itself
 * contain "127.0.0.1" or "localhost", and only the host component should move.
 * `host.docker.internal` is not free — it resolves only because every compose
 * service declares `extra_hosts: ["host.docker.internal:host-gateway"]`. On
 * Docker Desktop for macOS the name does NOT exist in a container by default.
 */
function toContainerAddress(url: string): string {
  const parsed = new URL(url);
  if (
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "localhost" ||
    parsed.hostname === "::1"
  ) {
    parsed.hostname = "host.docker.internal";
  }
  // The WHATWG parser normalises a bare origin ("http://h:54321") to a trailing
  // slash, so keep one bare. A postgres URL carries a database path and passes
  // through unchanged.
  const out = parsed.toString();
  return parsed.pathname === "/" && !parsed.search && !parsed.hash
    ? out.replace(/\/$/, "")
    : out;
}

// ── Preflight ───────────────────────────────────────────────────────────────

type CheckState = "ok" | "warn" | "fail";
type CheckResult = { state: CheckState; label: string; detail?: string };

/**
 * Collects preflight results. In a normal run a failure throws immediately —
 * fail fast, with the one message that matters. Under `--check` failures are
 * recorded instead, so one pass reports everything wrong with the machine.
 */
class Preflight {
  readonly results: CheckResult[] = [];
  constructor(private readonly collectOnly: boolean) {}

  ok(label: string, detail?: string) {
    this.results.push({ state: "ok", label, detail });
    console.log(
      `    ${c.green("ok")}   ${label}${detail ? c.dim(`  ${detail}`) : ""}`,
    );
  }

  warn(label: string, detail: string) {
    this.results.push({ state: "warn", label, detail });
    console.log(`    ${c.yellow("warn")} ${label}`);
    console.log(`         ${c.dim(detail)}`);
  }

  fail(label: string, detail: string, next: string): void {
    this.results.push({ state: "fail", label, detail });
    if (!this.collectOnly)
      throw new SetupError(`${label}\n    ${detail.replace(/\n/g, "\n    ")}`, next);
    console.log(`    ${c.red("FAIL")} ${label}`);
    console.log(`         ${c.dim(detail.replace(/\n/g, "\n         "))}`);
    console.log(`         ${c.dim(`-> ${next}`)}`);
  }

  get failed(): boolean {
    return this.results.some((r) => r.state === "fail");
  }
}

function isDockerDaemonUp(): boolean {
  // Bare `docker info`, deliberately. `docker info --format '{{.ServerVersion}}'`
  // exits 0 with empty output when the daemon is down, which makes it useless as
  // a liveness probe.
  return succeeds("docker", ["info"]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `docker info` answers, or give up with `onTimeout`. */
async function waitForDaemon(onTimeout: string): Promise<void> {
  const deadline = Date.now() + DOCKER_BOOT_TIMEOUT_MS;
  let waited = 0;
  while (!isDockerDaemonUp()) {
    if (Date.now() >= deadline) {
      throw new SetupError(
        `The Docker daemon did not come up within ${DOCKER_BOOT_TIMEOUT_MS / 1000}s.`,
        onTimeout,
      );
    }
    await sleep(DOCKER_POLL_INTERVAL_MS);
    waited += DOCKER_POLL_INTERVAL_MS;
    if (waited % 20_000 === 0)
      info(`still waiting for Docker... (${waited / 1000}s)`);
  }
  info(c.green("Docker daemon is up."));
}

/**
 * Launch Docker Desktop on macOS and wait for the daemon to answer.
 *
 * `open -ga Docker` is used rather than `docker desktop start` because the
 * `desktop` CLI plugin only grew start/stop/status recently — on Docker Desktop
 * 4.35 it exposes `version` and `module` and nothing else, so anyone on an older
 * install would take a different, broken code path. `-g` keeps focus in the
 * terminal; the command is a no-op if the app is already running.
 */
async function launchDockerDesktop(): Promise<void> {
  if (!fs.existsSync("/Applications/Docker.app")) {
    throw new SetupError(
      "Docker Desktop is not installed (/Applications/Docker.app is missing).",
      "Install it with: brew install --cask docker-desktop\n" +
        "  Note the --cask flag: `brew install docker` installs the CLI-only formula, " +
        "which gives you a `docker` binary with no daemon behind it.",
    );
  }

  info("Docker daemon is not responding — starting Docker Desktop...");
  const opened = spawnSync("open", ["-ga", "Docker"], { stdio: "ignore" });
  if (opened.status !== 0) {
    throw new SetupError(
      "Could not launch Docker Desktop (`open -ga Docker` failed).",
      "Start Docker Desktop from Applications, wait for the whale icon to stop animating, then re-run.",
    );
  }

  info(
    "If this is Docker's first launch it will ask you to accept the licence and " +
      "may prompt for your password to install its privileged helper — answer those " +
      "prompts and this will continue on its own.",
  );

  await waitForDaemon(
    "Open Docker Desktop and check for an error or an unanswered prompt, then re-run this command.",
  );
}

/**
 * Launch Docker Desktop for Windows from inside WSL and wait for the daemon.
 *
 * WSL can run a Windows executable directly, so this is the same move as
 * `open -ga Docker` on a Mac. Detached and unreferenced: Docker Desktop
 * outlives this script, and must not be killed when it exits.
 */
async function launchWindowsDockerDesktop(): Promise<void> {
  const exe = windowsDockerDesktop();
  if (!exe) {
    throw new SetupError(
      "Docker is not reachable from WSL, and Docker Desktop for Windows is not installed in the usual place.",
      dockerInstallHint("wsl"),
    );
  }

  info("Docker is not responding — starting Docker Desktop for Windows...");
  try {
    spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
  } catch {
    throw new SetupError(
      "Could not launch Docker Desktop from WSL.",
      "Start Docker Desktop from the Windows Start menu, then re-run this command.",
    );
  }

  info(
    "If this is Docker Desktop's first launch, accept the service agreement in its window. " +
      "If it never connects, check Settings -> Resources -> WSL integration is on for this distribution.",
  );

  await waitForDaemon(
    "Open Docker Desktop and check that it is running and that Settings -> Resources -> " +
      "WSL integration is on for this distribution, then re-run this command.",
  );
}

/**
 * What to say when Docker Engine on Linux is not answering.
 *
 * Not started from here: Docker Engine is a system service, and starting it
 * takes root — not something a dev script should reach for on its own. The two
 * common causes need different fixes, and `docker info` says which it is.
 */
function linuxDockerProblem(): SetupError {
  const probe = capture("docker", ["info"]);
  if (/permission denied/i.test(probe.stderr)) {
    return new SetupError(
      "Your user cannot reach the Docker daemon.",
      'Add yourself to the docker group: sudo usermod -aG docker "$USER" — then sign out and back in.\n' +
        "  Group changes only reach new sessions. Until then, run this through the group explicitly:\n" +
        "  sg docker -c 'npm run dev:docker'",
    );
  }
  return new SetupError(
    "The Docker daemon is not running.",
    "Start it: sudo systemctl start docker  (and `sudo systemctl enable docker` to start it at boot).\n" +
      "  If you use Docker Desktop for Linux instead, open it and wait for it to finish starting.",
  );
}

/** Start Docker the way this platform does it, and wait for the daemon. */
async function startDocker(): Promise<void> {
  if (PLATFORM === "macos") return launchDockerDesktop();
  if (PLATFORM === "wsl") return launchWindowsDockerDesktop();
  throw linuxDockerProblem();
}

/** The fix to print when `--check` finds the daemon down, which must not start it. */
function dockerStartHint(): string {
  if (PLATFORM === "linux") return linuxDockerProblem().next;
  if (PLATFORM === "wsl") {
    return "Start Docker Desktop for Windows (a normal `npm run dev:docker` starts it for you and waits).";
  }
  return "Start Docker Desktop (a normal `npm run dev:docker` starts it for you and waits).";
}

type PreflightOutcome = {
  supabaseRunning: boolean;
  envDocker: Record<string, string>;
};

async function preflight(opts: {
  prod: boolean;
  checkOnly: boolean;
  dbOnly: boolean;
  /** This same command, on another app port: what a port conflict recommends. */
  rerun: (port: number) => string;
}): Promise<PreflightOutcome> {
  const pf = new Preflight(opts.checkOnly);

  // ── platform ──
  if (PLATFORM === "windows") {
    pf.fail(
      "Windows needs WSL 2",
      "The local stack runs Linux containers driven from a Linux shell. Git Bash and PowerShell cannot run it.",
      "Install WSL 2 (`wsl --install` in an administrator PowerShell, then restart), install Docker Desktop " +
        "with its WSL integration on, and clone this repository again INSIDE WSL — under your Linux home " +
        "directory, not /mnt/c. Run this from there. docs/local-docker.md has the steps.",
    );
  } else if (PLATFORM === "other") {
    pf.fail(
      `Unsupported platform: ${process.platform}`,
      "The Docker path is built for macOS, Linux, and Windows via WSL 2.",
      "Run it with Node on this machine and a Postgres of your own instead: " +
        "docs/hosting/development.md#with-a-database-of-your-own.",
    );
  } else {
    pf.ok(PLATFORM_LABEL[PLATFORM], OWNER ? `files written as uid ${OWNER.uid}` : undefined);
  }

  // A checkout on the Windows drive works, but badly: every file read crosses
  // from Linux to Windows, and file-change events do not cross at all — so the
  // dev server stops hot-reloading. Advisory, because it does still boot.
  if (PLATFORM === "wsl" && ROOT.startsWith("/mnt/")) {
    pf.warn(
      "This checkout is on the Windows drive",
      `${ROOT} is slow from WSL, and edits made here will not hot-reload. Clone the repository again ` +
        "under your Linux home directory (cd ~ && git clone …) and run it from there.",
    );
  }

  // ── repo files (another dev may have a partial checkout, or a stale branch) ──
  const required: Array<[string, string]> = [
    [
      "docker-compose.yml",
      "The compose file that defines app-dev / app / cron.",
    ],
    [
      ".env.docker",
      "Committed dev-only secrets (AUTH_SECRET, CRON_SECRET, admin login, PGSSLMODE).",
    ],
    ["supabase/config.toml", "Local Supabase stack configuration."],
    [
      opts.prod ? "Dockerfile" : "Dockerfile.dev",
      "The image this profile builds from.",
    ],
  ];
  for (const [rel, why] of required) {
    if (fs.existsSync(path.join(ROOT, rel))) pf.ok(rel);
    else
      pf.fail(
        `Missing ${rel}`,
        why,
        "Your checkout is incomplete. `git status` to see what is missing, or pull the latest main.",
      );
  }

  // ── platform migrations ──
  // On a new volume `supabase start` applies these itself, before this
  // script's own migration step, and the Supabase CLI reports two files with
  // one number only as a duplicate key in its ledger. Listed here, before
  // anything starts, the refusal names both files and the next free number.
  try {
    listPlatformMigrations(path.join(ROOT, "supabase", "migrations"));
    pf.ok("supabase/migrations", "one file per number");
  } catch (err) {
    pf.fail(
      "supabase/migrations",
      err instanceof Error ? err.message : String(err),
      "Fix supabase/migrations as described above, then re-run. Nothing has been started.",
    );
  }

  // ── Supabase CLI ──
  const supabaseInstalled = fs.existsSync(
    path.join(ROOT, "node_modules", ".bin", "supabase"),
  );
  if (supabaseInstalled) pf.ok("Supabase CLI", "node_modules/.bin/supabase");
  else
    pf.fail(
      "Supabase CLI not installed",
      "node_modules/.bin/supabase is missing.",
      "Run `npm ci` in the repo root.",
    );

  // ── docker CLI + compose plugin ──
  let dockerVersion = capture("docker", ["--version"]);
  // In WSL the `docker` command is Docker Desktop's, linked into the
  // distribution only while Desktop runs — so a stopped Desktop looks exactly
  // like Docker not being installed. Start it before deciding which it is.
  if (
    dockerVersion.status !== 0 &&
    PLATFORM === "wsl" &&
    !opts.checkOnly &&
    windowsDockerDesktop()
  ) {
    await launchWindowsDockerDesktop();
    dockerVersion = capture("docker", ["--version"]);
  }
  if (dockerVersion.status === 0) {
    pf.ok("docker CLI", dockerVersion.stdout.trim());
  } else {
    pf.fail(
      "docker is not on your PATH",
      dockerVersion.stderr.trim() || "command not found",
      dockerInstallHint(PLATFORM),
    );
  }

  const composeVersion = capture("docker", ["compose", "version", "--short"]);
  if (composeVersion.status === 0) {
    pf.ok(
      "docker compose",
      `v${composeVersion.stdout.trim().replace(/^v/, "")}`,
    );
  } else {
    pf.fail(
      "The `docker compose` plugin is unavailable",
      composeVersion.stderr.trim() || "docker compose version failed",
      composeInstallHint(PLATFORM),
    );
  }

  // ── daemon ──
  let daemonUp = isDockerDaemonUp();
  if (daemonUp) {
    pf.ok("Docker daemon");
  } else if (opts.checkOnly) {
    // --check must not mutate anything, and launching an application counts.
    pf.fail(
      "Docker daemon is not responding",
      "`docker info` failed.",
      dockerStartHint(),
    );
  } else {
    await startDocker();
    daemonUp = true;
    pf.ok("Docker daemon");
  }

  // ── VM memory (advisory) ──
  if (daemonUp) {
    const mem = capture("docker", ["info", "--format", "{{.MemTotal}}"]);
    const bytes = Number(mem.stdout.trim());
    if (Number.isFinite(bytes) && bytes > 0) {
      const gib = (bytes / 1024 ** 3).toFixed(1);
      if (bytes < MIN_DOCKER_MEMORY_BYTES) {
        const raise =
          PLATFORM === "linux"
            ? "Docker Engine uses the machine's own memory, so this machine is short of it."
            : PLATFORM === "wsl"
              ? "WSL 2 sets Docker's share: raise `memory=` under [wsl2] in %UserProfile%\\.wslconfig, then `wsl --shutdown`."
              : "Raise it in Docker Desktop -> Settings -> Resources if the stack is unstable.";
        pf.warn(
          `Docker has only ${gib} GiB available`,
          `Postgres, PostgREST, Kong, Studio and the app together want ~4 GiB. ${raise}`,
        );
      } else {
        pf.ok("Docker memory", `${gib} GiB`);
      }
    }
  }

  // ── is Supabase already up? ──
  const supabaseRunning =
    daemonUp && supabaseInstalled ? probeSupabaseRunning() : false;
  if (supabaseRunning) pf.ok("Supabase stack", "already running");
  else if (daemonUp && supabaseInstalled)
    pf.ok("Supabase stack", "not running (will start)");

  // ── ports ──
  // The app port is always contested: compose publishes it. `--db-only`
  // publishes no app, so it has none to check. The Supabase ports only matter
  // when we are about to start the stack — if it is already up, it is
  // *supposed* to be holding them.
  if (!opts.dbOnly) await checkAppPort(pf, opts);

  const portsToCheck: Array<[number, string]> = [];
  if (!supabaseRunning) {
    portsToCheck.push(
      [PORTS.supabaseApi, "the Supabase API gateway (Kong)"],
      [PORTS.supabaseDb, "Postgres"],
      [PORTS.supabaseStudio, "Supabase Studio"],
    );
  }

  for (const [port, purpose] of portsToCheck) {
    if (!(await portInUse(port))) {
      pf.ok(`port ${port} free`, purpose);
      continue;
    }
    const holder = portHolder(port);
    if (looksLikeDocker(holder)) {
      // One of our own containers, or another project's. Compose recreates its
      // own; a stranger's container fails at bind time with a clear message.
      pf.warn(
        `port ${port} is published by a container`,
        `${holder} holds it. If that is a previous run of this stack, compose will replace it.`,
      );
      continue;
    }
    pf.fail(
      `port ${port} is already in use`,
      `${holder ?? "an unknown process"} is listening — this port is needed for ${purpose}.`,
      "Another Supabase stack is probably running. Stop it with `npx supabase stop --project-id <its id>` " +
        "(`npx supabase projects list` will not help — check `docker ps` for supabase_db_* containers).",
    );
  }

  const envDocker = parseEnvFile(path.join(ROOT, ".env.docker"));

  if (opts.checkOnly) {
    console.log("");
    if (pf.failed) {
      console.log(c.red("Preflight found blocking problems (listed above)."));
      process.exit(1);
    }
    console.log(
      c.green("Preflight passed — `npm run dev:docker` should work."),
    );
    process.exit(0);
  }

  return { supabaseRunning, envDocker };
}

/**
 * The app port: free, this stack's own, or somebody else's.
 *
 * Somebody else's is the case worth the care. "Port 3000 is already in use" is
 * where people get stuck, and the somebody is usually another MixOS: a second
 * checkout, or a host `npm run dev` left running in a forgotten terminal. So
 * the holder is named, and the next free port is offered — taken on the spot
 * by a person at the keyboard, or handed to anyone else (an agent, CI,
 * `--check`) as the exact command that uses it, since nobody is there to say
 * yes.
 *
 * The one holder that gets no offer is this checkout's own host server. Two
 * servers for one checkout, on two ports, with one database between them, is
 * the confusing state this check exists to prevent; stopping it is the fix.
 */
async function checkAppPort(
  pf: Preflight,
  opts: { checkOnly: boolean; rerun: (port: number) => string },
): Promise<void> {
  if (!(await portInUse(appPort))) {
    pf.ok(`port ${appPort} free`, "the MixOS app");
    return;
  }

  const holder = identifyPortHolder(appPort, { instance: INSTANCE.name, root: ROOT });
  if (holder.kind === "this-instance") {
    // A previous run of this stack: compose replaces its own containers. Booted
    // from another checkout with the same instance name, it is still ours —
    // one name is one instance — but this boot moves it here, and that copy
    // stops serving, which deserves a line rather than a surprise.
    if (holder.checkout && !samePath(holder.checkout, ROOT)) {
      pf.warn(
        `port ${appPort} is instance \`${INSTANCE.name}\`, running from ${tilde(holder.checkout)}`,
        "This checkout is the same instance, so booting here moves it: that copy stops serving. " +
          "To run both at once, give this checkout its own MIXOS_INSTANCE in .env.instance.",
      );
    } else {
      pf.ok(`port ${appPort} is this stack's own app`, "compose will replace it");
    }
    return;
  }

  const next = await nextFreePort(appPort);
  const detail = `${describeHolder(holder)} is already on ${appUrl(appPort)}.`;

  if (holder.kind === "this-checkout") {
    pf.fail(
      `port ${appPort} is already in use`,
      detail,
      "Stop that server (Ctrl-C in its terminal) and re-run" +
        (next ? `, or run both with \`${opts.rerun(next)}\`.` : "."),
    );
    return;
  }

  if (next && !opts.checkOnly && interactive()) {
    pf.warn(`port ${appPort} is taken`, detail);
    if (await confirm(`Start this one on ${appUrl(next)} instead?`)) {
      appPort = next;
      process.env.MIXOS_PORT = String(next);
      pf.ok(`port ${appPort} free`, "the MixOS app, for this run");
      return;
    }
  }

  pf.fail(
    `port ${appPort} is already in use`,
    detail,
    next
      ? `Run this one on the next free port: \`${opts.rerun(next)}\`. ` +
          `To keep it there, add MIXOS_PORT=${next} to .env.instance.`
      : `No port from ${appPort + 1} to ${appPort + 20} is free either. Stop something and re-run.`,
  );
}

// ── Steps ───────────────────────────────────────────────────────────────────

/**
 * Start the Supabase containers.
 *
 * `supabase start` is itself a no-op on an already-running stack, but it still
 * costs several seconds of container inspection, so the caller skips it when the
 * status probe already said the stack is up.
 *
 * The first ever run pulls Postgres, Kong, PostgREST, Studio and postgres-meta —
 * several GB. There is no way to make that fast, so the only job here is making
 * sure it never looks like a hang.
 */
async function startSupabase(): Promise<void> {
  info(
    "First run downloads several GB of Docker images and can take 10+ minutes.",
  );
  info(
    "Later runs take a few seconds. Progress from the Supabase CLI follows:",
  );
  console.log("");

  // The CLI draws a spinner when attached to a TTY, which is reassurance enough.
  // Piped into a log file it goes quiet, so add our own heartbeat there instead
  // of writing over the spinner.
  const started = Date.now();
  const heartbeat = process.stdout.isTTY
    ? null
    : setInterval(() => {
        const secs = Math.round((Date.now() - started) / 1000);
        console.log(`    ...still starting Supabase (${secs}s elapsed)`);
      }, 30_000);

  try {
    const code = await stream(supabaseBin(), ["start"]);
    if (code !== 0) {
      throw new SetupError(
        `\`supabase start\` exited ${code}.`,
        "Scroll up for the CLI's own error. Common causes: Docker ran out of disk " +
          "(`docker system prune`), or a port in 54321-54323 is taken by another " +
          "Supabase project. `npm run docker:reset` gives you a clean slate.",
      );
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

/**
 * Write the generated half of the container environment.
 *
 * Everything in here is derived, which is why it is a separate file from the
 * committed `.env.docker`: regenerating it every boot means a change of port —
 * a new instance, a CLI upgrade — is picked up silently instead of failing as a
 * connection error nobody can explain.
 */
function writeEnvDockerLocal(status: SupabaseStatus): {
  path: string;
  containerDbUrl: string;
} {
  const file = path.join(ROOT, ".env.docker.local");
  const containerDbUrl = toContainerAddress(status.dbUrl);

  const body = [
    "# GENERATED FILE — do not edit, do not commit.",
    "# Rewritten on every `npm run dev:docker` by scripts/docker-up.ts from the",
    "# output of `supabase status -o json`. Any change you make here is lost on",
    "# the next boot; put durable settings in .env.docker instead.",
    "#",
    "# These addresses are CONTAINER-facing. host.docker.internal is how a",
    "# container reaches a port published on the macOS host, and it only resolves",
    "# because every service in docker-compose.yml declares",
    '#   extra_hosts: ["host.docker.internal:host-gateway"]',
    "# Host tooling (psql, scripts/*.ts) wants 127.0.0.1 instead, and a host",
    "# `npm run dev` makes that rewrite itself (scripts/dev.ts).",
    "",
    `DATABASE_URL=${containerDbUrl}`,
    "",
  ].join("\n");

  fs.writeFileSync(file, body, "utf-8");
  return { path: file, containerDbUrl };
}

async function applyPlatformMigrations(): Promise<void> {
  // Incremental, unlike `supabase db reset`: a restart must not wipe the data a
  // developer has been building up. On a brand-new volume `supabase start` has
  // already applied everything and this is a no-op that prints {"applied":[]}.
  const code = await stream(supabaseBin(), ["migration", "up", "--local"]);
  if (code !== 0) {
    throw new SetupError(
      `\`supabase migration up --local\` exited ${code}.`,
      "A migration in supabase/migrations/ failed to apply. Fix it, or start clean " +
        "with `npm run docker:reset` (this deletes local data).",
    );
  }
}

/**
 * Env for the two host-side npm scripts.
 *
 * These run on the *host*, not in a container, so they get 127.0.0.1 addresses —
 * the one place the two-address split actually bites. Passing them through the
 * child's environment rather than a file is deliberate: the loadEnvFile helpers
 * in migrate.ts and seed-admin.ts skip any key already present in process.env,
 * so this reliably wins over a developer's .env.local pointed at a hosted
 * Supabase project.
 */
function hostToolingEnv(
  status: SupabaseStatus,
  envDocker: Record<string, string>,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...envDocker,
    DATABASE_URL: status.dbUrl,
    // Set explicitly as well as via .env.docker. The local Postgres speaks
    // plaintext, and src/lib/db/pg-options.ts defaults an unset PGSSLMODE to
    // ssl: "require" — so without this every single query fails, which looks
    // like a connection problem rather than a TLS one.
    PGSSLMODE: "disable",
  };
}

async function runHostScript(
  script: string,
  env: NodeJS.ProcessEnv,
  onFail: string,
): Promise<void> {
  const code = await stream("npm", ["run", script], { env });
  if (code !== 0) {
    throw new SetupError(`\`npm run ${script}\` exited ${code}.`, onFail);
  }
}

/**
 * The end of every run: the running app's own answer to "is it up?", and what
 * to do next. It replaced a banner that printed the same fixed URL whether or
 * not anything answered there — the wrong one, for any instance not on 3000.
 *
 * Returns whether every check passed, so `--detach` can exit on it.
 */
async function printSummary(opts: {
  prod: boolean;
  detach: boolean;
  status: SupabaseStatus;
  envDocker: Record<string, string>;
}): Promise<boolean> {
  const { prod, detach, status, envDocker } = opts;
  const url = appUrl(appPort);
  const service = appService(prod);

  const checks: Check[] = await checkApp(url, {
    signIn: localSignIn(envDocker),
    fixes: {
      notRunning: `See why with \`docker compose -p ${COMPOSE_PROJECT} logs ${service}\`.`,
      noDatabase:
        "Check that DATABASE_URL in .env.docker.local names host.docker.internal, not " +
        "127.0.0.1 (docs/local-docker.md, Troubleshooting).",
      schemaBehind: "Apply the new platform migrations with `npm run db:local`, then reload.",
    },
  });
  checks.push(
    await checkReachable(
      "Studio",
      status.studioUrl,
      "browse and edit the database",
      "`npm run dev:docker` starts it again.",
    ),
  );
  const ok = allOk(checks);

  const notes = [`Postgres, for psql and host tools: ${status.dbUrl}`];
  if (!prod) {
    notes.push(
      "Use localhost, not 127.0.0.1: Next's dev server refuses its own assets from 127.0.0.1,",
      "and the page loads unstyled. Rather run Next on this computer? `npm run dev` offers to",
      "take over from this container, on this same database.",
    );
  }
  notes.push("`npm run status` asks all of this again, any time, from any terminal.");
  // The last line has to match the mode the reader is actually in. Telling
  // someone who has just been handed their prompt back that "Ctrl-C stops the
  // app containers" points them at a keystroke that now stops nothing.
  if (detach) {
    notes.push(
      `Running in the background. Logs: \`docker compose -p ${COMPOSE_PROJECT} logs -f ${service}\``,
      "`npm run docker:down` stops the app and Supabase both.",
    );
  } else {
    notes.push("Ctrl-C stops the app containers. `npm run docker:down` also stops Supabase.");
  }

  process.stdout.write(
    formatSummary({
      headline: ok
        ? `MixOS is up at ${url}`
        : `MixOS started at ${url}, but it isn't ready — see below`,
      checks,
      notes,
    }),
  );
  return ok;
}

/**
 * The attached run's summary. Compose owns the terminal from `up` until
 * Ctrl-C, so the summary cannot wait for it to return: this polls alongside
 * the log stream and prints into it the moment the app first answers, however
 * long a first image pull or a cold compile takes, then opens the browser for
 * a person at a terminal. Compose exiting first ends it quietly.
 */
async function announceWhenUp(
  opts: Parameters<typeof printSummary>[0] & { noOpen: boolean },
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted && !(await appAnswers(appUrl(appPort)))) {
    await sleep(READY_POLL_INTERVAL_MS * 2);
  }
  if (signal.aborted) return;
  const ok = await printSummary(opts);
  if (ok && !signal.aborted && browserWanted(opts.noOpen)) openBrowser(appUrl(appPort));
}

/**
 * `--db-only`'s ending: the database and Studio, checked, and the one command
 * that comes next. That command is a host `npm run dev`, which finds this
 * stack's database on its own (scripts/dev.ts) — no .env.local to write.
 */
async function printDatabaseSummary(status: SupabaseStatus): Promise<void> {
  const dbPort = Number(new URL(status.dbUrl).port);
  const checks: Check[] = [
    (await portInUse(dbPort))
      ? { state: "ok", name: "Database", lines: [status.dbUrl] }
      : {
          state: "fail",
          name: "Database",
          lines: [`nothing answers on port ${dbPort}`],
          fix: "`npm run docker:down`, then re-run this command.",
        },
    await checkReachable(
      "Studio",
      status.studioUrl,
      "browse and edit the database",
      "`npm run dev:docker -- --db-only` starts it again.",
    ),
  ];
  process.stdout.write(
    formatSummary({
      headline: allOk(checks)
        ? "The database is up. Start MixOS with `npm run dev`"
        : "The database didn't come up — see below",
      checks,
      notes: [
        "`npm run dev` uses this database by itself: there's no .env.local to write.",
        "`npm run status` checks everything again. `npm run docker:down` stops the database.",
      ],
    }),
  );
}

/**
 * Bring the app up.
 *
 * The other profile's app service is removed first. `app` and `app-dev` both
 * publish the app port, and compose leaves a service from an inactive profile
 * running rather than treating it as an orphan — so switching between
 * `dev:docker` and `docker:prod` would otherwise fail with a bind error that
 * says nothing about profiles.
 *
 * `detach` turns this from a call that owns the terminal until Ctrl-C into one
 * that returns as soon as the containers are created. Nothing else changes: the
 * image build, if any, still happens here and its output still streams, because
 * a caller staring at a silent prompt for two minutes during a cold `npm ci`
 * layer has no way to tell a slow build from a wedged one.
 */
async function composeUp(
  prod: boolean,
  build: boolean,
  detach: boolean,
): Promise<number> {
  const profile = prod ? "prod" : "dev";
  const otherService = prod ? "app-dev" : "app";

  // The dev profile mounts the .next and node_modules volumes INSIDE the
  // checkout, and Docker creates a missing mountpoint itself — as root. On
  // Linux and in WSL that left a root-owned .next in the person's repository,
  // which a host `npm run dev` or `npm run build` then could not write to, and
  // which the container cannot reach to fix because the volume sits on top of
  // it. Creating both first, as the person, keeps them theirs.
  if (!prod && OWNER) {
    for (const dir of [".next", "node_modules"]) {
      fs.mkdirSync(path.join(ROOT, dir), { recursive: true });
    }
  }

  spawnSync(
    "docker",
    [
      "compose",
      "-p",
      COMPOSE_PROJECT,
      "--profile",
      "dev",
      "--profile",
      "prod",
      "rm",
      "-sf",
      otherService,
    ],
    { cwd: ROOT, stdio: "ignore" },
  );

  const args = ["compose", "-p", COMPOSE_PROJECT, "--profile", profile, "up"];
  // The prod image bakes the source in, so a stale image silently serves stale
  // code. The dev image only carries dependencies and the source is bind-mounted,
  // so rebuilding it on every boot would be pure waste.
  if (prod || build) args.push("--build");
  if (detach) args.push("-d");

  // childOwnsSignals only makes sense while compose holds the terminal. With
  // -d the command is short-lived and a Ctrl-C during it should kill us the
  // ordinary way rather than be swallowed.
  return stream("docker", args, { childOwnsSignals: !detach });
}

/** The app service compose is running, by profile. */
function appService(prod: boolean): string {
  return prod ? "app" : "app-dev";
}

/**
 * Best-effort "has the app container already given up?".
 *
 * Purely an optimisation for the readiness poll: a container that crash-loops
 * on a bad env var will never answer, and burning the full three-minute budget
 * before saying so is three minutes of a caller watching a spinner. Every
 * failure mode here — an unsupported flag on an older compose, a daemon that
 * stopped answering, output we cannot parse — resolves to `false` and lets the
 * poll run its normal course, because a wrong "it's dead" is far more expensive
 * than a slow "it never came up".
 */
function appContainerExited(prod: boolean): boolean {
  const r = capture("docker", [
    "compose",
    "-p",
    COMPOSE_PROJECT,
    "--profile",
    prod ? "prod" : "dev",
    "ps",
    "--status",
    "exited",
    "--quiet",
    appService(prod),
  ]);
  return r.status === 0 && r.stdout.trim().length > 0;
}

/**
 * Poll the readiness probe until the app actually serves.
 *
 * `/api/health/ready` rather than any other route because it is the one
 * endpoint that answers the question a caller cares about: not "is a process
 * listening" but "can this instance serve a request that touches Postgres".
 * It is on the proxy's public list, so no session is involved, and it returns
 * 503 rather than throwing when the database is unreachable — which is exactly
 * the distinction the failure message below needs to make.
 *
 * Connection errors are expected for most of the wait (the container has not
 * bound the port yet) and are recorded, not thrown; only running out of budget
 * is a failure.
 */
async function waitForReady(prod: boolean): Promise<void> {
  const url = `${appUrl(appPort)}/api/health/ready`;
  const startedAt = Date.now();
  const deadline = startedAt + READY_TIMEOUT_MS;
  const service = appService(prod);
  let lastResult = "no response yet";
  let announcedSlow = false;

  info(`Waiting for ${url}`);

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(READY_REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200) {
        info(c.green("ready"));
        return;
      }
      lastResult = `HTTP ${res.status}`;
    } catch (err) {
      // A refused connection, a DNS failure and our own per-attempt timeout all
      // land here and all mean the same thing at this stage: not yet.
      lastResult = err instanceof Error ? err.message : String(err);
    }

    if (appContainerExited(prod)) {
      throw new SetupError(
        `The \`${service}\` container exited instead of starting up.`,
        `Read its last words with \`docker compose -p ${COMPOSE_PROJECT} logs ${service}\` — ` +
          "a container that exits during boot has almost always printed the reason. " +
          "`npm run docker:down` then a re-run is the clean retry.",
      );
    }

    // One line, once, so a long-but-healthy first compile does not read as a
    // hang. Repeating it every second would just bury the eventual summary.
    if (!announcedSlow && Date.now() - startedAt > 20_000) {
      announcedSlow = true;
      info(
        c.dim(
          prod
            ? "Still waiting — the prod container starts after the image build finishes."
            : "Still waiting — a cold dev container compiles the route tree on first request.",
        ),
      );
    }

    await sleep(READY_POLL_INTERVAL_MS);
  }

  throw new SetupError(
    `The stack came up but ${url} never returned 200 within ` +
      `${Math.round(READY_TIMEOUT_MS / 1000)}s (last result: ${lastResult}).`,
    `The containers are still running, so the evidence is intact — nothing has been ` +
      `torn down for you. Look at them in this order: ` +
      `\`docker compose -p ${COMPOSE_PROJECT} ps\` to see whether \`${service}\` is up, ` +
      `then \`docker compose -p ${COMPOSE_PROJECT} logs -f ${service}\` for the app's own ` +
      `output. A 503 means the app is serving but cannot reach Postgres — check DATABASE_URL ` +
      `in .env.docker.local, which must spell the host as host.docker.internal and not ` +
      `127.0.0.1. No response at all means it never bound port ${appPort}: either it is ` +
      `still compiling, or it is crash-looping. \`npm run docker:down\` stops everything.`,
  );
}

// ── Entry point ─────────────────────────────────────────────────────────────

type Args = {
  prod: boolean;
  check: boolean;
  build: boolean;
  detach: boolean;
  dbOnly: boolean;
  noOpen: boolean;
  help: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    prod: false,
    check: false,
    build: false,
    detach: false,
    dbOnly: false,
    noOpen: false,
    help: false,
  };
  for (const arg of argv) {
    switch (arg) {
      case "--prod":
        args.prod = true;
        break;
      // Spelled in full, with no `-d` alias. `docker compose -d` is the obvious
      // shorthand and that is the problem: the two are not the same thing here.
      // Ours also waits for readiness and prints the summary, and a reader who
      // pattern-matches the short form onto compose's would expect neither.
      case "--detach":
        args.detach = true;
        break;
      case "--db-only":
        args.dbOnly = true;
        break;
      case "--no-open":
        args.noOpen = true;
        break;
      case "--check":
        args.check = true;
        break;
      case "--build":
        args.build = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new SetupError(
          `Unknown option "${arg}".`,
          "Run `npx tsx scripts/docker-up.ts --help` to see the accepted flags.",
        );
    }
  }
  // Refused rather than ignored: each of these is a question about the app
  // container, which `--db-only` never starts, and silently dropping one
  // leaves the caller believing it applied.
  if (args.dbOnly && (args.prod || args.detach || args.build)) {
    throw new SetupError(
      "--db-only starts no app, so --prod, --detach and --build have nothing to apply to.",
      "Use `npm run dev:docker -- --db-only` on its own; it already returns once the database is up.",
    );
  }
  return args;
}

const HELP = `
Boot the local MixOS stack: Supabase (Postgres + PostgREST + Studio) and the app.

  npm run dev:docker              dev profile — source bind-mounted, hot reload
  npm run docker:prod             prod profile — production-parity standalone image
  npm run docker:down             stop everything
  npm run docker:reset            stop everything and delete the database
  npm run status                  is it up, where, and what to do if not

The app is published on port 3000. When another MixOS already has it, the
preflight names it and offers the next free port; MIXOS_PORT=3001 picks one.

Flags (pass through npm with --, e.g. \`npm run dev:docker -- --check\`):
  --prod      run the prod profile instead of dev
  --build     force a compose image rebuild (implied by --prod)
  --detach    boot in the background, wait until the app answers
              /api/health/ready, print the summary and exit 0. Combines with
              --prod. Without it the command stays in the foreground streaming
              container logs and only ends on Ctrl-C — use --detach from a
              script, an agent, or anything else that needs its prompt back.
  --db-only   start the database (and run its migrations) but not the app, for
              \`npm run dev\` on this computer; returns once it is up
  --no-open   don't open the browser when MixOS is up (also
              MIXOS_OPEN_BROWSER=false). It only opens for a terminal anyway.
  --check     run preflight only and exit; changes nothing on your machine
  --help      this text
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP.trim());
    return;
  }

  console.log(
    c.bold(
      `\nMixOS local stack — ${args.dbOnly ? "database only" : `${args.prod ? "prod" : "dev"} profile`}`,
    ),
  );

  step(
    args.check
      ? "Preflight (check only — nothing will be changed)"
      : "Preflight",
  );
  const { supabaseRunning, envDocker } = await preflight({
    prod: args.prod,
    checkOnly: args.check,
    dbOnly: args.dbOnly,
    rerun: (port) =>
      `MIXOS_PORT=${port} npm run ${args.prod ? "docker:prod" : "dev:docker"}` +
      (args.detach ? " -- --detach" : ""),
  });

  step("Supabase stack");
  if (supabaseRunning) {
    info("Already running — skipping `supabase start`.");
  } else {
    await startSupabase();
  }

  step("Reading Supabase connection details");
  const status = readSupabaseStatus();
  info(`API      ${status.apiUrl}`);
  info(`Postgres ${status.dbUrl}`);
  info(`Studio   ${status.studioUrl}`);

  step("Writing .env.docker.local");
  const written = writeEnvDockerLocal(status);
  info(`${path.relative(ROOT, written.path)} -> ${written.containerDbUrl}`);

  step("Applying platform migrations (supabase/migrations)");
  await applyPlatformMigrations();

  const hostEnv = hostToolingEnv(status, envDocker);

  step("Applying app migrations (apps/*/migrations)");
  await runHostScript(
    "migrate:apps",
    hostEnv,
    "An app migration failed. The SQL is in apps/<slug>/migrations/ — see docs/apps/database.md.",
  );

  step("Seeding the admin user");
  if (!envDocker.INITIAL_ADMIN_EMAIL || !envDocker.INITIAL_ADMIN_PASSWORD) {
    throw new SetupError(
      ".env.docker is missing INITIAL_ADMIN_EMAIL and/or INITIAL_ADMIN_PASSWORD.",
      "Add both to .env.docker — they are the local login and are meant to be committed.",
    );
  }
  await runHostScript(
    "seed-admin",
    hostEnv,
    "Could not create the admin user. If the error mentions a missing table, the platform " +
      "migrations did not apply — try `npm run docker:reset`.",
  );

  if (args.dbOnly) {
    await printDatabaseSummary(status);
    process.exit(0);
  }

  const summaryOpts = { prod: args.prod, status, envDocker, noOpen: args.noOpen };

  step(
    `Starting the app (docker compose --profile ${args.prod ? "prod" : "dev"}${
      args.detach ? ", detached" : ""
    })`,
  );
  // Attached, compose owns the terminal from here to Ctrl-C, and the summary
  // has to reach it from inside the log stream: announceWhenUp() prints it
  // there once the app answers. Said first, so the wait between here and then
  // reads as expected rather than as a hang.
  const watcher = new AbortController();
  if (!args.detach) {
    info(
      c.dim(`MixOS will be at ${appUrl(appPort)}. A summary prints here once it answers.`),
    );
    void announceWhenUp({ ...summaryOpts, detach: false }, watcher.signal);
  }
  const code = await composeUp(args.prod, args.build, args.detach);
  watcher.abort();
  // 130 is a Ctrl-C, which is how a developer is expected to end a dev session.
  if (code !== 0 && code !== 130) {
    throw new SetupError(
      `\`docker compose up\` exited ${code}.`,
      "Scroll up for the container's own error. `npm run docker:down` then re-run for a clean attempt.",
    );
  }

  if (args.detach) {
    // A Ctrl-C during `compose up -d` is an abort, not a start. Falling through
    // to a three-minute readiness wait after the caller has just interrupted us
    // is the opposite of what they asked for.
    if (code === 130) {
      throw new SetupError(
        "Interrupted before the stack finished coming up.",
        `See what survived with \`docker compose -p ${COMPOSE_PROJECT} ps\`, or stop it all with \`npm run docker:down\`.`,
      );
    }

    step("Waiting for the app to answer /api/health/ready");
    await waitForReady(args.prod);
    const ok = await printSummary({ ...summaryOpts, detach: true });
    if (ok && browserWanted(args.noOpen)) openBrowser(appUrl(appPort));
    // The summary already said what failed and how to fix it; the exit status
    // is for a caller that only reads that.
    process.exit(ok ? 0 : 1);
  }

  process.exit(0);
}

function reportAndExit(err: unknown): never {
  if (err instanceof SetupError) {
    console.error(`\n${c.red("docker-up failed:")} ${err.message}`);
    console.error(`\n${c.bold("What to do:")} ${err.next}\n`);
  } else {
    console.error(`\n${c.red("docker-up failed unexpectedly.")}`);
    console.error(err);
    console.error(
      `\n${c.bold("What to do:")} this is a bug in scripts/docker-up.ts — the stack trace above is the report.\n`,
    );
  }
  process.exit(1);
}

process.on("unhandledRejection", reportAndExit);

main().catch(reportAndExit);
