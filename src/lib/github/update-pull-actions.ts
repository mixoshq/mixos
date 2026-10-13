/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use server";

/**
 * The release notice's "Open an update pull request".
 *
 * A directly invocable POST endpoint, so it requires an admin before anything
 * else: the work in ./update-pull.ts calls `admin()`, which is requireAdmin(),
 * first (docs/security-architecture.md §9). It trusts nothing in its input but
 * the tag's shape: the commit comes from the release on record, never from the
 * request.
 *
 * It revalidates nothing itself: the notice re-renders into "pull request #N
 * was opened" as soon as the page refreshes, and doing that from here would
 * take the dialog, and its answer, away from under the admin. The dialog
 * refreshes the page when it is closed (src/components/admin/update-pull-request.tsx).
 */

import { requireAdmin } from "@/lib/apps/access";
import { requireReadOnlySession } from "@/lib/auth/session";
import type { UpdateOutcome } from "./outcomes";
import type { ProposeContext } from "./propose";
import { proposeMixOSUpdate } from "./update-pull";

/** requireAdmin(), and the identity the audit row is written under. */
async function admin() {
  const session = await requireReadOnlySession();
  const user = await requireAdmin(session);
  return { id: user.id, email: user.email };
}

const thisInstance: ProposeContext = { admin };

/** Verify the release's tag on GitHub, then open a pull request for it. Audited either way. */
export async function proposeMixOSUpdateAction(input: { tag: string }): Promise<UpdateOutcome> {
  return proposeMixOSUpdate(input, thisInstance);
}
