/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use server";

/**
 * The Remove button on Admin > Apps, Admin > Connectors and Admin > Themes:
 * what removing an extension's code would do, and removing it.
 *
 * Every export here is a directly invocable POST endpoint, so each one requires
 * an admin itself before anything else (docs/security-architecture.md §9). The
 * work, and the order of its checks, is in ./remove-admin.ts; these pass it the
 * signed-in admin and what it needs to know about this deployment.
 */

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/apps/access";
import { requireReadOnlySession } from "@/lib/auth/session";
import { thisDatabase } from "@/lib/db/locality";
import { isBuiltDeployment } from "@/lib/platform/build";
import { thisBuildKey } from "@/lib/platform/this-build";
import { deleteDataAfterRemoval, previewDataBeforeRemoval } from "./delete-data-admin";
import type { DataKind } from "./delete-data-outcomes";
import { listedInRegistry } from "./install";
import { previewForButton, removeFromButton } from "./remove-admin";
import type { PreviewOutcome, RemoveOutcome } from "./remove-outcomes";
import type { ExtensionKind } from "./types";

/** requireAdmin(), and the identity the audit row is written under. */
async function admin() {
  const session = await requireReadOnlySession();
  const user = await requireAdmin(session);
  return { id: user.id, email: user.email };
}

// `next dev` compiles what the registry generator wrote on the next request;
// a production build serves what it was built with.
const servesWithoutRebuild = () => process.env.NODE_ENV === "development";

/** What deleting its data, right after its code, needs to know about this server. */
const afterRemoval = {
  servesWithoutRebuild,
  database: thisDatabase,
  listedInRegistry: (kind: DataKind, slug: string) => listedInRegistry(kind, slug),
  ownBuildKey: thisBuildKey,
};

const thisDeployment = {
  admin,
  builtDeployment: isBuiltDeployment,
  revalidate: (path: string, type?: "layout" | "page") => revalidatePath(path, type),
  servesWithoutRebuild,
  previewData: (kind: DataKind, slug: string) => previewDataBeforeRemoval(kind, slug, afterRemoval),
  deleteData: (kind: DataKind, slug: string, actor: { id: string | null; email: string }) =>
    deleteDataAfterRemoval(kind, slug, actor, afterRemoval),
};

/** What removing it would do: what goes, what stays, and what stands in its way. Reads only. */
export async function previewRemovalAction(input: { kind: ExtensionKind; slug: string }): Promise<PreviewOutcome> {
  return previewForButton(input, thisDeployment);
}

/**
 * Remove its code from this checkout. Its data stays in each database, unless
 * `deleteData` is set and its name typed: then this checkout's database loses
 * it too, with the same checks as Delete data.
 */
export async function removeExtensionAction(input: {
  kind: ExtensionKind;
  slug: string;
  deleteData?: boolean;
  typedSlug?: string;
}): Promise<RemoveOutcome> {
  return removeFromButton(input, thisDeployment);
}
