/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Supabase CLI, with this instance's identity in its environment.
 *
 * ── WHY A WRAPPER ───────────────────────────────────────────────────────────
 *
 * `supabase/config.toml` reads its project id and its ports from `env(...)`,
 * which the CLI substitutes from ITS OWN environment. A bare `supabase db
 * reset` therefore resolves an EMPTY project id and goes looking for containers
 * called `supabase_db_` — a failure whose message says nothing about the cause.
 *
 * Every entry point that starts the CLI has to set those variables first.
 * `docker-up.ts` does it by resolving the instance before it spawns anything;
 * this is the same thing for the `db:*` scripts, which reach the CLI directly.
 *
 * ── WHY IT PINS THE BINARY ──────────────────────────────────────────────────
 *
 * `node_modules/.bin/supabase`, not whatever `supabase` is on PATH. The
 * repo-local CLI is the version this project's migrations and config were
 * written against; a globally installed one is whatever that machine happens to
 * have, and `npx supabase` will silently download a third. docker-up.ts already
 * insists on the same binary for the same reason.
 *
 * Usage:  npm run supabase -- db reset
 *         npm run supabase -- status
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveInstance } from "./instance";

const ROOT = path.resolve(__dirname, "..");

function main(): void {
  const instance = resolveInstance();

  const bin = path.join(ROOT, "node_modules", ".bin", "supabase");
  if (!fs.existsSync(bin)) {
    console.error(
      "The Supabase CLI is not installed in this repo (node_modules/.bin/supabase is missing).\n" +
        "Run `npm ci` first.",
    );
    process.exit(1);
  }

  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: npm run supabase -- <command>   (e.g. `npm run supabase -- status`)");
    process.exit(1);
  }

  if (!instance.isDefault) {
    console.log(`supabase ${args.join(" ")}  →  project "${instance.name}"`);
  }

  const r = spawnSync(bin, args, { cwd: ROOT, stdio: "inherit", env: process.env });
  process.exit(r.status ?? 1);
}

main();
