/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireReadOnlySession } from "@/lib/auth/session";
import { revokeClientForUser } from "@/lib/mcp/store";

/**
 * Disconnect an MCP client. Scoped to the acting user's own session — the
 * client id arrives from a form field, so it is never trusted as an
 * authorization: the revoke is always `WHERE user_id = <session user>`.
 */
export async function revokeMcpClient(formData: FormData): Promise<void> {
  const session = await requireReadOnlySession().catch(() => null);
  if (!session) redirect("/login");

  const clientId = String(formData.get("client_id") ?? "");
  if (!clientId) return;

  await revokeClientForUser(session.user.id, clientId);
  revalidatePath("/account/mcp");
}
