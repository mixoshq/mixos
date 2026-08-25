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
  const ips = forwardedFor?.split(",").map((s) => s.trim()).filter(Boolean);
  return ips?.at(-1) || h.get("x-real-ip") || "unknown";
}

export interface CredentialsSignInState {
  error: string | null;
}

export async function signInWithCredentials(
  _prev: CredentialsSignInState,
  formData: FormData
): Promise<CredentialsSignInState> {
  const key = await rateLimitKey();
  const rl = await credentialsRateLimit.consume(key);
  if (!rl.allowed) {
    return { error: "Too many sign-in attempts. Please try again shortly." };
  }

  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) {
    return { error: "Email and password are required." };
  }

  try {
    await signIn("credentials", {
      email,
      password,
      redirectTo: "/",
    });
    return { error: null };
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
      return { error: "Invalid email or password." };
    }
    return { error: "Something went wrong. Please try again." };
  }
}
