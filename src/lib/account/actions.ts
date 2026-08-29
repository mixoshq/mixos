/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/db/server";
import { requireServerSession } from "@/lib/auth/session";
import { getUserById } from "@/lib/apps/access";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { safeErrorMessage } from "@/lib/safe-error";
import type { AccountActionState } from "@/lib/account/state";
import { revokeUserSessions } from "@/lib/auth/revocation";

export async function updateDisplayName(
  _prev: AccountActionState,
  formData: FormData,
): Promise<AccountActionState> {
  try {
    const session = await requireServerSession();
    const name = String(formData.get("displayName") ?? "").trim();
    if (!name) return { error: "Display name cannot be empty.", success: null };
    if (name.length > 120)
      return { error: "Display name is too long.", success: null };

    const supabase = createServiceClient();
    const { error } = await supabase
      .from("users")
      .update({ display_name: name, updated_at: new Date().toISOString() })
      .eq("id", session.user.id);
    if (error) throw new Error(error.message);

    revalidatePath("/account");
    return { error: null, success: "Display name updated." };
  } catch (err) {
    return {
      error: safeErrorMessage(err, "Failed to update display name."),
      success: null,
    };
  }
}

export async function updateEmail(
  _prev: AccountActionState,
  formData: FormData,
): Promise<AccountActionState> {
  try {
    const session = await requireServerSession();
    const email = String(formData.get("email") ?? "")
      .trim()
      .toLowerCase();
    if (!email) return { error: "Email is required.", success: null };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return { error: "Enter a valid email address.", success: null };

    const supabase = createServiceClient();

    const { data: collision } = await supabase
      .from("users")
      .select("id")
      .eq("email", email)
      .neq("id", session.user.id)
      .maybeSingle();
    if (collision) {
      return {
        error: "That email is already in use by another account.",
        success: null,
      };
    }

    const { error } = await supabase
      .from("users")
      .update({ email, updated_at: new Date().toISOString() })
      .eq("id", session.user.id);
    if (error) throw new Error(error.message);

    revalidatePath("/account");
    return { error: null, success: "Email updated." };
  } catch (err) {
    return {
      error: safeErrorMessage(err, "Failed to update email."),
      success: null,
    };
  }
}

export async function updatePassword(
  _prev: AccountActionState,
  formData: FormData,
): Promise<AccountActionState> {
  try {
    const session = await requireServerSession();
    const current = String(formData.get("currentPassword") ?? "");
    const next = String(formData.get("newPassword") ?? "");
    const confirm = String(formData.get("confirmPassword") ?? "");

    if (!next || next.length < 10)
      return {
        error: "New password must be at least 10 characters.",
        success: null,
      };
    if (next !== confirm)
      return {
        error: "New password and confirmation do not match.",
        success: null,
      };

    const dbUser = await getUserById(session.user.id);
    if (!dbUser) return { error: "User not found.", success: null };

    if (dbUser.password_hash) {
      if (!current)
        return { error: "Enter your current password.", success: null };
      const ok = await verifyPassword(current, dbUser.password_hash);
      if (!ok)
        return { error: "Current password is incorrect.", success: null };
    }

    const newHash = await hashPassword(next);
    const supabase = createServiceClient();
    const { error } = await supabase
      .from("users")
      .update({
        password_hash: newHash,
        updated_at: new Date().toISOString(),
      })
      .eq("id", session.user.id);
    if (error) throw new Error(error.message);

    // The credential every existing token was minted from is gone, so the
    // tokens go with it. This is the case a "change your password" flow exists
    // for: someone else may be holding a session.
    //
    // Deliberately AFTER the update and deliberately not fatal — a password that
    // changed but sessions that survived is recoverable by the admin
    // force-signout; a password that silently did not change is not.
    try {
      await revokeUserSessions(session.user.id);
    } catch (revokeErr) {
      console.error(
        "[account] password changed but session revocation failed:",
        revokeErr,
      );
    }

    revalidatePath("/account");
    return {
      error: null,
      success: "Password updated. Other sessions have been signed out.",
    };
  } catch (err) {
    return {
      error: safeErrorMessage(err, "Failed to update password."),
      success: null,
    };
  }
}
