/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { NextResponse } from "next/server";
import { sql } from "@/lib/db/client";
import { schemaVersionStatus } from "@/lib/platform/schema-version";

// Readiness probe: can this pod serve traffic right now? Two questions, in
// order, because the second is only meaningful if the first passes:
//
//   1. Is the database reachable? Pings with a 2s cap. Unreachable returns 503
//      so an external monitor removes this pod from the Service until it
//      recovers — without restarting it.
//   2. Does the database have the schema this build expects? A revision whose
//      migrations have not been applied yet will start cleanly and then fail on
//      whichever request first touches a missing column, so it must not be
//      routed to. See src/lib/platform/schema-version.ts for why the check
//      lives here rather than at boot.
//
// The Docker HEALTHCHECK deliberately points at /api/health/live, not here, so
// neither answer can put a container into a restart loop.
export const dynamic = "force-dynamic";

const READY_TIMEOUT_MS = 2000;

export async function GET() {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error("db check timeout")),
        READY_TIMEOUT_MS
      );
    });
    await Promise.race([sql`SELECT 1`, timeoutPromise]);
  } catch (err) {
    console.error("readiness probe failed:", err);
    return NextResponse.json({ status: "unavailable" }, { status: 503 });
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  // Cached for a few seconds inside the helper: the answer changes once per
  // deployment and this endpoint is polled continuously.
  const schema = await schemaVersionStatus();
  if (!schema.ok) {
    // Loud on every probe rather than once. This is the state where an operator
    // is looking for a reason a rollout is stuck, and the log is where they look.
    console.error(`readiness probe failed: ${schema.message}`);
    return NextResponse.json(
      {
        status: "unavailable",
        reason: "schema-behind",
        expectedSchemaVersion: schema.expected,
        actualSchemaVersion: schema.actual,
        message: schema.message,
      },
      { status: 503 }
    );
  }

  return NextResponse.json({
    status: "ok",
    schemaVersion: schema.actual,
  });
}
