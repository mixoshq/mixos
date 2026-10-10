/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { NextAuthConfig, Session, User } from "next-auth";
import type { JWT } from "next-auth/jwt";
import Credentials from "next-auth/providers/credentials";
import { createServiceClient } from "@/lib/db/server";
import { verifyPassword } from "./password";
import { chargeSignInAttempt } from "./sign-in-limit";

const ALLOWED_DOMAINS = process.env.ALLOWED_EMAIL_DOMAINS
  ? process.env.ALLOWED_EMAIL_DOMAINS.split(",").map((d) =>
      d.trim().toLowerCase(),
    )
  : null;

function emailAllowed(email: string): boolean {
  if (!ALLOWED_DOMAINS) return true;
  const domain = email.split("@")[1]?.toLowerCase();
  return !!domain && ALLOWED_DOMAINS.includes(domain);
}

/** The account a password is checked against. */
export interface CredentialsAccount {
  id: string;
  email: string;
  display_name: string | null;
  password_hash: string | null;
}

/**
 * What the password check reads and calls. Swappable so a test can run it
 * without a database and count what it did.
 */
export interface CredentialsCheck {
  findAccount(email: string): Promise<CredentialsAccount | null>;
  verifyPassword(plaintext: string, hash: string): Promise<boolean>;
}

const DATABASE_CHECK: CredentialsCheck = {
  async findAccount(email) {
    const supabase = createServiceClient();
    const { data } = await supabase
      .from("users")
      .select("id, email, display_name, password_hash, is_admin")
      .eq("email", email)
      .maybeSingle();
    return (data as CredentialsAccount | null) ?? null;
  },
  verifyPassword,
};

/**
 * The credentials provider's `authorize()`, the one password check. Every
 * route into it charges the same per-IP sign-in limit, and charges it first:
 * a refused attempt reads no account and runs no hash (./sign-in-limit.ts).
 */
export function createCredentialsAuthorize(
  check: CredentialsCheck = DATABASE_CHECK,
) {
  return async function authorize(
    raw: Partial<Record<string, unknown>>,
    request?: Request,
  ): Promise<User | null> {
    await chargeSignInAttempt(request);

    const email =
      typeof raw?.email === "string" ? raw.email.trim().toLowerCase() : "";
    const password = typeof raw?.password === "string" ? raw.password : "";
    if (!email || !password) return null;
    if (!emailAllowed(email)) return null;

    const user = await check.findAccount(email);
    if (!user?.password_hash) return null;
    const ok = await check.verifyPassword(password, user.password_hash);
    if (!ok) return null;

    return {
      id: user.id,
      email: user.email,
      name: user.display_name ?? user.email,
    };
  };
}

const credentialsProvider = Credentials({
  id: "credentials",
  name: "Email and password",
  credentials: {
    email: { label: "Email", type: "email" },
    password: { label: "Password", type: "password" },
  },
  authorize: createCredentialsAuthorize(),
});

/**
 * Async because Auth.js expects a config factory and every call site awaits it,
 * not because anything here needs I/O. Email and password is the only way in.
 */
export async function buildAuthOptions(): Promise<NextAuthConfig> {
  // Cookies are left at Auth.js defaults: SameSite=Lax, Secure on HTTPS, and
  // the `__Secure-` name prefix applied automatically there. Nothing embeds
  // MixOS from another origin, so Lax is the stricter, correct default.
  // src/proxy.ts already recognises both the plain and `__Secure-` cookie names.
  return {
    session: { strategy: "jwt" },
    trustHost: true,
    pages: { signIn: "/login" },
    providers: [credentialsProvider],
    callbacks: {
      /*
       * Runs on EVERY session resolution, not only at sign-in.
       *
       * It used to re-read the user row only on sign-in or an explicit
       * `update`, which meant the token was trusted for its whole lifetime.
       * Two things were wrong with that, and the second is the serious one:
       *
       *   · `isAdmin` went stale. A demotion kept working until the token
       *     expired. `requireAdmin()` compensates by re-reading the row itself,
       *     but anything reading `session.user.isAdmin` did not.
       *   · There was NO WAY TO REVOKE A SESSION. With `strategy: "jwt"` there
       *     is no session row to delete, so an offboarded user's token stayed
       *     valid until expiry and the only lever was rotating AUTH_SECRET,
       *     which signs everybody out.
       *
       * `session_version` fixes the second: it is minted into the token and
       * compared here. Returning `null` invalidates the session — Auth.js
       * treats a null token as "no session", so the user lands on /login.
       *
       * THE COST, stated plainly: one indexed read per session resolution where
       * there was none. The dispatcher already reads the same row via
       * `getUserById` on identity tiers, so an authenticated API call now reads
       * it twice; that is worth merging later, but correctness first.
       *
       * FAILS CLOSED on a missing row — a deleted user's token stops working.
       * It fails OPEN on a query error, deliberately: a database blip must not
       * sign out every user of the platform, and the row is re-checked on the
       * very next request anyway.
       */
      async jwt({ token, user }) {
        if (user?.id) token.sub = user.id;
        if (!token.sub) return token;

        const t = token as JWT & { isAdmin?: boolean; sessionVersion?: number };

        try {
          const supabase = createServiceClient();
          const { data, error } = await supabase
            .from("users")
            .select("email, display_name, is_admin, session_version")
            .eq("id", token.sub)
            .maybeSingle();

          if (error) {
            /*
             * Transient — see FAILS OPEN above. Logged because this branch is
             * indistinguishable from a schema mismatch, which is not transient
             * at all: an unapplied migration makes the select fail forever, and
             * every user silently resolves to non-admin because `isAdmin` below
             * is never reached. Returning quietly cost real debugging time once.
             */
            console.warn(
              "[auth] user row read failed, allowing request:",
              error,
            );
            return token;
          }
          if (!data) return null; // user deleted

          const current = Number(data.session_version ?? 0);

          if (user) {
            // Sign-in: stamp the version this token is bound to.
            t.sessionVersion = current;
          } else if ((t.sessionVersion ?? 0) !== current) {
            // Minted before a revocation. This is the whole point.
            return null;
          }

          t.email = data.email as string;
          t.name = (data.display_name as string) ?? t.name;
          t.isAdmin = !!data.is_admin;
        } catch (err) {
          console.warn(
            "[auth] session check failed, allowing this request:",
            err,
          );
        }

        return token;
      },
      async session({ session, token }) {
        const s = session as Session & {
          user: { id: string; isAdmin: boolean; email: string; name: string };
        };
        s.user.id = (token.sub as string) ?? s.user.id;
        s.user.email = (token.email as string) ?? s.user.email;
        s.user.name = (token.name as string) ?? s.user.name;
        s.user.isAdmin =
          (token as JWT & { isAdmin?: boolean }).isAdmin === true;
        return s;
      },
    },
  };
}
