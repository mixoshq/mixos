/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use server";

/**
 * Deployment > Production Updates's buttons.
 *
 * Every export here is a directly invocable POST endpoint, so each one
 * requires an admin before anything else: the work in ./link.ts calls
 * `admin()`, which is requireAdmin(), first (docs/security-architecture.md §9).
 * These pass it the signed-in admin and this instance's public URL.
 *
 * Replace private key isn't here: `next dev` prints a server action's
 * arguments, so the key goes to src/app/api/admin/github/key/route.ts instead.
 */

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { requireAdmin } from "@/lib/apps/access";
import { requireReadOnlySession } from "@/lib/auth/session";
import { getAppOrigin } from "@/lib/env/origin";
import {
  MANIFEST_STATE_COOKIE,
  MANIFEST_STATE_COOKIE_PATH,
  MANIFEST_STATE_TTL_MS,
  checkLink,
  confirmBranchProtection,
  confirmPreviewChecklist,
  finishLinking,
  forgetApp,
  startAppCreation,
  unlink,
  withdrawBranchProtection,
  withdrawPreviewChecklist,
  type LinkContext,
} from "./link";
import type { GitHubOutcome, StartOutcome } from "./outcomes";

/** requireAdmin(), and the identity the audit row is written under. */
async function admin() {
  const session = await requireReadOnlySession();
  const user = await requireAdmin(session);
  return { id: user.id, email: user.email };
}

const thisInstance: LinkContext = { admin, origin: getAppOrigin };

const PAGE = "/admin/github";

async function done(outcome: GitHubOutcome): Promise<GitHubOutcome> {
  revalidatePath(PAGE);
  return outcome;
}

/**
 * Begin creating the App: answers with the manifest and where to post it, and
 * puts the round trip's state in an HttpOnly cookie for the route GitHub sends
 * the admin back to.
 */
export async function startAppCreationAction(input: {
  account: "user" | "organization";
  organization?: string;
  name: string;
}): Promise<StartOutcome> {
  const { outcome, cookieState } = await startAppCreation(input, thisInstance);
  if (outcome.ok && cookieState) {
    (await cookies()).set(MANIFEST_STATE_COOKIE, cookieState, {
      httpOnly: true,
      // Lax, not Strict: GitHub sends the admin back with a top-level GET from
      // github.com, which Strict would strip it from.
      sameSite: "lax",
      secure: getAppOrigin().startsWith("https:"),
      path: MANIFEST_STATE_COOKIE_PATH,
      maxAge: Math.floor(MANIFEST_STATE_TTL_MS / 1000),
    });
  }
  return outcome;
}

/** Link the App's installation, once it is installed on GitHub. */
export async function finishLinkingAction(input: { installationId?: number }): Promise<GitHubOutcome> {
  return done(await finishLinking(input, thisInstance));
}

/** Check the installation, the repository and its branch rule again. */
export async function checkLinkAction(): Promise<GitHubOutcome> {
  return done(await checkLink(thisInstance));
}

/** Uninstall the App on GitHub, then forget it here. */
export async function unlinkAction(): Promise<GitHubOutcome> {
  return done(await unlink(thisInstance));
}

/** Forget an App whose key no longer works, with its slug typed. */
export async function forgetAppAction(input: { typedSlug: string }): Promise<GitHubOutcome> {
  return done(await forgetApp(input, thisInstance));
}

/** Confirm the default branch is protected in a way the App can't see, with the repository's name typed. */
export async function confirmBranchProtectionAction(input: {
  reason: "classic-protection" | "free-private";
  typedRepository: string;
}): Promise<GitHubOutcome> {
  return done(await confirmBranchProtection(input, thisInstance));
}

/** Withdraw that confirmation. */
export async function withdrawBranchProtectionAction(): Promise<GitHubOutcome> {
  return done(await withdrawBranchProtection(thisInstance));
}

/** Confirm that no host builds previews of the App's branches: what the App can't read for itself. */
export async function confirmPreviewChecklistAction(input: { items: string[] }): Promise<GitHubOutcome> {
  return done(await confirmPreviewChecklist(input, thisInstance));
}

/** Withdraw that confirmation. */
export async function withdrawPreviewChecklistAction(): Promise<GitHubOutcome> {
  return done(await withdrawPreviewChecklist(thisInstance));
}
