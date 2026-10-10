/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use server";

// Server action invoked by the password gate form. Next.js gives server
// actions same-origin CSRF protection automatically (it validates the
// `Origin`/`Host` headers and the action signature), so we don't need to
// thread NextAuth's CSRF token through here — the visitor isn't logged in
// and has no NextAuth session anyway.

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { appRegistry } from "@/generated/app-registry";
import { isAppActive } from "@/lib/apps/access";
import {
  hasAppPassword,
  verifyAppPassword,
} from "@/lib/apps/app-password-store";
import { getClientIp, setUnlockCookies } from "@/lib/apps/public-access";
import {
  checkUnlockAttempt,
  clearUnlockFailures,
  recordUnlockFailure,
} from "@/lib/apps/unlock-rate-limit";

export interface UnlockState {
  /** User-facing error message, or null on no-error / success-and-redirected. */
  error: string | null;
}

const SLUG_RE = /^[a-z0-9_-]+$/;

/**
 * Validate a return-to URL. We only allow same-origin paths under
 * `/p/<appSlug>/...` — never an absolute URL, never another app. This
 * stops a malicious link from using a successful unlock as an open
 * redirect to another origin or app.
 */
function safeReturnTo(raw: string | null, appSlug: string): string {
  const fallback = `/p/${appSlug}`;
  if (!raw || typeof raw !== "string") return fallback;
  if (!raw.startsWith(`/p/${appSlug}`)) return fallback;
  // Block protocol-relative (`//evil`) and any whitespace tricks.
  if (raw.startsWith("//") || /[\s\r\n]/.test(raw)) return fallback;
  return raw;
}

export async function unlockApp(
  _previous: UnlockState,
  formData: FormData,
): Promise<UnlockState> {
  const appSlug = String(formData.get("appSlug") ?? "");
  const password = String(formData.get("password") ?? "");
  const returnTo = safeReturnTo(
    String(formData.get("returnTo") ?? ""),
    appSlug,
  );

  if (!SLUG_RE.test(appSlug)) {
    return { error: "Invalid request." };
  }

  // A deactivated app answers as one that does not exist: no password check,
  // and no cookie that would be waiting for it if it were switched back on.
  const manifest = appRegistry.find((a) => a.slug === appSlug);
  if (!manifest || !(await isAppActive(appSlug))) {
    return { error: "Invalid request." };
  }

  if (!password) {
    return { error: "Password is required." };
  }

  const hdrs = await headers();
  const ip = getClientIp({ headers: hdrs });

  // 1. Brute-force gate. Check BEFORE bcrypt so a locked-out attacker
  //    cannot extract timing signal or pin CPU on bcrypt rounds.
  const gate = await checkUnlockAttempt(ip, appSlug);
  if (!gate.allowed) {
    const minutes = Math.ceil(gate.retryAfterMs / 60_000);
    return {
      error: `Too many failed attempts. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    };
  }

  // 2. Misconfiguration check: manifest declares a password-protected page
  //    but the installer never set one. Fail closed; do not allow access.
  //    The visitor sees a generic error so we don't leak the configuration
  //    state precisely; the server log carries the actionable detail.
  if (!(await hasAppPassword(appSlug))) {
    console.error(
      `[unlock] app="${appSlug}" is password-protected per manifest but no app_passwords row exists — installer must set a password before public access works`,
    );
    return { error: "This app is not available." };
  }

  // 3. Constant-time bcrypt compare. `verifyAppPassword` already returns
  //    false on missing row; the prior check is for clear messaging.
  const ok = await verifyAppPassword(appSlug, password);
  if (!ok) {
    await recordUnlockFailure(ip, appSlug);
    return { error: "Incorrect password." };
  }

  // 4. Success — clear the failure counter, set the cookies, redirect.
  //    `setUnlockCookies` reads APP_UNLOCK_SECRET; if the operator forgot
  //    to set it (or set it too short), it throws. Catch that explicitly
  //    so the visitor sees a clean configuration error instead of a
  //    raw server crash. `redirect()` MUST be outside the try/catch —
  //    it works by throwing NEXT_REDIRECT, which the runtime expects to
  //    propagate up.
  await clearUnlockFailures(ip, appSlug);
  try {
    await setUnlockCookies(appSlug);
  } catch (err) {
    console.error(
      `[unlock] failed to set unlock cookies for app="${appSlug}":`,
      err,
    );
    return {
      error:
        "This app isn't configured for unlocking. Contact an administrator.",
    };
  }
  redirect(returnTo);
}
