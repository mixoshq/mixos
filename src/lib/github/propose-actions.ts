/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use server";

/**
 * Browse's "Propose to <owner>/<repo>": the check the dialog shows when it
 * opens, and the proposal. And "Propose update" and "Propose removal" for an
 * extension in the build: the check, an update's comparison, and the
 * proposal.
 *
 * Every export here is a directly invocable POST endpoint, so each requires an
 * admin before anything else: the work in ./propose.ts and
 * ./propose-change.ts calls `admin()`, which is requireAdmin(), first
 * (docs/security-architecture.md §9). None trusts its input: each parses the
 * kind and slug, and the version and the admin's acceptances are only ever
 * narrowed by them.
 */

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/apps/access";
import { requireReadOnlySession } from "@/lib/auth/session";
import { KIND_SEGMENT, type ExtensionKind } from "@/lib/repository/types";
import type {
  ChangeAction,
  ChangeProposalCheckOutcome,
  ProposalCheckOutcome,
  ProposeOutcome,
  UpdateProposalCompareOutcome,
} from "./outcomes";
import { checkProposal, proposeInstall, type ProposeContext } from "./propose";
import { checkChangeProposal, compareUpdateProposal, proposeRemoval, proposeUpdate } from "./propose-change";

/** requireAdmin(), and the identity the audit row is written under. */
async function admin() {
  const session = await requireReadOnlySession();
  const user = await requireAdmin(session);
  return { id: user.id, email: user.email };
}

const thisInstance: ProposeContext = { admin };

/** Read-only: the release, the names, and whether the repository lets it be proposed. */
export async function checkProposalAction(input: { kind: ExtensionKind; slug: string }): Promise<ProposalCheckOutcome> {
  return checkProposal(input, thisInstance);
}

/** Verify the release and open a pull request for it on the linked repository. Audited either way. */
export async function proposeInstallAction(input: {
  kind: ExtensionKind;
  slug: string;
  version?: string;
  allowYanked?: boolean;
}): Promise<ProposeOutcome> {
  const outcome = await proposeInstall(input, thisInstance);
  // The page lists the App's pull requests beside the installs.
  if (outcome.ok) revalidatePath(`/admin/${KIND_SEGMENT[input.kind]}`);
  return outcome;
}

/** Read-only: what this build runs and the default branch holds of it, the releases or what depends on it, and the checks. */
export async function checkChangeProposalAction(input: {
  action: ChangeAction;
  kind: ExtensionKind;
  slug: string;
}): Promise<ChangeProposalCheckOutcome> {
  return checkChangeProposal(input, thisInstance);
}

/** Read-only: what updating the folder on the default branch to `version` would change, both releases verified in memory. */
export async function compareUpdateProposalAction(input: {
  kind: ExtensionKind;
  slug: string;
  version: string;
}): Promise<UpdateProposalCompareOutcome> {
  return compareUpdateProposal(input, thisInstance);
}

/** Verify the release and open a pull request that replaces the extension's folder with it. Audited either way. */
export async function proposeUpdateAction(input: {
  kind: ExtensionKind;
  slug: string;
  version: string;
  allowYanked?: boolean;
  allowOlder?: boolean;
}): Promise<ProposeOutcome> {
  const outcome = await proposeUpdate(input, thisInstance);
  if (outcome.ok) revalidatePath(`/admin/${KIND_SEGMENT[input.kind]}`);
  return outcome;
}

/** Open a pull request that deletes the extension's folder. Audited either way. */
export async function proposeRemovalAction(input: { kind: ExtensionKind; slug: string }): Promise<ProposeOutcome> {
  const outcome = await proposeRemoval(input, thisInstance);
  if (outcome.ok) revalidatePath(`/admin/${KIND_SEGMENT[input.kind]}`);
  return outcome;
}
