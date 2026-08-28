/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { NextResponse } from "next/server";
import { sql } from "@/lib/db/client";

// Readiness probe: can this pod serve traffic right now? Pings the DB
// with a 2s cap. If the DB is unreachable we return 503 so an external
// monitor can see the instance is not serving traffic and removes
// this pod from the Service until it recovers — without restarting it.
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
    return NextResponse.json({ status: "ok" });
  } catch (err) {
    console.error("readiness probe failed:", err);
    return NextResponse.json(
      { status: "unavailable" },
      { status: 503 }
    );
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}
