/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { NextResponse } from "next/server";
import { getReadOnlySession } from "@/lib/auth/session";
import { saveSubscription, type RawSubscription } from "@/lib/push/subscriptions";

export const dynamic = "force-dynamic";

/** Persist the browser's PushSubscription for the logged-in user. */
export async function POST(request: Request) {
  const session = await getReadOnlySession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sub = (await request.json().catch(() => null)) as RawSubscription | null;
  if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
    return NextResponse.json({ error: "Invalid subscription" }, { status: 400 });
  }

  try {
    await saveSubscription(
      session.user.id,
      sub,
      request.headers.get("user-agent"),
    );
  } catch {
    return NextResponse.json(
      { error: "Failed to save subscription" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
