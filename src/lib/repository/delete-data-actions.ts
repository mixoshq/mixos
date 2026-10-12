/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use server";

/**
 * **Delete data…** under Not in this build on Admin > Apps and Admin >
 * Connectors: what deleting an extension's data would delete, and deleting it.
 *
 * Every export here is a directly invocable POST endpoint, so each one requires
 * an admin itself before anything else (docs/security-architecture.md §9). The
 * work, and the order of its checks, is in ./delete-data-admin.ts; these pass
 * it the signed-in admin and what it needs to know about this server.
 */

import { appRegistry } from "@/generated/app-registry";
import { connectorRegistry } from "@/generated/connector-registry";
import { requireAdmin } from "@/lib/apps/access";
import { requireReadOnlySession } from "@/lib/auth/session";
import { thisBuildKey } from "@/lib/platform/this-build";
import { deleteDataFromButton, previewDataForButton } from "./delete-data-admin";
import type { DataDeleteOutcome, DataKind, DataPreviewOutcome } from "./delete-data-outcomes";

/** requireAdmin(), and the identity the audit row is written under. */
async function admin() {
  const session = await requireReadOnlySession();
  const user = await requireAdmin(session);
  return { id: user.id, email: user.email };
}

const thisServer = {
  admin,
  inThisBuild: (kind: DataKind, slug: string) =>
    kind === "app" ? appRegistry.some((a) => a.slug === slug) : connectorRegistry.some((c) => c.name === slug),
  ownBuildKey: thisBuildKey,
};

/** What deleting its data would delete, and whether it would be refused now. Reads only. */
export async function previewDataDeletionAction(input: { kind: DataKind; slug: string }): Promise<DataPreviewOutcome> {
  return previewDataForButton(input, thisServer);
}

/** Delete what this database keeps for it, with its name typed. */
export async function deleteDataAction(input: {
  kind: DataKind;
  slug: string;
  typedSlug: string;
}): Promise<DataDeleteOutcome> {
  return deleteDataFromButton(input, thisServer);
}
