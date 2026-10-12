/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "@/lib/apps/access";
import { requireReadOnlySession } from "@/lib/auth/session";

/**
 * The App's setup URL: GitHub sends the admin here after they install the App,
 * or change its installation, with `installation_id` and `setup_action`.
 *
 * It changes nothing. A GET that anyone can link to shouldn't link a
 * repository, so this only takes the admin back to Admin > GitHub, carrying the
 * installation id as a hint, where Finish linking (a server action) does the
 * work and checks the id against what GitHub lists for the App. After a change
 * to the installation, the page asks the admin to check again.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const session = await requireReadOnlySession();
  try {
    await requireAdmin(session);
  } catch {
    return new NextResponse("Admin access required.", { status: 403 });
  }

  const params = request.nextUrl.searchParams;
  const target = new URL("/admin/github", request.nextUrl.origin);
  const id = params.get("installation_id");
  if (id && /^[1-9][0-9]{0,15}$/.test(id) && Number.isSafeInteger(Number(id))) {
    target.searchParams.set("installed", id);
  }
  if (params.get("setup_action") === "update") target.searchParams.set("changed", "1");
  return NextResponse.redirect(target);
}
