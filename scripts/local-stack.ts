/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What the three ways of starting MixOS locally have in common:
// `npm run dev:docker` (scripts/docker-up.ts), `npm run dev` on the host
// (scripts/dev.ts) and `npm run status` (scripts/status.ts). Each has to
// answer the same two questions, and answering them three ways is how three
// commands drift into telling one person three different things.
//
//   * WHO IS ON THIS PORT? Not "is it free". A port held by another MixOS is a
//     different problem from one held by some unrelated app, and has a
//     different fix: the next free port, said out loud with the command that
//     uses it. "Port 3000 is already in use" alone is where people get stuck.
//   * IS MIXOS ACTUALLY UP? Next's "Ready in 400ms" means a process is
//     listening, not that it can reach its database — which is how a dev
//     server with no DATABASE_URL looks healthy until the first page throws.
//     The summary asks the running app what a person would: does it answer,
//     can it query, does the sign-in page render.
//
// Nothing in here starts or stops anything. It looks, and the callers act.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { databaseNamed } from "../src/lib/db/pg-options";
import { hostPlatform } from "./host-platform";
import { DEFAULT_INSTANCE } from "./instance";

export const ROOT = path.resolve(__dirname, "..");

// ── Output ──────────────────────────────────────────────────────────────────

const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;
export const c = {
  dim: (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
};

/** `/Users/me/git/mixos` as `~/git/mixos`: the same path, at a glance. */
export function tilde(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? "~" + p.slice(home.length) : p;
}

/** Always `localhost`: Next's dev server refuses its own assets from 127.0.0.1. */
export function appUrl(port: number): string {
  return `http://localhost:${port}`;
}

// ── Process helpers ─────────────────────────────────────────────────────────

export type Captured = { status: number; stdout: string; stderr: string };

/** Run a command, capture its output. `status: 127` means "not on PATH". */
export function capture(cmd: string, args: string[]): Captured {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { status: 127, stdout: "", stderr: `${cmd}: command not found` };
    }
    return { status: 1, stdout: "", stderr: String(r.error.message) };
  }
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

// ── Env files ───────────────────────────────────────────────────────────────

/**
 * Minimal KEY=VALUE reader, matching scripts/migrate.ts and scripts/seed-admin.ts
 * rather than adding a dotenv dependency for three call sites. Unlike those two
 * it returns a record instead of mutating process.env — the values are destined
 * for a *child* process's environment, and leaking .env.docker's dev-only
 * secrets into this process would make them ambient for everything we spawn.
 */
export function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf-8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * The files Next reads in development, highest precedence first. Only the
 * names matter here: whether any of them names a database.
 */
const NEXT_DEV_ENV_FILES = [".env.development.local", ".env.local", ".env.development", ".env"];

/**
 * Where this checkout's own database setting comes from, or null if it has
 * none: the shell first, then each file Next would read. "Own" is the point —
 * a database somebody chose, which `npm run dev` must never paper over with
 * the local stack's.
 */
export function configuredDatabase(root: string = ROOT): string | null {
  if (databaseNamed(process.env)) return "the shell environment";
  for (const file of NEXT_DEV_ENV_FILES) {
    // A file's keys stand in for an environment: the predicate only reads them.
    if (databaseNamed(parseEnvFile(path.join(root, file)) as NodeJS.ProcessEnv)) return file;
  }
  return null;
}

/** The seeded admin login, from the committed dev-only values. */
export function localSignIn(
  envDocker: Record<string, string>,
): { email: string; password: string } | undefined {
  const email = envDocker.INITIAL_ADMIN_EMAIL;
  const password = envDocker.INITIAL_ADMIN_PASSWORD;
  return email && password ? { email, password } : undefined;
}

// ── The local Supabase stack ────────────────────────────────────────────────

export type LocalDatabase = { dbUrl: string; studioUrl: string | null };

/**
 * This instance's Supabase stack, if it is running — read, never started.
 *
 * Quiet on purpose, unlike docker-up.ts's readSupabaseStatus(), which refuses
 * to continue on a half-up stack: here "not running" is an ordinary answer
 * that the caller reports with a fix. The CLI resolves its project id and ports
 * from MIXOS_* in the environment (supabase/config.toml), so call
 * resolveInstance() first.
 */
export function localSupabase(root: string = ROOT): LocalDatabase | null {
  const bin = path.join(root, "node_modules", ".bin", "supabase");
  if (!fs.existsSync(bin)) return null;
  const r = capture(bin, ["status", "-o", "json"]);
  if (r.status !== 0) return null;
  try {
    const obj = JSON.parse(r.stdout) as Record<string, unknown>;
    if (typeof obj.DB_URL !== "string" || !obj.DB_URL) return null;
    return {
      dbUrl: obj.DB_URL,
      studioUrl: typeof obj.STUDIO_URL === "string" && obj.STUDIO_URL ? obj.STUDIO_URL : null,
    };
  } catch {
    return null;
  }
}

// ── Ports ───────────────────────────────────────────────────────────────────

/**
 * True if something is already listening on the port.
 *
 * Probes by connecting, not by trying to bind. Binding is the obvious approach
 * and it does not work on macOS: Node sets SO_REUSEADDR on every server socket,
 * and BSD's SO_REUSEADDR semantics allow binding a *specific* address while
 * another process holds the wildcard — so a `next dev` on `*:3000` reports the
 * port as free and the conflict resurfaces later as an opaque compose bind
 * error. Verified on this machine before the rewrite.
 *
 * The trade-off is that a listener bound only to a LAN interface goes
 * undetected, which is fine: compose publishes on the loopback path too.
 */
export function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const finish = (inUse: boolean) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(1_000);
    socket.once("connect", () => finish(true));
    // A drop (rather than a refusal) on loopback effectively cannot happen, and
    // guessing "busy" here would block a legitimate boot, so treat it as free
    // and let compose report the real bind error if we were wrong.
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/**
 * Best-effort "who has this port", for an error message worth reading.
 *
 * Docker is asked first, because it is the one answer that works the same on
 * every platform. On Linux a published port is held by `docker-proxy`, a root
 * process that `lsof` and `ss` will not name to an ordinary user — so without
 * this, re-running the boot over a stack that is already up would report its
 * own app container as "an unknown process" and refuse to continue.
 */
export function portHolder(port: number): string | null {
  const container = capture("docker", [
    "ps",
    "--filter",
    `publish=${port}`,
    "--format",
    "{{.Names}}",
  ]);
  const name = container.status === 0 ? container.stdout.trim().split("\n")[0] : "";
  if (name) return `container ${name}`;

  const listener = listeners(port)[0];
  if (listener) return `${listener.command} (pid ${listener.pid})`;
  return null;
}

/**
 * Whether a port belongs to a container rather than to a host process.
 *
 * That case is fine — compose recreates its own containers — while a host
 * `npm run dev` on 3000 is not. Docker's own answer says "container …"; the
 * process names are what each platform's publisher looks like to lsof:
 * Docker Desktop's backend on macOS, `docker-proxy` on Linux.
 */
export function looksLikeDocker(holder: string | null): boolean {
  if (!holder) return false;
  return /^(container |com\.docke|docker|vpnkit|containerd)/i.test(holder);
}

export type Listener = { pid: number; command: string; port: number };

/**
 * Parse `lsof -Fpcn` output: a `p` line starts each process, then its `c`
 * (command) and one `n` (address) per socket. IPv4 and IPv6 sockets for one
 * port are one listener here.
 */
export function parseLsofListeners(out: string): Listener[] {
  const found: Listener[] = [];
  let pid = 0;
  let command = "";
  for (const line of out.split("\n")) {
    const value = line.slice(1);
    if (line.startsWith("p")) {
      pid = Number(value);
      command = "";
    } else if (line.startsWith("c")) {
      command = value;
    } else if (line.startsWith("n")) {
      const m = /:(\d+)$/.exec(value);
      if (!m || !pid) continue;
      const port = Number(m[1]);
      if (!found.some((l) => l.pid === pid && l.port === port)) {
        found.push({ pid, command, port });
      }
    }
  }
  return found;
}

/**
 * Parse `ss -Hltnp`: `LISTEN 0 511 *:3000 *:* users:(("next-server (v1",pid=9,fd=20))`.
 * ss truncates the command to 15 characters, which still starts with what we
 * match on.
 */
export function parseSsListeners(out: string): Listener[] {
  const found: Listener[] = [];
  for (const line of out.split("\n")) {
    const cols = line.trim().split(/\s+/);
    const port = /:(\d+)$/.exec(cols[3] ?? "");
    const user = /users:\(\("(.+?)",pid=(\d+)/.exec(line);
    if (!port || !user) continue;
    const entry = { pid: Number(user[2]), command: user[1], port: Number(port[1]) };
    if (!found.some((l) => l.pid === entry.pid && l.port === entry.port)) found.push(entry);
  }
  return found;
}

/**
 * Host processes listening on TCP, on one port or all of them. `lsof` first;
 * Linux distributions do not all ship it, and every one ships ss (iproute2).
 * Only processes this user may inspect are named, which covers every
 * `npm run dev` they started.
 */
export function listeners(port?: number): Listener[] {
  const tcp = port === undefined ? "-iTCP" : `-iTCP:${port}`;
  const lsof = capture("lsof", ["+c", "0", "-nP", tcp, "-sTCP:LISTEN", "-Fpcn"]);
  if (lsof.status === 0) return parseLsofListeners(lsof.stdout);
  const ss = capture("ss", port === undefined ? ["-Hltnp"] : ["-Hltnp", `sport = :${port}`]);
  return ss.status === 0 ? parseSsListeners(ss.stdout) : [];
}

/** A process's working directory: /proc where there is one, lsof elsewhere. */
function processCwd(pid: number): string | null {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    // Not Linux, or not ours to read.
  }
  const r = capture("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  if (r.status !== 0) return null;
  const line = r.stdout.split("\n").find((l) => l.startsWith("n"));
  return line ? line.slice(1) : null;
}

/**
 * Whether a directory is a MixOS checkout. By what it contains rather than its
 * name: people clone into ~/MixOS, ~/git/mixos, a worktree, a fork.
 */
export function isMixosCheckout(dir: string | null | undefined): boolean {
  if (!dir) return false;
  return (
    fs.existsSync(path.join(dir, "scripts", "instance.ts")) &&
    fs.existsSync(path.join(dir, "docker-compose.yml"))
  );
}

/** The instance a checkout is, read from its `.env.instance` as instance.ts does. */
export function instanceNameOf(checkout: string): string {
  const name = parseEnvFile(path.join(checkout, ".env.instance")).MIXOS_INSTANCE;
  return name?.trim() || DEFAULT_INSTANCE;
}

/** Whether two paths are one directory, through symlinks (macOS's /tmp is one). */
export function samePath(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

/** The compose services that are a MixOS app, under either profile. */
const APP_SERVICES = new Set(["app-dev", "app"]);

/** One `docker ps` row, with the labels compose puts on everything it starts. */
export type ContainerRow = {
  name: string;
  project: string;
  service: string;
  workingDir: string;
  ports: string;
};

const DOCKER_ROW_FORMAT = [
  "{{.Names}}",
  '{{.Label "com.docker.compose.project"}}',
  '{{.Label "com.docker.compose.service"}}',
  '{{.Label "com.docker.compose.project.working_dir"}}',
  "{{.Ports}}",
].join("\t");

export function parseDockerRows(out: string): ContainerRow[] {
  return out
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const [name = "", project = "", service = "", workingDir = "", ports = ""] = line.split("\t");
      return { name, project, service, workingDir, ports };
    });
}

/**
 * The host port a container publishes its port 3000 on, from `docker ps`'s
 * `127.0.0.1:3001->3000/tcp`. Every MixOS app service listens on 3000 inside.
 */
export function publishedPort(ports: string): number | null {
  const m = /:(\d+)->3000\/tcp/.exec(ports);
  return m ? Number(m[1]) : null;
}

function isMixosApp(row: ContainerRow): boolean {
  return APP_SERVICES.has(row.service) && isMixosCheckout(row.workingDir);
}

export type PortHolder =
  /** This instance's own app container: compose replaces it on `up`. */
  | { kind: "this-instance"; container: string; service: string; checkout: string | null }
  /** A `npm run dev` started in this very checkout. */
  | { kind: "this-checkout"; pid: number }
  /** Any other MixOS — another instance, or another checkout's host server. */
  | { kind: "mixos"; instance: string; detail: string; checkout: string | null }
  | { kind: "other"; label: string };

/**
 * Who holds a port, in the terms that decide what to do about it.
 *
 * Docker first, for the reason portHolder() gives. A container counts as MixOS
 * when it is an app service whose compose working directory is a MixOS
 * checkout; a host process does when its working directory is one, which is
 * where `next dev` runs from.
 */
export function identifyPortHolder(
  port: number,
  self: { instance: string; root: string },
): PortHolder {
  const docker = capture("docker", [
    "ps",
    "--filter",
    `publish=${port}`,
    "--format",
    DOCKER_ROW_FORMAT,
  ]);
  const row = docker.status === 0 ? parseDockerRows(docker.stdout)[0] : undefined;
  if (row) {
    if (row.project === self.instance && APP_SERVICES.has(row.service)) {
      return {
        kind: "this-instance",
        container: row.name,
        service: row.service,
        checkout: row.workingDir || null,
      };
    }
    if (isMixosApp(row)) {
      return {
        kind: "mixos",
        instance: row.project,
        detail: `in Docker, from ${tilde(row.workingDir)}`,
        checkout: row.workingDir,
      };
    }
    return { kind: "other", label: `container ${row.name}` };
  }

  const listener = listeners(port)[0];
  if (!listener) return { kind: "other", label: "an unknown process" };
  const cwd = processCwd(listener.pid);
  if (cwd && isMixosCheckout(cwd)) {
    if (samePath(cwd, self.root)) return { kind: "this-checkout", pid: listener.pid };
    return {
      kind: "mixos",
      instance: instanceNameOf(cwd),
      detail: `\`npm run dev\` in ${tilde(cwd)}, pid ${listener.pid}`,
      checkout: cwd,
    };
  }
  return { kind: "other", label: `${listener.command} (pid ${listener.pid})` };
}

/** A holder as a sentence's subject: "MixOS instance `mixos-dev` (in Docker, …)". */
export function describeHolder(holder: PortHolder): string {
  switch (holder.kind) {
    case "this-instance":
      return `this instance's own app container (${holder.container})`;
    case "this-checkout":
      return `this checkout's own \`npm run dev\` (pid ${holder.pid})`;
    case "mixos":
      return `MixOS instance \`${holder.instance}\` (${holder.detail})`;
    case "other":
      return holder.label;
  }
}

/**
 * The first free port after `port`. Twenty tries is far more MixOS copies than
 * anyone runs; past that something else is wrong and null says so.
 */
export async function nextFreePort(
  port: number,
  busy: (p: number) => Promise<boolean> = portInUse,
): Promise<number | null> {
  for (let p = port + 1; p <= Math.min(port + 20, 65_535); p++) {
    if (!(await busy(p))) return p;
  }
  return null;
}

export type RunningApp = {
  instance: string;
  port: number;
  url: string;
  checkout: string | null;
  /** How it runs, for a person: "in Docker (app-dev)" or "`npm run dev`, pid 123". */
  how: string;
  docker: boolean;
};

/**
 * Every MixOS app serving on this machine, Docker or host, lowest port first.
 *
 * A host server is a Node process, run from a MixOS checkout, whose port
 * answers MixOS's own liveness probe. Not Next's process title: depending on
 * the version it is `next-server (v…)` or plain `node`. And not the checkout
 * alone, which runs other servers too — an MCP inspector, a test fixture.
 */
export async function runningMixosApps(): Promise<RunningApp[]> {
  const apps: RunningApp[] = [];

  const docker = capture("docker", [
    "ps",
    "--filter",
    "label=com.docker.compose.service",
    "--format",
    DOCKER_ROW_FORMAT,
  ]);
  if (docker.status === 0) {
    for (const row of parseDockerRows(docker.stdout)) {
      const port = publishedPort(row.ports);
      if (!port || !isMixosApp(row)) continue;
      apps.push({
        instance: row.project,
        port,
        url: appUrl(port),
        checkout: row.workingDir,
        how: `in Docker (${row.service})`,
        docker: true,
      });
    }
  }

  const cwds = new Map<number, string | null>();
  const counted = new Set<number>();
  for (const l of listeners()) {
    if (!/^(node|next-server)/.test(l.command) || counted.has(l.pid)) continue;
    if (!cwds.has(l.pid)) cwds.set(l.pid, processCwd(l.pid));
    const cwd = cwds.get(l.pid);
    if (!cwd || !isMixosCheckout(cwd) || !(await appAnswers(appUrl(l.port)))) continue;
    counted.add(l.pid);
    apps.push({
      instance: instanceNameOf(cwd),
      port: l.port,
      url: appUrl(l.port),
      checkout: cwd,
      how: `\`npm run dev\`, pid ${l.pid}`,
      docker: false,
    });
  }

  return apps.sort((a, b) => a.port - b.port);
}

/** Whether a running app is this checkout's: its instance in Docker, or its own host server. */
export function isOurs(app: RunningApp, self: { instance: string; root: string }): boolean {
  if (app.docker) return app.instance === self.instance;
  return app.checkout !== null && samePath(app.checkout, self.root);
}

// ── Is it up? ───────────────────────────────────────────────────────────────

export type CheckState = "ok" | "fail" | "skip";

/** One line of the summary: a name, what was found, and the fix when it failed. */
export type Check = { state: CheckState; name: string; lines: string[]; fix?: string };

/** What to tell the reader for each way the app can be down. Caller-specific. */
export type Fixes = {
  /** Nothing answers at the URL at all. */
  notRunning: string;
  /** It answers, but cannot query its database. */
  noDatabase: string;
  /** The platform schema is older than this code. */
  schemaBehind: string;
};

type Probe = { status: number; json: unknown } | { error: string };

/**
 * One GET, never throwing. `redirect: "manual"` so a 307 to /login reads as
 * what it is. The timeouts are generous because a cold `next dev` compiles a
 * route on its first request, and a refused connection fails at once anyway.
 */
async function probe(url: string, timeoutMs: number): Promise<Probe> {
  try {
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Not every answer is JSON; only the readiness body is read.
    }
    return { status: res.status, json };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    return {
      error:
        name === "TimeoutError"
          ? `no answer within ${Math.round(timeoutMs / 1000)}s`
          : "nothing is answering",
    };
  }
}

/** True once the app answers at all: the moment a summary is worth printing. */
export async function appAnswers(url: string): Promise<boolean> {
  const r = await probe(`${url}/api/health/live`, 5_000);
  return "status" in r && r.status === 200;
}

/**
 * Ask a running app whether it is really up: alive, reaching its database with
 * the schema this code expects, and rendering the sign-in page. Each question
 * is only asked when the one before it passed, because a page cannot render
 * without its database and saying so twice buries the cause.
 */
export async function checkApp(
  url: string,
  opts: { fixes: Fixes; signIn?: { email: string; password: string } },
): Promise<Check[]> {
  const { fixes, signIn } = opts;
  const live = await probe(`${url}/api/health/live`, 30_000);
  if ("error" in live || live.status !== 200) {
    return [
      {
        state: "fail",
        name: "Web server",
        lines: [`${url} — ${"error" in live ? live.error : `answered ${live.status}`}`],
        fix: fixes.notRunning,
      },
      { state: "skip", name: "Database", lines: ["not checked: the app isn't answering"] },
      { state: "skip", name: "Sign-in", lines: ["not checked: the app isn't answering"] },
    ];
  }
  const checks: Check[] = [{ state: "ok", name: "Web server", lines: [url] }];

  // /api/health/ready answers 503 with a `reason` only when the database is
  // reachable but behind; with no reason, the database itself is the problem.
  // See src/lib/platform/readiness.ts.
  const ready = await probe(`${url}/api/health/ready`, 30_000);
  const reason =
    "status" in ready && ready.json && typeof ready.json === "object"
      ? (ready.json as { reason?: string }).reason
      : undefined;
  if ("status" in ready && ready.status === 200) {
    checks.push({ state: "ok", name: "Database", lines: ["connected, schema up to date"] });
  } else if (reason === "schema-behind") {
    checks.push({
      state: "fail",
      name: "Database",
      lines: ["connected, but its schema is older than this code"],
      fix: fixes.schemaBehind,
    });
  } else if (reason === "app-migrations-behind") {
    checks.push({
      state: "fail",
      name: "Database",
      lines: ["connected, but an app migration hasn't been applied"],
      fix: "Apply it with `npm run migrate:apps`, then reload.",
    });
  } else {
    checks.push({
      state: "fail",
      name: "Database",
      lines: ["the app can't reach its database"],
      fix: fixes.noDatabase,
    });
  }
  if (checks.at(-1)!.state === "fail") {
    checks.push({ state: "skip", name: "Sign-in", lines: ["not checked: waits for the database"] });
    return checks;
  }

  const login = await probe(`${url}/login`, 60_000);
  if ("status" in login && login.status === 200) {
    checks.push({
      state: "ok",
      name: "Sign-in",
      lines: [`${url}/login`, ...(signIn ? [`${signIn.email} / ${signIn.password}`] : [])],
    });
  } else {
    checks.push({
      state: "fail",
      name: "Sign-in",
      lines: [`${url}/login — ${"error" in login ? login.error : `answered ${login.status}`}`],
      fix: "The server's own log, above, has the error.",
    });
  }
  return checks;
}

/** Whether a URL answers at all, for the side services like Studio. */
export async function checkReachable(
  name: string,
  url: string,
  note: string,
  fix: string,
): Promise<Check> {
  const r = await probe(url, 5_000);
  return "status" in r
    ? { state: "ok", name, lines: [`${url}   ${c.dim(note)}`] }
    : { state: "fail", name, lines: [`${url} — ${r.error}`], fix };
}

/** True when nothing failed. Skipped checks only follow a failure. */
export function allOk(checks: Check[]): boolean {
  return checks.every((check) => check.state === "ok");
}

const MARK: Record<CheckState, () => string> = {
  ok: () => c.green("✓"),
  fail: () => c.red("✗"),
  skip: () => c.dim("–"),
};

/**
 * The summary block: a headline that answers "is it up?" in one line, then a
 * line per check, each failure followed by its fix. Built as one string so it
 * reaches the terminal in one write, and stays in one piece even when it lands
 * in the middle of a container's log stream.
 */
export function formatSummary(opts: {
  headline: string;
  checks: Check[];
  notes?: string[];
}): string {
  const ok = allOk(opts.checks);
  const rule = "─".repeat(72);
  const indent = " ".repeat(17);
  const out = [
    "",
    rule,
    `  ${ok ? c.green("✓") : c.red("✗")} ${c.bold(opts.headline)}`,
    "",
  ];
  for (const check of opts.checks) {
    const [first = "", ...rest] = check.lines;
    out.push(
      `  ${MARK[check.state]()} ${check.name.padEnd(12)} ${check.state === "skip" ? c.dim(first) : first}`,
    );
    for (const line of rest) out.push(`${indent}${line}`);
    if (check.state === "fail" && check.fix) out.push(`${indent}${c.yellow(`→ ${check.fix}`)}`);
  }
  if (opts.notes?.length) {
    out.push("");
    for (const note of opts.notes) out.push(`  ${c.dim(note)}`);
  }
  out.push(rule, "");
  return out.join("\n");
}

// ── Talking to the person ───────────────────────────────────────────────────

/** A person at a terminal, who can answer a question and has a browser. */
export function interactive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true && !process.env.CI;
}

/**
 * Ask a yes/no question, Enter meaning yes. Only call it when interactive():
 * an agent or a CI step has nobody to answer, and must get the recommendation
 * as a command to run instead.
 */
export async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // Without a listener, Ctrl-C at the prompt only pauses the stream and leaves
  // the process waiting on an answer nobody can type.
  rl.on("SIGINT", () => {
    rl.close();
    process.exit(130);
  });
  const answer = await new Promise<string>((resolve) => rl.question(`    ${question} [Y/n] `, resolve));
  rl.close();
  return !/^n/i.test(answer.trim());
}

/**
 * Whether to open the browser once MixOS answers: for a person at a terminal,
 * unless they said not to. Never for an agent, a script or CI, which have no
 * one looking at a browser and would only have one appear on someone's screen.
 */
export function browserWanted(noOpenFlag: boolean): boolean {
  if (noOpenFlag || process.env.MIXOS_OPEN_BROWSER === "false") return false;
  return interactive();
}

/** Open a URL in the default browser, best effort: failing to is never an error. */
export function openBrowser(url: string): void {
  const platform = hostPlatform();
  // explorer.exe is how WSL reaches the Windows default browser without
  // wslu installed. It exits 1 even when it worked, which is why nothing here
  // looks at exit codes.
  const [cmd, args] =
    platform === "macos"
      ? ["open", [url]]
      : platform === "wsl"
        ? ["explorer.exe", [url]]
        : platform === "windows"
          ? ["cmd", ["/c", "start", "", url]]
          : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // No opener on this machine: the URL is in the summary either way.
  }
}
