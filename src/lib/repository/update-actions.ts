/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use server";

/**
 * The update dialog (src/components/admin/update/update-dialog.tsx): what
 * updating an app or a connector to another release would do, and making the
 * update, which waits in `.mixos/pending/` like an install.
 *
 * Every export here is a directly invocable POST endpoint, so each one requires
 * an admin itself before anything else (docs/security-architecture.md §9). The
 * work, and the order of its checks, is in ./update-admin.ts; these pass it the
 * signed-in admin and what it needs to know about this deployment.
 */

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/apps/access";
import { requireReadOnlySession } from "@/lib/auth/session";
import { isBuiltDeployment } from "@/lib/platform/build";
import type { ReviewedUpdate } from "./install";
import type { ExtensionKind } from "./types";
import { compareForButton, overviewForButton, updateFromButton } from "./update-admin";
import type { ComparisonOutcome, OverviewOutcome, UpdateOutcome } from "./update-outcomes";

/** requireAdmin(), and the identity the audit row is written under. */
async function admin() {
  const session = await requireReadOnlySession();
  const user = await requireAdmin(session);
  return { id: user.id, email: user.email };
}

const thisDeployment = {
  admin,
  builtDeployment: isBuiltDeployment,
  revalidate: (path: string) => revalidatePath(path),
};

/** What is installed, what changed in it, and the releases it can update to. Reads only. */
export async function updateOverviewAction(input: { kind: ExtensionKind; slug: string }): Promise<OverviewOutcome> {
  return overviewForButton(input, thisDeployment);
}

/** What updating to `version` would change, from the release downloaded and verified in memory. Reads only. */
export async function compareUpdateAction(input: {
  kind: ExtensionKind;
  slug: string;
  version: string;
}): Promise<ComparisonOutcome> {
  return compareForButton(input, thisDeployment);
}

/** Download, verify and check `version`, and leave it in pending as an update of what is in place. */
export async function updateExtensionAction(input: {
  kind: ExtensionKind;
  slug: string;
  version: string;
  allowYanked?: boolean;
  allowOlder?: boolean;
  discardLocalChanges?: boolean;
  reviewed: ReviewedUpdate;
}): Promise<UpdateOutcome> {
  return updateFromButton(input, thisDeployment);
}
