/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { NextResponse } from "next/server";
import { getReadOnlySession } from "@/lib/auth/session";
import { getVapidConfig, isPushConfigured } from "@/lib/push/vapid";

export const dynamic = "force-dynamic";

/** Returns the VAPID public key the client needs to subscribe. */
export async function GET() {
  const session = await getReadOnlySession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isPushConfigured()) {
    return NextResponse.json({ error: "Push not configured" }, { status: 503 });
  }
  return NextResponse.json({ key: getVapidConfig().publicKey });
}
