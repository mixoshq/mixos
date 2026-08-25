"use server";

import { createServiceClient } from "@/lib/db/server";
import {
  requireReadOnlySession,
  requireServerSession,
} from "@/lib/auth/session";
import { revalidatePath } from "next/cache";

export async function getOnboardingCompletedAt(): Promise<string | null> {
  const session = await requireReadOnlySession();
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("users")
    .select("onboarding_completed_at")
    .eq("id", session.user.id)
    .maybeSingle();
  return (data?.onboarding_completed_at as string | null) ?? null;
}

export async function markOnboardingComplete(): Promise<void> {
  const session = await requireServerSession();
  const supabase = createServiceClient();
  await supabase
    .from("users")
    .update({ onboarding_completed_at: new Date().toISOString() })
    .eq("id", session.user.id);
  revalidatePath("/");
}

export async function resetOnboarding(): Promise<void> {
  const session = await requireServerSession();
  const supabase = createServiceClient();
  await supabase
    .from("users")
    .update({ onboarding_completed_at: null })
    .eq("id", session.user.id);
  revalidatePath("/");
}
