/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which checkout each instance belongs to, so that an instance, and with it a
 * database, is never two folders' at once.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 *
 * An instance is named, not located: every checkout without a `.env.instance`
 * is `mixos`. Two of them — a second clone, a git worktree — were therefore
 * one instance with one database, and nothing said so. A branch's migration
 * landed in the database the main checkout was using, booting either one
 * replaced the other's app, and `npm run docker:reset` in one deleted the
 * other's data.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 *
 * The first checkout to boot an instance owns it, and keeps it. A checkout
 * about to boot an instance another folder owns gets one of its own instead:
 * named after its folder, on the next free block of Supabase ports, with a
 * fresh database, and written to its `.env.instance` so it stays that way
 * (docker-up.ts does the writing). Only a checkout with no instance name of
 * its own is renamed. A name somebody wrote, in the file or the shell, is
 * refused with the fix rather than overridden. Every other command that acts
 * on an instance — `docker:down`, the `db:*` scripts, `npm run dev`,
 * `npm run status` — leaves another folder's alone.
 *
 * ── WHERE OWNERSHIP IS KEPT ─────────────────────────────────────────────────
 *
 * In `~/.mixos/instances.json` (MIXOS_STATE_DIR moves it): each instance's
 * checkout and port block. It has to outlive the containers, which
 * `docker:down` removes, and the claims of stopped instances are what keep
 * their port blocks from being handed out twice. With no claim yet — a
 * machine from before this file existed — the evidence is Docker's: the folder
 * compose last ran the instance's app from. The copy that was in use keeps the
 * data.
 *
 * A claim whose folder is gone, moved or deleted, no longer counts, and the
 * next checkout to boot that name takes it over.
 *
 * Node built-ins only: docker-down.ts has to run on a half-finished checkout,
 * and its tests run it from a copy of scripts/ alone.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listeners } from "./host-ports";
import {
  DEFAULT_INSPECTOR_PORT,
  DEFAULT_INSTANCE,
  DEFAULT_SUPABASE_PORT_BASE,
  type Instance,
  OFFSETS,
} from "./instance";

/** One instance's owner, and the ports it was given. */
export type Claim = { checkout: string; portBase: number; inspectorPort: number };

/** Supabase port blocks are this far apart: 54320, 54340, 54360, … */
const BLOCK = 20;

/** How many blocks above the default to look through for a free one. */
const MAX_BLOCKS = 20;

export function claimsFile(): string {
  const dir = process.env.MIXOS_STATE_DIR || path.join(os.homedir(), ".mixos");
  return path.join(dir, "instances.json");
}

/** Every recorded claim. A missing or unreadable file is no claims, never an error. */
export function readClaims(): Record<string, Claim> {
  try {
    const parsed = JSON.parse(fs.readFileSync(claimsFile(), "utf8")) as { instances?: unknown };
    const instances = parsed.instances;
    if (!instances || typeof instances !== "object") return {};
    const out: Record<string, Claim> = {};
    for (const [name, value] of Object.entries(instances as Record<string, Partial<Claim>>)) {
      if (
        typeof value?.checkout === "string" &&
        Number.isInteger(value.portBase) &&
        Number.isInteger(value.inspectorPort)
      ) {
        out[name] = value as Claim;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Written whole, through a temporary file, so a reader never sees half of it. */
function writeClaims(instances: Record<string, Claim>): void {
  const file = claimsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, instances }, null, 2) + "\n");
  fs.renameSync(tmp, file);
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

/** Whether two paths are one directory, through symlinks (macOS's /tmp is one). */
export function samePath(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** `/Users/me/git/mixos` as `~/git/mixos`, as ./local-stack prints paths. */
function tilde(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? "~" + p.slice(home.length) : p;
}

/** stdout of a docker command, or null when Docker is absent, down or refuses. */
function docker(args: string[]): string | null {
  const r = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return !r.error && r.status === 0 ? r.stdout : null;
}

/** The folder compose last ran an instance from, running or stopped. */
function composeWorkingDir(name: string): string | null {
  const out = docker([
    "ps",
    "-a",
    "--filter",
    `label=com.docker.compose.project=${name}`,
    "--format",
    '{{.Label "com.docker.compose.project.working_dir"}}',
  ]);
  return out?.split("\n").find((line) => line.trim())?.trim() ?? null;
}

/** The checkout that owns an instance, or null when none does. */
export function ownerOf(name: string): string | null {
  const claim = readClaims()[name];
  if (claim && isMixosCheckout(claim.checkout)) return claim.checkout;
  const dir = composeWorkingDir(name);
  return dir && isMixosCheckout(dir) ? dir : null;
}

/** The other folder that owns `name`, when it is not `root`. */
export function ownedElsewhere(name: string, root: string): string | null {
  const owner = ownerOf(name);
  return owner && !samePath(owner, root) ? owner : null;
}

/** Record that `root` owns this instance, with its ports. Booting is claiming. */
export function recordClaim(instance: Instance, root: string): void {
  const claims = readClaims();
  claims[instance.name] = {
    checkout: realpath(root),
    portBase: instance.ports.supabaseShadow - OFFSETS.shadow,
    inspectorPort: instance.ports.supabaseInspector,
  };
  writeClaims(claims);
}

// ── An instance of its own ──────────────────────────────────────────────────

/**
 * An instance name from a folder: lowercased to what compose accepts, and
 * starting with `mixos` so its containers read as MixOS's in `docker ps`.
 */
export function slugFor(folder: string): string {
  const slug = path
    .basename(folder)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  if (!slug) return "mixos-copy";
  return slug.startsWith("mixos") ? slug : `mixos-${slug}`;
}

/** The folder's name, or the first `-2`, `-3`, … of it nobody has. */
export function chooseName(folder: string, taken: ReadonlySet<string>): string {
  const slug = slugFor(folder);
  if (!taken.has(slug)) return slug;
  for (let n = 2; ; n++) {
    if (!taken.has(`${slug}-${n}`)) return `${slug}-${n}`;
  }
}

/** The block a port falls in: 54362 is the 54360 block. */
function blockOf(port: number): number {
  return DEFAULT_SUPABASE_PORT_BASE + Math.floor((port - DEFAULT_SUPABASE_PORT_BASE) / BLOCK) * BLOCK;
}

/**
 * The first block above the default that no instance holds and no process
 * listens in. The default block is never handed out: it is `mixos`'s, the
 * instance a checkout without a name is.
 */
export function chooseBase(
  takenBases: ReadonlySet<number>,
  busyPorts: ReadonlySet<number>,
): number | null {
  const offsets = Object.values(OFFSETS);
  for (let k = 1; k <= MAX_BLOCKS; k++) {
    const base = DEFAULT_SUPABASE_PORT_BASE + k * BLOCK;
    if (takenBases.has(base)) continue;
    if (offsets.some((offset) => busyPorts.has(base + offset))) continue;
    return base;
  }
  return null;
}

/**
 * What the machine already has: every instance name in use, and every
 * Supabase port block held. Claims, plus Docker's own record for instances
 * booted before claims existed — their containers' names, and the host ports
 * their database containers are bound to, which Docker keeps even while they
 * are stopped.
 */
function machineInstances(): { names: Set<string>; bases: Set<number>; inspectors: Set<number> } {
  const claims = readClaims();
  const names = new Set<string>([DEFAULT_INSTANCE, ...Object.keys(claims)]);
  const bases = new Set<number>([DEFAULT_SUPABASE_PORT_BASE]);
  const inspectors = new Set<number>([DEFAULT_INSPECTOR_PORT]);
  for (const claim of Object.values(claims)) {
    bases.add(claim.portBase);
    inspectors.add(claim.inspectorPort);
  }

  const projects = docker(["ps", "-a", "--format", '{{.Label "com.docker.compose.project"}}']);
  for (const line of projects?.split("\n") ?? []) if (line.trim()) names.add(line.trim());

  const dbs = docker(["ps", "-a", "--filter", "name=supabase_db_", "--format", "{{.Names}}"]);
  const dbNames = (dbs?.split("\n") ?? []).map((line) => line.trim()).filter(Boolean);
  for (const db of dbNames) names.add(db.replace(/^supabase_db_/, ""));
  if (dbNames.length) {
    const bound = docker([
      "inspect",
      "--format",
      "{{range $port, $bindings := .HostConfig.PortBindings}}{{range $bindings}}{{.HostPort}} {{end}}{{end}}",
      ...dbNames,
    ]);
    for (const port of bound?.match(/\d+/g) ?? []) bases.add(blockOf(Number(port)));
  }

  return { names, bases, inspectors };
}

export type OwnInstance = { name: string; portBase: number; inspectorPort: number };

/**
 * An instance for `root` that nothing on this machine has: its folder's name,
 * the next free port block, and an inspector port to match. Null only when
 * every block is taken, which is far more instances than anyone runs.
 */
export function chooseOwnInstance(root: string): OwnInstance | null {
  const { names, bases, inspectors } = machineInstances();
  const busy = new Set(listeners().map((l) => l.port));
  const portBase = chooseBase(bases, busy);
  if (portBase === null) return null;
  let inspectorPort = DEFAULT_INSPECTOR_PORT + (portBase - DEFAULT_SUPABASE_PORT_BASE) / BLOCK;
  while (inspectors.has(inspectorPort) || busy.has(inspectorPort)) inspectorPort++;
  return { name: chooseName(root, names), portBase, inspectorPort };
}

/**
 * Give `root` its instance, in its `.env.instance`. Appended when the file
 * already holds settings of its own (a pinned MIXOS_PORT, say), so nothing the
 * person wrote is lost; it has no MIXOS_INSTANCE, or there would be nothing to
 * give.
 */
export function writeInstanceFile(
  root: string,
  own: OwnInstance,
  because: { owner: string; instance: string },
): void {
  const file = path.join(root, ".env.instance");
  const owner = tilde(because.owner);
  const block = [
    `# Written by \`npm run dev:docker\`: ${owner} already uses the instance`,
    `# \`${because.instance}\`, and an instance is one database. This checkout got its own:`,
    "# its own containers, its own ports, and a fresh database. Rename it here if",
    "# you like (see .env.instance.example); the old name's data stays with it.",
    `MIXOS_INSTANCE=${own.name}`,
    `MIXOS_SUPABASE_PORT_BASE=${own.portBase}`,
    `MIXOS_INSPECTOR_PORT=${own.inspectorPort}`,
    "",
  ].join("\n");
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, `${existing}${existing.endsWith("\n") ? "" : "\n"}\n${block}`);
  } else {
    fs.writeFileSync(file, block);
  }
}

/**
 * The refusal every command but the boot gives on another folder's instance:
 * what it would have touched, and how this checkout gets its own.
 */
export function notYourInstance(name: string, owner: string, doing: string): string {
  return (
    `\`${name}\` is the instance of ${tilde(owner)}, not of this checkout, so ${doing} here would ` +
    "act on that checkout's database. Run it there, or run `npm run dev:docker` here first: " +
    "it gives this checkout an instance and a database of its own."
  );
}
