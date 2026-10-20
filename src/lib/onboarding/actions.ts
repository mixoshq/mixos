/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use server";

import { createServiceClient } from "@/lib/db/server";
import {
  requireReadOnlySession,
  requireServerSession,
} from "@/lib/auth/session";
import { revalidatePath } from "next/cache";
import { onboardingCompletedAtFor } from "./completed";

/**
 * When this user finished (or skipped) the welcome tour, or null if they have
 * not. Null is what makes the tour play; see `docs/plans/*-welcome-tour.md`.
 */
export async function getOnboardingCompletedAt(): Promise<string | null> {
  const session = await requireReadOnlySession();
  return onboardingCompletedAtFor(session.user.id);
}

export async function markOnboardingComplete(): Promise<void> {
  const session = await requireServerSession();
  const supabase = createServiceClient();
  await supabase
    .from("users")
    .update({ onboarding_completed_at: new Date().toISOString() })
    .eq("id", session.user.id);
  revalidatePath("/", "layout");
}

export async function resetOnboarding(): Promise<void> {
  const session = await requireServerSession();
  const supabase = createServiceClient();
  await supabase
    .from("users")
    .update({ onboarding_completed_at: null })
    .eq("id", session.user.id);
  revalidatePath("/", "layout");
}
