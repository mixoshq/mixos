/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Run one scheduler tick from the command line.
 *
 *   npx tsx scripts/run-scheduled-jobs.ts
 *
 * In production the tick comes from Vercel Cron hitting /api/cron every 5
 * minutes (see vercel.json). On the local Docker path the compose `cron`
 * sidecar makes the same call every 5 minutes, so jobs DO fire locally — this
 * script is for driving a tick immediately instead of waiting for the next one,
 * and for the hosted-Supabase path, which has no ticker at all.
 *
 * It uses the same runDueJobs() dispatcher, and the per-job Postgres claim
 * keeps it safe to run against a database something else is also ticking.
 *
 * Note on exit codes: runDueJobs() is deliberately fail-soft — it logs and
 * swallows, so one broken job cannot kill a tick that Vercel Cron will retry.
 * That means it cannot report failure to us. The preflight below therefore
 * checks the one failure that would otherwise make this script print
 * "tick complete" while having done nothing at all: an unreachable database.
 */
import { loadEnv } from "./load-env";

loadEnv();

async function main() {
  const { createPgClient } = await import("../src/lib/db/pg-options");
  const probe = createPgClient({ max: 1 });
  try {
    await probe`SELECT 1`;
  } catch (err) {
    console.error(
      "[run-scheduled-jobs] cannot reach Postgres — no jobs were run.\n" +
        "  Local Docker: is the stack up? `npm run dev:docker -- --detach`\n" +
        "  Hosted:       check DATABASE_URL and PGSSLMODE in .env.local\n",
      err,
    );
    process.exit(1);
  } finally {
    await probe.end();
  }

  const { runDueJobs } = await import("@/lib/apps/scheduler");
  await runDueJobs();
  console.log("[run-scheduled-jobs] tick complete");
  process.exit(0);
}

main().catch((err) => {
  console.error("[run-scheduled-jobs] failed:", err);
  process.exit(1);
});
