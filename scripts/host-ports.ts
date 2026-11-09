/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Which host processes are listening on which TCP ports, as the platform's own
// tools report it. Node built-ins only, so the instance claims
// (./instance-claims) can use it from docker-down.ts, which has to run on a
// half-finished checkout; ./local-stack builds the richer questions on it.

import { spawnSync } from "node:child_process";

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

function run(cmd: string, args: string[]): string | null {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return !r.error && r.status === 0 ? r.stdout : null;
}

/**
 * Host processes listening on TCP, on one port or all of them. `lsof` first;
 * Linux distributions do not all ship it, and every one ships ss (iproute2).
 * Only processes this user may inspect are named, which covers every
 * `npm run dev` they started.
 */
export function listeners(port?: number): Listener[] {
  const tcp = port === undefined ? "-iTCP" : `-iTCP:${port}`;
  const lsof = run("lsof", ["+c", "0", "-nP", tcp, "-sTCP:LISTEN", "-Fpcn"]);
  if (lsof !== null) return parseLsofListeners(lsof);
  const ss = run("ss", port === undefined ? ["-Hltnp"] : ["-Hltnp", `sport = :${port}`]);
  return ss !== null ? parseSsListeners(ss) : [];
}
