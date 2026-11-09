/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "@/lib/apps/access";
import { requireReadOnlySession } from "@/lib/auth/session";
import {
  MANIFEST_STATE_COOKIE,
  MANIFEST_STATE_COOKIE_PATH,
  finishAppCreation,
} from "@/lib/github/link";

/**
 * Where GitHub sends the admin after creating the App from its manifest, with
 * `code` and `state`. The state has to match the one in the admin's cookie and
 * the one kept for them, once; then the code is exchanged for the App
 * (src/lib/github/link.ts). The admin lands back on Developers > GitHub App, with the
 * outcome as a fixed code in the query string, never the code from GitHub.
 *
 * A browser navigation carrying a session cookie, so not in the proxy's public
 * prefixes: no session goes to /login. An admin is required before anything
 * is read.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const session = await requireReadOnlySession();
  let actor: { id: string; email: string };
  try {
    const user = await requireAdmin(session);
    actor = { id: user.id, email: user.email };
  } catch {
    return new NextResponse("Admin access required.", { status: 403 });
  }

  const params = request.nextUrl.searchParams;
  const outcome = await finishAppCreation(
    {
      code: params.get("code"),
      state: params.get("state"),
      cookieState: request.cookies.get(MANIFEST_STATE_COOKIE)?.value ?? null,
    },
    actor,
  );
  revalidatePath("/admin/github");

  const target = new URL("/admin/github", request.nextUrl.origin);
  target.searchParams.set("created", outcome);
  const response = NextResponse.redirect(target);
  // One round trip per state, whatever happened.
  response.cookies.delete({ name: MANIFEST_STATE_COOKIE, path: MANIFEST_STATE_COOKIE_PATH });
  return response;
}
