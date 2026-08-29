/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use server";

/**
 * Admin edits to somebody else's account.
 *
 * NOT a generalization of `@/lib/account/actions`. Those act on
 * `session.user.id` and prove intent by asking for the account's OWN current
 * password — neither of which an admin can do here. This is a different trust
 * model with different guards, and merging the two would mean a single function
 * whose subject depends on a form field. That is the shape a privilege
 * escalation hides in: miss one `requireAdmin` branch and a user is editing an
 * arbitrary row.
 *
 * Every action below therefore re-derives the actor from the session and calls
 * `requireAdmin` itself. Server actions are directly-invocable POST endpoints
 * (docs/security-architecture.md §9) — a dialog that only renders for admins
 * proves nothing about who is posting to it.
 */

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/db/server";
import { requireReadOnlySession } from "@/lib/auth/session";
import {
  requireAdmin,
  getUserById,
  isAllowedEmailDomain,
  allowedEmailDomains,
} from "@/lib/apps/access";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { revokeUserSessions } from "@/lib/auth/revocation";
import {
  recordAdminAction,
  readAdminAuditLogForTarget,
  type AdminAuditRow,
} from "@/lib/apps/admin-audit";
import { safeErrorMessage } from "@/lib/safe-error";
import type { AccountActionState } from "@/lib/account/state";

/** Same floor the self-service flow enforces. Kept in step deliberately. */
const MIN_PASSWORD_LENGTH = 10;
const MAX_DISPLAY_NAME_LENGTH = 120;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The actor, proven to be an admin, plus the user they are acting on.
 *
 * Returns `null` for a target that does not exist rather than throwing, so the
 * caller can render "user not found" as a form error instead of an unhandled
 * server action rejection.
 */
async function resolveActorAndTarget(userId: string) {
  const session = await requireReadOnlySession();
  const actor = await requireAdmin(session);
  const target = await getUserById(userId);
  return { actor, target };
}

/** Everything that changes when a user record does. */
function revalidateUsers() {
  revalidatePath("/admin/users");
}

/**
 * Create an account by hand.
 *
 * The other way in provisions on first sign-in (`ensureUser`), which requires
 * the person to already be able to authenticate. This is for the case that one
 * cannot serve: standing an account up before its holder has ever arrived.
 *
 * A password is REQUIRED, not optional. `password_hash` is nullable in the
 * schema and `authorize()` refuses a row without one, so an account created
 * without a password is an account nobody can sign into — a dead row that looks
 * like a provisioned user in the table.
 *
 * The `ALLOWED_EMAIL_DOMAINS` policy is enforced here too. It is a deployment
 * rule about who may hold an account, and an admin form is not an exemption
 * from it.
 */
export async function adminCreateUser(
  _prev: AccountActionState,
  formData: FormData,
): Promise<AccountActionState> {
  try {
    const name = String(formData.get("displayName") ?? "").trim();
    const email = String(formData.get("email") ?? "")
      .trim()
      .toLowerCase();
    const password = String(formData.get("password") ?? "");
    const confirm = String(formData.get("confirmPassword") ?? "");
    const makeAdmin = formData.get("isAdmin") === "on";

    if (!name) return { error: "Display name is required.", success: null };
    if (name.length > MAX_DISPLAY_NAME_LENGTH)
      return { error: "Display name is too long.", success: null };
    if (!email) return { error: "Email is required.", success: null };
    if (!EMAIL_RE.test(email))
      return { error: "Enter a valid email address.", success: null };
    if (!isAllowedEmailDomain(email)) {
      const domains = allowedEmailDomains();
      return {
        error: `This deployment only accepts accounts at ${domains.join(", ")}.`,
        success: null,
      };
    }
    if (!password || password.length < MIN_PASSWORD_LENGTH)
      return {
        error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
        success: null,
      };
    if (password !== confirm)
      return { error: "Password and confirmation do not match.", success: null };

    const session = await requireReadOnlySession();
    const actor = await requireAdmin(session);

    const supabase = createServiceClient();

    const { data: collision } = await supabase
      .from("users")
      .select("id")
      .eq("email", email)
      .maybeSingle();
    if (collision) {
      return {
        error: "An account with that email already exists.",
        success: null,
      };
    }

    // Insert, never upsert. `ensureUser` upserts on email because a sign-in
    // legitimately re-runs for someone who already exists; a create form doing
    // the same would silently rewrite a live account's name and password
    // instead of reporting the collision above.
    const { data: created, error } = await supabase
      .from("users")
      .insert({
        email,
        display_name: name,
        is_admin: makeAdmin,
        password_hash: await hashPassword(password),
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    await recordAdminAction(
      { id: actor.id, email: actor.email },
      {
        action: "user.create",
        targetType: "user",
        targetId: created.id,
        // The new account's address and whether it was made an admin. Never the
        // password — rule 1.
        details: { email, isAdmin: makeAdmin },
      },
    );

    revalidateUsers();
    return {
      error: null,
      success: `${name} can now sign in with ${email}.`,
    };
  } catch (err) {
    return {
      error: safeErrorMessage(err, "Failed to create this user."),
      success: null,
    };
  }
}

/**
 * Display name and email, in one submit.
 *
 * Together because they are one form and one save button. Split, an admin who
 * corrects a misspelt name and a stale address has to press Save twice and gets
 * two toasts, and a half-applied edit becomes representable.
 */
export async function adminUpdateProfile(
  _prev: AccountActionState,
  formData: FormData,
): Promise<AccountActionState> {
  try {
    const userId = String(formData.get("userId") ?? "");
    const name = String(formData.get("displayName") ?? "").trim();
    const email = String(formData.get("email") ?? "")
      .trim()
      .toLowerCase();

    if (!userId) return { error: "No user specified.", success: null };
    if (!name) return { error: "Display name cannot be empty.", success: null };
    if (name.length > MAX_DISPLAY_NAME_LENGTH)
      return { error: "Display name is too long.", success: null };
    if (!email) return { error: "Email is required.", success: null };
    if (!EMAIL_RE.test(email))
      return { error: "Enter a valid email address.", success: null };

    const { actor, target } = await resolveActorAndTarget(userId);
    if (!target) return { error: "User not found.", success: null };

    const supabase = createServiceClient();

    // `users.email` is unique, so a collision would surface as a constraint
    // violation anyway — but as a database error string, not as a sentence an
    // admin can act on. Checked first so the message names the actual problem.
    const emailChanged = email !== target.email;
    if (emailChanged) {
      const { data: collision } = await supabase
        .from("users")
        .select("id")
        .eq("email", email)
        .neq("id", userId)
        .maybeSingle();
      if (collision) {
        return {
          error: "That email is already in use by another account.",
          success: null,
        };
      }
    }

    const { error } = await supabase
      .from("users")
      .update({
        display_name: name,
        email,
        updated_at: new Date().toISOString(),
      })
      .eq("id", userId);
    if (error) throw new Error(error.message);

    /*
      Email is the login identifier — `authorize()` looks the account up by it —
      so changing it changes how this person signs in. The existing token would
      keep working (it carries the user id, not the address), which is exactly
      the confusing half-state to avoid: signed in as an address that no longer
      exists. Signing them out makes the next sign-in prove they know the new
      one.

      Not fatal. The edit is already committed, and an admin told the rename
      failed would only try it again.
    */
    let sessionsRevoked = false;
    if (emailChanged) {
      try {
        await revokeUserSessions(userId);
        sessionsRevoked = true;
      } catch (err) {
        console.error(
          `[admin] email changed for ${userId} but revocation failed:`,
          err,
        );
      }
    }

    await recordAdminAction(
      { id: actor.id, email: actor.email },
      {
        action: "user.profile.update",
        targetType: "user",
        targetId: userId,
        // The values are not secrets, but the previous address is the useful
        // half: "changed to x" is unreadable a month later without it.
        details: {
          displayNameChanged: name !== target.display_name,
          emailChanged,
          ...(emailChanged ? { previousEmail: target.email, email } : {}),
        },
      },
    );

    revalidateUsers();
    return {
      error: null,
      success: emailChanged
        ? sessionsRevoked
          ? "Profile updated. Signed this user out of every device."
          : "Profile updated, but their existing sessions could not be ended — sign them out manually."
        : "Profile updated.",
    };
  } catch (err) {
    return {
      error: safeErrorMessage(err, "Failed to update this user."),
      success: null,
    };
  }
}

/**
 * Set another user's password.
 *
 * The self-service flow proves intent with the account's own current password.
 * An admin cannot supply that — the whole point is that the account holder is
 * unreachable or locked out — so intent is proven with the ADMIN'S password
 * instead. That is the standard shape for credential takeover, and it is what
 * makes a borrowed unlocked laptop insufficient to seize another account.
 */
export async function adminSetPassword(
  _prev: AccountActionState,
  formData: FormData,
): Promise<AccountActionState> {
  try {
    const userId = String(formData.get("userId") ?? "");
    const next = String(formData.get("newPassword") ?? "");
    const confirm = String(formData.get("confirmPassword") ?? "");
    const actorPassword = String(formData.get("actorPassword") ?? "");

    if (!userId) return { error: "No user specified.", success: null };
    if (!next || next.length < MIN_PASSWORD_LENGTH)
      return {
        error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
        success: null,
      };
    if (next !== confirm)
      return {
        error: "New password and confirmation do not match.",
        success: null,
      };

    const { actor, target } = await resolveActorAndTarget(userId);
    if (!target) return { error: "User not found.", success: null };

    // Checked BEFORE the write, and before anything is hashed. An admin whose
    // own password is wrong must change nothing at all.
    if (!actor.password_hash) {
      return {
        error:
          "Your account has no password set, so it cannot be used to confirm this.",
        success: null,
      };
    }
    if (!actorPassword)
      return { error: "Enter your own password to confirm.", success: null };
    const actorOk = await verifyPassword(actorPassword, actor.password_hash);
    if (!actorOk)
      return { error: "Your password is incorrect.", success: null };

    const supabase = createServiceClient();
    const { error } = await supabase
      .from("users")
      .update({
        password_hash: await hashPassword(next),
        updated_at: new Date().toISOString(),
      })
      .eq("id", userId);
    if (error) throw new Error(error.message);

    // The credential every existing token was minted from is gone, so the
    // tokens go with it — and here more than anywhere: an admin resetting a
    // password is often doing it because somebody else may be holding a
    // session. Not fatal, for the same reason as above.
    let sessionsRevoked = false;
    try {
      await revokeUserSessions(userId);
      sessionsRevoked = true;
    } catch (err) {
      console.error(
        `[admin] password reset for ${userId} but revocation failed:`,
        err,
      );
    }

    await recordAdminAction(
      { id: actor.id, email: actor.email },
      {
        action: "user.password.set",
        targetType: "user",
        targetId: userId,
        // Rule 1: which fields were set, never their values.
        details: { sessionsRevoked },
      },
    );

    revalidateUsers();
    return {
      error: null,
      success: sessionsRevoked
        ? "Password set. Signed this user out of every device."
        : "Password set, but their existing sessions could not be ended — they may still be signed in elsewhere.",
    };
  } catch (err) {
    return {
      error: safeErrorMessage(err, "Failed to set this user's password."),
      success: null,
    };
  }
}

/**
 * Grant or remove the `is_admin` flag.
 *
 * Two guards, and neither is a UI concern:
 *
 *   - **Not yourself.** An admin who unticks their own box is locked out of the
 *     page that could put it back. The dialog disables the control, but the
 *     check has to be here — the disabled attribute is a courtesy to the mouse,
 *     not a constraint on the POST.
 *   - **Not the last one.** A deployment with zero admins has no way back
 *     except `npm run seed-admin` against the database.
 *
 * The count is read inside the action rather than passed in from the client for
 * the same reason: a number the caller supplies is a number the caller chooses.
 */
export async function adminSetIsAdmin(
  _prev: AccountActionState,
  formData: FormData,
): Promise<AccountActionState> {
  try {
    const userId = String(formData.get("userId") ?? "");
    const makeAdmin = formData.get("isAdmin") === "true";

    if (!userId) return { error: "No user specified.", success: null };

    const { actor, target } = await resolveActorAndTarget(userId);
    if (!target) return { error: "User not found.", success: null };

    if (userId === actor.id) {
      return {
        error: "You cannot change your own admin access.",
        success: null,
      };
    }

    if (target.is_admin === makeAdmin) {
      // Nothing to do — most likely two tabs open on the same user. Reported as
      // success so the UI settles on the truth rather than showing an error for
      // a state it already wanted.
      return {
        error: null,
        success: makeAdmin
          ? "This user is already an administrator."
          : "This user is already not an administrator.",
      };
    }

    const supabase = createServiceClient();

    if (!makeAdmin) {
      const { count, error: countErr } = await supabase
        .from("users")
        .select("id", { count: "exact", head: true })
        .eq("is_admin", true);
      if (countErr) throw new Error(countErr.message);
      if ((count ?? 0) <= 1) {
        return {
          error:
            "This is the only administrator. Promote someone else before removing admin access here.",
          success: null,
        };
      }
    }

    const { error } = await supabase
      .from("users")
      .update({ is_admin: makeAdmin, updated_at: new Date().toISOString() })
      .eq("id", userId);
    if (error) throw new Error(error.message);

    /*
      Belt and braces. `requireAdmin` re-reads `is_admin` from the row on every
      request, so a stale token cannot actually reach an admin route after this
      — but a demotion is a trust decision, and the cheap way to be sure is to
      stop honouring the tokens minted while it held. Only on the way DOWN:
      promoting somebody and then signing them out is a confusing reward.
    */
    let sessionsRevoked = false;
    if (!makeAdmin) {
      try {
        await revokeUserSessions(userId);
        sessionsRevoked = true;
      } catch (err) {
        console.error(
          `[admin] demoted ${userId} but revocation failed:`,
          err,
        );
      }
    }

    await recordAdminAction(
      { id: actor.id, email: actor.email },
      {
        action: makeAdmin ? "user.admin.grant" : "user.admin.revoke",
        targetType: "user",
        targetId: userId,
        details: { sessionsRevoked },
      },
    );

    revalidateUsers();
    return {
      error: null,
      success: makeAdmin
        ? `${target.display_name} is now an administrator.`
        : `${target.display_name} is no longer an administrator.`,
    };
  } catch (err) {
    return {
      error: safeErrorMessage(err, "Failed to change admin access."),
      success: null,
    };
  }
}

/**
 * The Activity tab's rows: everything done TO this user.
 *
 * Loaded on demand rather than with the page. The users page already fans out
 * four queries to build the table, and an audit read per user would multiply
 * that by the row count to fill a tab most opens never reach.
 */
export async function getUserActivity(
  userId: string,
): Promise<AdminAuditRow[]> {
  const session = await requireReadOnlySession();
  await requireAdmin(session);
  if (!userId) return [];
  return readAdminAuditLogForTarget("user", userId);
}
