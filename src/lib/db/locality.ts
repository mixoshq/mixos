/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Is the database this server uses one that only this machine reaches?
 *
 * A checkout can point at a database other instances use too:
 * docs/hosting/development.md documents sharing a development database, and a
 * staging instance can share one with a developer's checkout. An app's switch,
 * `apps.is_active`, is a row in that database, so turning an app on from a
 * checkout turns it on for every instance on the same database, including one
 * that deploys the app later.
 * So what a checkout does to its own database after Register, "Activate in this
 * checkout", is offered and allowed only when the database is local:
 *
 *   - a Unix socket, which is on this machine by definition;
 *   - loopback: `localhost`, 127.0.0.0/8 and `::1`;
 *   - `host.docker.internal`, which is how a container reaches its host.
 *
 * Those cover the dev stack's own database from both sides: its container
 * reaches it at `host.docker.internal` (scripts/docker-up.ts writes that into
 * `.env.docker.local`), and a shell on the host reaches the same database on
 * loopback (scripts/load-env.ts).
 *
 * Anything else counts as shared, including a name that happens to resolve to
 * this machine: a name says nothing about who else uses the database, and when
 * this can't tell, the answer is the one that sends the admin to the instance
 * that serves the app.
 *
 * Every host the pool may connect to has to be local. A connection string can
 * name several, and postgres.js tries them in turn.
 */

import { sql } from "./client";

/** Where this server's database is, for a person and for the decision. */
export interface DatabaseLocation {
  /** The hosts the pool connects to: names only, never a URL or a credential. */
  hosts: string[];
  /** Every one of them is on this machine. */
  local: boolean;
}

const LOCAL_NAMES = new Set(["localhost", "host.docker.internal"]);

/** IPv4 loopback, 127.0.0.0/8. */
function isLoopbackV4(address: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  return m !== null && Number(m[1]) === 127 && m.slice(2).every((o) => Number(o) <= 255);
}

/** Whether one host a connection names is on this machine. */
export function isLocalDatabaseHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (!h) return false;
  // A Unix socket's directory, which is what PGHOST holds for one.
  if (h.startsWith("/")) return true;
  if (LOCAL_NAMES.has(h)) return true;
  const bare = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  if (bare === "::1" || bare === "0:0:0:0:0:0:0:1") return true;
  return isLoopbackV4(bare.replace(/^::ffff:/, ""));
}

/**
 * Where a postgres.js pool's parsed options point. `host` is the list it
 * connects to; `path`, when set, is a Unix socket.
 */
export function describeDatabase(options: {
  host?: readonly string[] | null;
  path?: string | false | null;
}): DatabaseLocation {
  const hosts = [...new Set((options.host ?? []).map((h) => h.trim()).filter(Boolean))];
  if (typeof options.path === "string" && options.path) {
    return { hosts: hosts.length > 0 ? hosts : ["a Unix socket"], local: true };
  }
  return { hosts, local: hosts.length > 0 && hosts.every(isLocalDatabaseHost) };
}

/**
 * The database this server uses, read from its own pool's options, so it is
 * the database Register's lock and audit row went to. One that can't be read
 * counts as shared.
 */
export function thisDatabase(): DatabaseLocation {
  try {
    return describeDatabase(sql.options);
  } catch {
    return { hosts: [], local: false };
  }
}
