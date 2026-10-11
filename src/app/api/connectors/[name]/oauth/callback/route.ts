/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { requireReadOnlySession } from "@/lib/auth/session";
import {
  OAUTH_STATE_COOKIE,
  oauthReturnUrl,
  openFlowState,
} from "@/lib/connectors/oauth";
import { finishConnectorOAuth } from "@/lib/connectors/oauth-flow";

/**
 * Finish a connector's OAuth consent flow: verify the round trip, exchange the
 * code, and store the resulting tokens, encrypted: in the connector's
 * credentials for a tenant connector, or as the user's own grant for a
 * user-scoped one. The checks and the writes are in
 * src/lib/connectors/oauth-flow.ts.
 *
 * Outcomes are reported to the admin as a coarse `?oauth=` status, never as the
 * provider's own error text — those bodies routinely name the tenant, the
 * account, and occasionally the credential.
 */
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ name: string }> },
) {
  const session = await requireReadOnlySession();

  const { name } = await ctx.params;
  const flow = openFlowState(request.cookies.get(OAUTH_STATE_COOKIE)?.value);
  const returnTo = flow?.returnTo ?? "/admin/connectors";

  const { outcome, revalidate } = await finishConnectorOAuth({
    name,
    session,
    flow,
    params: request.nextUrl.searchParams,
  });
  if (revalidate) revalidatePath(revalidate);

  const response = NextResponse.redirect(
    oauthReturnUrl(returnTo, request.nextUrl.origin, name, outcome),
  );
  // One-shot: the flow cookie never outlives the round trip it authorises.
  response.cookies.delete({
    name: OAUTH_STATE_COOKIE,
    path: "/api/connectors",
  });
  return response;
}
