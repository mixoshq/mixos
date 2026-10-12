/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use server";

/**
 * Browse's "Propose to <owner>/<repo>": the check the dialog shows when it
 * opens, and the proposal.
 *
 * Every export here is a directly invocable POST endpoint, so each requires an
 * admin before anything else: the work in ./propose.ts calls `admin()`, which
 * is requireAdmin(), first (docs/security-architecture.md §9). Neither trusts
 * its input: ./propose.ts parses the kind and slug, and the version and the
 * yank's acceptance are only ever narrowed by them.
 */

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/apps/access";
import { requireReadOnlySession } from "@/lib/auth/session";
import { KIND_SEGMENT, type ExtensionKind } from "@/lib/repository/types";
import type { ProposalCheckOutcome, ProposeOutcome } from "./outcomes";
import { checkProposal, proposeInstall, type ProposeContext } from "./propose";

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
