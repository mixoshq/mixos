/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use server";

import { AuthError } from "next-auth";
import { signIn } from "@/lib/auth";
import { createRateLimiter } from "@/lib/rate-limit";
import { headers } from "next/headers";

const credentialsRateLimit = createRateLimiter({
  scope: "ip",
  name: "login-credentials",
  maxTokens: 10,
  refillRatePerSecond: 0.1,
});

async function rateLimitKey(): Promise<string> {
  const h = await headers();
  const forwardedFor = h.get("x-forwarded-for");
  const ips = forwardedFor
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ips?.at(-1) || h.get("x-real-ip") || "unknown";
}

export interface CredentialsSignInState {
  error: string | null;
  /**
   * Counts submissions. The same error twice in a row is the same state
   * object to React, so without this the card could not tell a second
   * failure from the first and would shake only once.
   */
  attempt: number;
  /** What was typed, so a failed attempt does not also empty the field. */
  email: string;
}

export async function signInWithCredentials(
  _prev: CredentialsSignInState,
  formData: FormData,
): Promise<CredentialsSignInState> {
  const attempt = _prev.attempt + 1;
  const email = String(formData.get("email") ?? "").trim();
  const key = await rateLimitKey();
  const rl = await credentialsRateLimit.consume(key);
  if (!rl.allowed) {
    return {
      error: "Too many sign-in attempts. Please try again shortly.",
      attempt,
      email,
    };
  }

  const password = String(formData.get("password") ?? "");
  if (!email || !password) {
    return { error: "Email and password are required.", attempt, email };
  }

  try {
    await signIn("credentials", {
      email,
      password,
      redirectTo: "/",
    });
    return { error: null, attempt, email };
  } catch (err) {
    // Next.js uses a thrown NEXT_REDIRECT to implement redirects from
    // server actions; re-throw so it propagates to the framework.
    if (
      err &&
      typeof err === "object" &&
      "digest" in err &&
      typeof (err as { digest?: unknown }).digest === "string" &&
      (err as { digest: string }).digest.startsWith("NEXT_REDIRECT")
    ) {
      throw err;
    }
    if (err instanceof AuthError) {
      return { error: "Invalid email or password.", attempt, email };
    }
    return { error: "Something went wrong. Please try again.", attempt, email };
  }
}
