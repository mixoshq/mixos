/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { NextResponse } from "next/server";
import { getReadOnlySession } from "@/lib/auth/session";
import { sql } from "@/lib/db/client";
import { appRegistry } from "@/generated/app-registry";

export const dynamic = "force-dynamic";

/**
 * Records an "app opened" analytics event for the logged-in user. Fired by a
 * client beacon when an app page mounts (see components/analytics/track-app-open).
 *
 * Best-effort: any failure returns a status but never blocks navigation, and we
 * validate the slug against the compile-time registry so the table can't be
 * stuffed with arbitrary keys.
 */
export async function POST(request: Request) {
  const session = await getReadOnlySession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    appSlug?: unknown;
  } | null;
  const appSlug = typeof body?.appSlug === "string" ? body.appSlug : "";
  if (!appSlug || !appRegistry.some((a) => a.slug === appSlug)) {
    return NextResponse.json({ error: "Invalid appSlug" }, { status: 400 });
  }

  try {
    await sql`
      insert into public.app_open_events (user_id, app_slug)
      values (${session.user.id}, ${appSlug})
    `;
  } catch {
    // Analytics is non-critical — swallow write failures.
    return NextResponse.json({ error: "Failed to record" }, { status: 500 });
  }

  return new NextResponse(null, { status: 204 });
}
