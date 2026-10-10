/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { NextResponse } from "next/server";
import { sql } from "@/lib/db/client";
import { readiness } from "@/lib/platform/readiness";
import { appMigrationStatus, schemaVersionStatus } from "@/lib/platform/schema-version";

// Readiness probe: can this pod serve traffic right now? The three questions it
// asks, and why its answer carries no version numbers, are in
// src/lib/platform/readiness.ts.
//
// The proxy answers this path even while the platform schema is behind, when it
// answers every other path with the maintenance response.
//
// The Docker HEALTHCHECK deliberately points at /api/health/live, not here, so
// no answer can put a container into a restart loop.
export const dynamic = "force-dynamic";

export async function GET() {
  const { httpStatus, body } = await readiness({
    ping: () => sql`SELECT 1`,
    schema: schemaVersionStatus,
    apps: appMigrationStatus,
  });
  return NextResponse.json(body, { status: httpStatus });
}
