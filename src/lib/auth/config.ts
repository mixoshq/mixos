/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { NextAuthConfig, Session } from "next-auth";
import type { JWT } from "next-auth/jwt";
import Credentials from "next-auth/providers/credentials";
import { createServiceClient } from "@/lib/db/server";
import { verifyPassword } from "./password";

const ALLOWED_DOMAINS = process.env.ALLOWED_EMAIL_DOMAINS
  ? process.env.ALLOWED_EMAIL_DOMAINS.split(",").map((d) =>
      d.trim().toLowerCase()
    )
  : null;

function emailAllowed(email: string): boolean {
  if (!ALLOWED_DOMAINS) return true;
  const domain = email.split("@")[1]?.toLowerCase();
  return !!domain && ALLOWED_DOMAINS.includes(domain);
}

const credentialsProvider = Credentials({
  id: "credentials",
  name: "Email and password",
  credentials: {
    email: { label: "Email", type: "email" },
    password: { label: "Password", type: "password" },
  },
  async authorize(raw) {
    const email =
      typeof raw?.email === "string" ? raw.email.trim().toLowerCase() : "";
    const password = typeof raw?.password === "string" ? raw.password : "";
    if (!email || !password) return null;
    if (!emailAllowed(email)) return null;

    const supabase = createServiceClient();
    const { data: user } = await supabase
      .from("users")
      .select("id, email, display_name, password_hash, is_admin")
      .eq("email", email)
      .maybeSingle();

    if (!user?.password_hash) return null;
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) return null;

    return {
      id: user.id as string,
      email: user.email as string,
      name: (user.display_name as string) ?? user.email,
    };
  },
});

/**
 * Async because Auth.js expects a config factory and every call site awaits it,
 * not because anything here needs I/O. Email and password is the only way in.
 */
export async function buildAuthOptions(): Promise<NextAuthConfig> {
  // Cookies are left at Auth.js defaults: SameSite=Lax, Secure on HTTPS, and
  // the `__Secure-` name prefix applied automatically there. They used to be
  // forced to SameSite=None + Partitioned (CHIPS) so the app could be iframed
  // by a Chrome new-tab extension; that extension is gone, and Lax is the
  // stricter, correct default with no third-party embedder. src/proxy.ts
  // already recognises both the plain and `__Secure-` cookie names.
  return {
    session: { strategy: "jwt" },
    trustHost: true,
    pages: { signIn: "/login" },
    providers: [credentialsProvider],
    callbacks: {
      async jwt({ token, user, trigger }) {
        if (user?.id) token.sub = user.id;

        if (user || trigger === "update") {
          if (token.sub) {
            const supabase = createServiceClient();
            const { data } = await supabase
              .from("users")
              .select("email, display_name, is_admin")
              .eq("id", token.sub)
              .maybeSingle();
            if (data) {
              token.email = data.email as string;
              token.name = (data.display_name as string) ?? token.name;
              (token as JWT & { isAdmin?: boolean }).isAdmin = !!data.is_admin;
            }
          }
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
