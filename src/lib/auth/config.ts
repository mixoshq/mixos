import type { NextAuthConfig, Session } from "next-auth";
import type { Provider } from "next-auth/providers";
import type { JWT } from "next-auth/jwt";
import Credentials from "next-auth/providers/credentials";
import { createServiceClient } from "@/lib/db/server";
import { verifyPassword } from "./password";
import { getAuthConfig } from "./auth-config-store";

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

async function buildProviders(): Promise<Provider[]> {
  const providers: Provider[] = [credentialsProvider];

  const cfg = await getAuthConfig();
  if (
    cfg.ssoEnabled &&
    cfg.oidcIssuerUrl &&
    cfg.oidcClientId &&
    cfg.oidcClientSecret
  ) {
    providers.push({
      id: "oidc",
      name: "Single Sign-On",
      type: "oidc",
      issuer: cfg.oidcIssuerUrl,
      clientId: cfg.oidcClientId,
      clientSecret: cfg.oidcClientSecret,
      authorization: { params: { scope: "openid email profile" } },
      checks: ["pkce", "state"],
    } as unknown as Provider);
  }

  return providers;
}

/**
 * Given a raw OIDC claim value (which may be a string, an array of strings, a
 * space-delimited string, or absent), return a normalized lowercase array.
 */
function normalizeClaimValues(raw: unknown): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim().toLowerCase())
      .filter((v) => v.length > 0);
  }
  if (typeof raw === "string") {
    // Some providers emit space-delimited scopes/roles in a single string.
    return raw
      .split(/[\s,]+/)
      .map((v) => v.trim().toLowerCase())
      .filter((v) => v.length > 0);
  }
  return [];
}

/**
 * Decide whether an OIDC profile grants admin based on the configured claim
 * mapping. Returns null when the mapping is not configured — caller should
 * preserve the existing is_admin state in that case.
 */
function computeSsoAdmin(
  profile: Record<string, unknown> | undefined,
  adminClaimName: string | null,
  adminClaimValues: string[]
): boolean | null {
  if (!adminClaimName || adminClaimValues.length === 0) return null;
  if (!profile) return false;
  const claimValues = normalizeClaimValues(profile[adminClaimName]);
  const adminSet = new Set(
    adminClaimValues.map((v) => v.trim().toLowerCase()).filter(Boolean)
  );
  return claimValues.some((v) => adminSet.has(v));
}

export async function buildAuthOptions(): Promise<NextAuthConfig> {
  const providers = await buildProviders();
  const cfg = await getAuthConfig();

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
    providers,
    callbacks: {
      async signIn({ user, account, profile }) {
        if (account?.provider === "oidc") {
          const email = (user.email ?? "").trim().toLowerCase();
          if (!email) return false;
          if (!emailAllowed(email)) return false;

          const ssoAdmin = computeSsoAdmin(
            profile as Record<string, unknown> | undefined,
            cfg.adminClaimName,
            cfg.adminClaimValues
          );

          const supabase = createServiceClient();
          const { data: existing } = await supabase
            .from("users")
            .select("id")
            .eq("email", email)
            .maybeSingle();

          if (existing) {
            user.id = existing.id as string;
            // Sync admin flag from claims on every login when mapping is set.
            // When mapping is not configured (ssoAdmin === null), leave the
            // DB-managed is_admin flag alone.
            if (ssoAdmin !== null) {
              await supabase
                .from("users")
                .update({ is_admin: ssoAdmin })
                .eq("id", existing.id as string);
            }
            return true;
          }

          const { data: created, error } = await supabase
            .from("users")
            .insert({
              email,
              display_name: user.name ?? email,
              is_admin: ssoAdmin === true,
            })
            .select("id")
            .single();
          if (error || !created) return false;
          user.id = created.id as string;
          return true;
        }
        return true;
      },
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
