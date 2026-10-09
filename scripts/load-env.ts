/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Shared .env loader for the standalone scripts (migrate, seed-admin,
// run-scheduled-jobs). Deliberately hand-rolled rather than taking a dotenv
// dependency — see the note in scripts/migrate.ts that this replaces.
//
// ── Why this is not just "read .env.local" ──────────────────────────────────
// There are two local setups, and they carry their environment differently:
//
//   hosted Supabase  — the developer writes .env.local by hand (README's
//                      "Alternative" path). This is the original behaviour.
//   local Docker     — the default path. It deliberately creates NO .env.local:
//                      .env.docker is committed and .env.docker.local is
//                      generated at boot, and docker-up.ts injects both into
//                      the child processes it spawns.
//
// The consequence, before this file existed, was that `npm run migrate:apps`
// (and seed-admin, and run-scheduled-jobs) worked *inside* `npm run dev:docker`
// and failed with "No Postgres connection configured" when run directly from a
// shell on the Docker path — which is exactly how the docs told people to apply
// an app migration to an already-running stack.
//
// ── Why the Docker fallback is gated ────────────────────────────────────────
// .env.docker is COMMITTED, so it is present on every checkout including one
// set up for hosted Supabase. Merging it unconditionally would leak
// PGSSLMODE=disable into the hosted path, and src/lib/db/pg-options.ts is
// explicit that a silent TLS downgrade against a hosted database is a footgun
// rather than a convenience. So the fallback applies only when ALL hold:
//
//   * no .env.local          — nobody has configured the hosted path,
//   * .env.docker.local exists — the Docker stack has actually been booted
//                                (that file is generated, never committed), and
//   * no connection string   — neither the shell nor .env has set DATABASE_URL
//     is set yet               or POSTGRES_URL.
//
// The third is because the fallback is how a script finds the local stack's
// database, and its other values (PGSSLMODE=disable, the committed admin login)
// belong to that database only: `DATABASE_URL=… npm run seed-admin` must not
// get them for whatever DATABASE_URL names. Discrete PG* fields don't count,
// because a URL wins over them (src/lib/db/pg-options.ts), so the fallback's own
// DATABASE_URL would be the database those values are used with.
//
// When .env.local exists it wins outright and nothing here changes.
//
// scripts/release.ts does not use this at all: the release step reads only the
// environment it is started with.

import fs from "fs";
import path from "path";
import { connectionUrl } from "../src/lib/db/pg-options";

const ROOT = path.resolve(__dirname, "..");

/**
 * Read KEY=VALUE pairs into process.env without overriding anything already
 * set. Shell-provided values therefore always win, which is what lets
 * docker-up.ts inject a fully-formed environment into these same scripts.
 */
function loadEnvFile(
  root: string,
  file: string,
  transform?: (v: string) => string,
): void {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) return;
  for (const line of fs.readFileSync(full, "utf-8").split(/\r?\n/)) {
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
    if (!(key in process.env)) {
      process.env[key] = transform ? transform(value) : value;
    }
  }
}

/**
 * .env.docker.local holds CONTAINER-facing addresses: host.docker.internal is
 * how a container reaches a port published on the host, and it does not resolve
 * from the host itself. A script started from a shell is host-side, so the
 * addresses have to be rewritten or every connection fails with ENOTFOUND.
 */
function toHostAddress(value: string): string {
  return value.replaceAll("host.docker.internal", "127.0.0.1");
}

/**
 * Populate process.env for a standalone script, from the checkout at `root`
 * (this one, unless a test says otherwise). Safe to call more than once.
 */
export function loadEnv(root: string = ROOT): void {
  loadEnvFile(root, ".env.local");
  loadEnvFile(root, ".env");

  const hostedPathConfigured = fs.existsSync(path.join(root, ".env.local"));
  const dockerStackBooted = fs.existsSync(path.join(root, ".env.docker.local"));
  if (hostedPathConfigured || !dockerStackBooted || connectionUrl()) return;

  loadEnvFile(root, ".env.docker", toHostAddress);
  loadEnvFile(root, ".env.docker.local", toHostAddress);
}
