/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use server";

/**
 * The review, Register and Discard on Admin > Apps and Admin > Connectors, and
 * "Activate in this checkout" after Register.
 *
 * Every export here is a directly invocable POST endpoint, so each one requires
 * an admin itself before anything else (docs/security-architecture.md §9). The
 * work, and the order of its checks, is in ./pending-admin.ts; these pass it the
 * signed-in admin and what it needs to know about this deployment.
 */

import { revalidatePath } from "next/cache";
import { appRegistry } from "@/generated/app-registry";
import { requireAdmin } from "@/lib/apps/access";
import { setAppActiveAction } from "@/lib/apps/admin-actions";
import { requireReadOnlySession } from "@/lib/auth/session";
import { thisDatabase } from "@/lib/db/locality";
import { isBuiltDeployment } from "@/lib/platform/build";
import type { PendingKind } from "./pending";
import {
  activateFromButton,
  discardFromButton,
  listingFacts,
  registerFromButton,
  reviewForButton,
} from "./pending-admin";
import type {
  ActivateOutcome,
  DiscardOutcome,
  RegisterOutcome,
  ReviewOutcome,
} from "./pending-outcomes";

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

/** What will run, from the pending install, and what the catalogue claims for it. Reads only. */
export async function reviewPendingAction(input: {
  kind: PendingKind;
  slug: string;
}): Promise<ReviewOutcome> {
  return reviewForButton(input, { ...thisDeployment, listing: listingFacts });
}

/** Register the pending install the admin reviewed, identified by its files hash. */
export async function registerPendingAction(input: {
  kind: PendingKind;
  slug: string;
  reviewedFilesHash: string;
}): Promise<RegisterOutcome> {
  return registerFromButton(input, {
    ...thisDeployment,
    database: thisDatabase,
    // `next dev` compiles what the registry generator wrote on the next
    // request; a production build serves what it was built with.
    servesWithoutRebuild: () => process.env.NODE_ENV === "development",
  });
}

/** Delete a pending install, folder and record. */
export async function discardPendingAction(input: {
  kind: PendingKind;
  slug: string;
}): Promise<DiscardOutcome> {
  return discardFromButton(input, thisDeployment);
}

/** Turn a just-registered app on in this checkout's database, when that database is local. */
export async function activateInCheckoutAction(input: { slug: string }): Promise<ActivateOutcome> {
  return activateFromButton(input, {
    admin,
    builtDeployment: isBuiltDeployment,
    database: thisDatabase,
    inThisBuild: (slug) => appRegistry.some((a) => a.slug === slug),
    activate: (slug) => setAppActiveAction(slug, true),
  });
}
