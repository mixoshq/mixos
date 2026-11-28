/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { readSecret } from "@/lib/env/secrets";
import { connectorRegistry } from "@/generated/connector-registry";
import { runDueJobs } from "@/lib/apps/scheduler";
import { pruneRateBuckets } from "@/lib/rate-limit";
import { pruneUnlockFailures } from "@/lib/apps/unlock-rate-limit";
import { pruneEgressTelemetry, pruneRouteTelemetry } from "@/lib/apps/telemetry";
import { pruneAcknowledgedAnomalies, runDetection, type DetectionOutcome } from "@/lib/apps/detection";
import { pruneWebhookEvents } from "@/lib/connectors/webhook";
import { runReleaseCheck, type ReleaseCheckOutcome } from "@/lib/platform/release-check";
import { recordThisBuild } from "@/lib/platform/this-build";
import { runUpdateCheck, type UpdateCheckOutcome } from "@/lib/repository/update-check";

/**
 * Scheduler tick endpoint, called from outside on a schedule: Vercel Cron (see
 * vercel.json), the local `cron` container, or whatever calls it on your host
 * (docs/apps/scheduled-jobs.md). A serverless instance is frozen between
 * requests, so the tick has to come from outside; `runDueJobs()` claims each
 * job with an atomic Postgres UPDATE, which is what makes an
 * overlapping or duplicated invocation harmless. After the jobs it prunes, and
 * then runs the update check (src/lib/repository/update-check.ts) and the
 * release check (src/lib/platform/release-check.ts), each when one is due.
 *
 * AUTH: Vercel signs cron invocations with the CRON_SECRET environment variable
 * as `Authorization: Bearer <secret>`. Without that check this route would be a
 * public, unauthenticated way for anyone to trigger every app's background jobs
 * on demand. The route IS on the proxy's public-route list (src/proxy.ts), and
 * that is deliberate: the proxy only does a cookie-presence check, and "no
 * session cookie" is the expected state for a caller that is not a browser.
 * Removing it from that list does not harden this route, it disables it — the
 * tick 307s to /login, which is a successful HTTP exchange, so the caller
 * records a delivered invocation and runDueJobs() silently never runs. The
 * timing-safe bearer comparison below is the real gate.
 *
 * If CRON_SECRET is unset the route refuses to run rather than defaulting open.
 */
export const dynamic = "force-dynamic";
// Jobs get up to 4 minutes each (JOB_TIMEOUT_MS); give the tick room to finish.
// Every Vercel plan allows 300s with Fluid compute, its default; with it off,
// Hobby stops at 60s. Either way the Postgres claim means a truncated tick
// simply resumes next time.
export const maxDuration = 300;

function authorized(request: NextRequest): boolean {
  const secret = readSecret("CRON_SECRET");
  if (!secret) return false;

  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, so compare lengths first.
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  try {
    await runDueJobs();
  } catch (err) {
    console.error("[cron] tick failed:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
  // Housekeeping, after the jobs and outside their try: a failed prune must not
  // report the tick as failed, and pruneRateBuckets swallows its own errors.
  const prunedBuckets = await pruneRateBuckets();
  const prunedRouteEvents = await pruneRouteTelemetry();
  // What per-app detection adds is bounded: egress rows at 90 days, and
  // anomalies an admin marked as expected at 180. Connector rows are kept.
  const prunedEgressEvents = await pruneEgressTelemetry();
  const prunedAnomalies = await pruneAcknowledgedAnomalies();
  // A connector whose webhook signs a timestamp has its replay markers swept
  // after a day. Every other marker is kept for 90 days, because for those it
  // is the one thing refusing a replay.
  const prunedWebhookEvents = await pruneWebhookEvents(
    connectorRegistry
      .filter((c) => c.webhook?.timestampHeader)
      .map((c) => c.name),
  );
  const prunedUnlockFailures = await pruneUnlockFailures();
  // Which apps and connectors this build carries, for Delete data on every
  // instance sharing the database (src/lib/platform/builds-seen.ts). At most
  // every ten minutes, and it never throws.
  const buildSeen = await recordThisBuild();

  // The update check, last and in a catch of its own: it asks the catalogue
  // about this build's installs when a check is due, which is about once a
  // day, and nothing it does may fail the tick. A failed request is recorded
  // and retried by the check itself; only something unexpected lands here.
  let updateCheck: UpdateCheckOutcome | "error";
  try {
    updateCheck = await runUpdateCheck();
  } catch (err) {
    console.error("[cron] update check failed:", err);
    updateCheck = "error";
  }

  // The release check, the same way: it asks mixos.org which releases of
  // MixOS exist, about once a day, and a failure stays out of the tick's answer.
  let releaseCheck: ReleaseCheckOutcome | "error";
  try {
    releaseCheck = await runReleaseCheck();
  } catch (err) {
    console.error("[cron] release check failed:", err);
    releaseCheck = "error";
  }

  // Per-app detection (src/lib/apps/detection.ts), at most every 15 minutes,
  // in a catch of its own: what it raises is for an admin to read, and a
  // failure here mustn't fail the tick.
  let detection: DetectionOutcome | "error";
  try {
    detection = await runDetection();
  } catch (err) {
    console.error("[cron] detection failed:", err);
    detection = "error";
  }

  return NextResponse.json({
    ok: true,
    durationMs: Date.now() - startedAt,
    prunedBuckets,
    prunedRouteEvents,
    prunedEgressEvents,
    prunedAnomalies,
    detection,
    prunedUnlockFailures,
    prunedWebhookEvents,
    buildSeen,
    updateCheck,
    releaseCheck,
  });
}
