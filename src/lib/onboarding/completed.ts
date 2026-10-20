/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createServiceClient } from "@/lib/db/server";

/**
 * When the user `userId` finished (or skipped) the welcome tour, or null if
 * they have not. Null is what makes the tour play; see
 * `docs/plans/*-welcome-tour.md`.
 *
 * Takes the id of a session already resolved, so the main layout resolves the
 * session once for this and the release banner. Not a server action, and not
 * in ./actions.ts: an action taking a user id would answer for any user.
 */
export async function onboardingCompletedAtFor(userId: string): Promise<string | null> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("users")
    .select("onboarding_completed_at")
    .eq("id", userId)
    .maybeSingle();
  return (data?.onboarding_completed_at as string | null) ?? null;
}
