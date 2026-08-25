/**
 * Data-layer helpers for `public.app_passwords` — the single shared password
 * an installer sets per app. Absence of a row for an app means "no password
 * set", which the public page route must treat as fail-closed (do not allow
 * access; surface a misconfiguration error to the operator instead).
 */

import bcrypt from "bcryptjs";
import { createServiceClient } from "@/lib/db/server";

const BCRYPT_ROUNDS = 12;

interface AppPasswordRow {
  app_slug: string;
  password_hash: string;
  set_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * True when an `app_passwords` row exists for this app — used by the public
 * page handler to decide whether to render the unlock form (password is set)
 * or surface a "misconfigured" error (declared as password-protected but the
 * installer never finished setup).
 */
export async function hasAppPassword(appSlug: string): Promise<boolean> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("app_passwords")
    .select("app_slug")
    .eq("app_slug", appSlug)
    .maybeSingle();
  return !!data;
}

/**
 * Constant-time bcrypt comparison against the stored hash. Returns false if
 * no row exists for the app — i.e. callers cannot distinguish "wrong
 * password" from "no password set" via timing or response. Callers that
 * need to distinguish should call `hasAppPassword` separately.
 */
export async function verifyAppPassword(
  appSlug: string,
  plaintext: string,
): Promise<boolean> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("app_passwords")
    .select("password_hash")
    .eq("app_slug", appSlug)
    .maybeSingle();
  const row = data as { password_hash: string } | null;
  if (!row) return false;
  return bcrypt.compare(plaintext, row.password_hash);
}

export async function setAppPassword(args: {
  appSlug: string;
  plaintext: string;
  setByUserId: string;
}): Promise<void> {
  if (args.plaintext.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  const hash = await bcrypt.hash(args.plaintext, BCRYPT_ROUNDS);
  const supabase = createServiceClient();
  const now = new Date().toISOString();
  const { error } = await supabase.from("app_passwords").upsert(
    {
      app_slug: args.appSlug,
      password_hash: hash,
      set_by_user_id: args.setByUserId,
      updated_at: now,
    },
    { onConflict: "app_slug" },
  );
  if (error) throw new Error(`Failed to set app password: ${error.message}`);
}

export async function clearAppPassword(appSlug: string): Promise<void> {
  const supabase = createServiceClient();
  const { error } = await supabase
    .from("app_passwords")
    .delete()
    .eq("app_slug", appSlug);
  if (error) throw new Error(`Failed to clear app password: ${error.message}`);
}

/** Admin/audit metadata — returns the row without the hash. */
export async function getAppPasswordMetadata(
  appSlug: string,
): Promise<Omit<AppPasswordRow, "password_hash"> | null> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("app_passwords")
    .select("app_slug, set_by_user_id, created_at, updated_at")
    .eq("app_slug", appSlug)
    .maybeSingle();
  return (data as Omit<AppPasswordRow, "password_hash"> | null) ?? null;
}
