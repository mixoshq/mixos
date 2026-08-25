/**
 * Server-side helpers for the public app surface: signing and verifying the
 * password-unlock cookie that authorizes access to password-protected pages
 * and API routes under `/p/<slug>/...` and `/api/p/<slug>/...`.
 *
 * The cookie is a simple HMAC-signed JSON token (not a full JWT — no library
 * dependency, no algorithm-confusion attack surface). It encodes the
 * unlocked app slug and an expiry timestamp. Two cookies are set per
 * unlock — one path-scoped to `/p/<slug>` (page route) and one to
 * `/api/p/<slug>` (API route) — so the cookie is only sent on requests
 * for the app that was unlocked, and never leaks to other apps.
 *
 * The signing key comes from `getUnlockSigningKey()` (APP_UNLOCK_SECRET, else
 * derived from CONNECTOR_ENCRYPTION_KEY). Kept separate from NextAuth's secret
 * so a NextAuth-secret rotation doesn't invalidate every unlock and vice versa.
 */

import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { getUnlockSigningKey } from "./unlock-secret";

const COOKIE_TTL_MS = 24 * 60 * 60 * 1000; // 24h, system-controlled, no refresh
const SLUG_RE = /^[a-z0-9_-]+$/;

/**
 * Browsers refuse to store cookies with the `__Secure-` name prefix or the
 * `Secure` attribute on plain-HTTP origins (including `http://localhost`).
 * In dev that means the unlock cookie would be silently dropped, breaking
 * the password flow. So we only apply the secure prefix/attribute in
 * production. Dev cookies still carry `HttpOnly` and `SameSite=Lax` — the
 * weakening here is HTTPS-only attributes, not the rest of the security.
 */
const IS_PROD = process.env.NODE_ENV === "production";
const NAME_PREFIX = IS_PROD ? "__Secure-" : "";

/**
 * Reject anything that isn't a valid app slug shape. Slugs are used to build
 * cookie names and cookie path strings; we don't want surprises if a caller
 * ever passes in something unsanitized.
 */
function assertSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new Error(`Invalid app slug: ${JSON.stringify(slug)}`);
  }
}

function getSecret(): Buffer {
  return getUnlockSigningKey();
}

function b64urlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecode(s: string): Buffer {
  // Restore padding so Buffer.from can decode strict base64.
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(
    s.replace(/-/g, "+").replace(/_/g, "/") + pad,
    "base64",
  );
}

interface UnlockPayload {
  /** Short field names because the token rides in a cookie. */
  s: string; // app slug
  iat: number; // issued at, epoch ms
  exp: number; // expiry, epoch ms
}

function signUnlockToken(appSlug: string): string {
  assertSlug(appSlug);
  const now = Date.now();
  const payload: UnlockPayload = {
    s: appSlug,
    iat: now,
    exp: now + COOKIE_TTL_MS,
  };
  const encoded = b64urlEncode(Buffer.from(JSON.stringify(payload), "utf-8"));
  const sig = createHmac("sha256", getSecret()).update(encoded).digest();
  return `${encoded}.${b64urlEncode(sig)}`;
}

/**
 * Verify the token's signature, parse the payload, and confirm it was issued
 * for `expectedSlug` and hasn't expired. Returns true only on every check
 * passing. Never throws — any malformation or mismatch is just `false`.
 */
function verifyUnlockToken(token: string, expectedSlug: string): boolean {
  if (typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return false;

  const encoded = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);

  let presented: Buffer;
  try {
    presented = b64urlDecode(sigPart);
  } catch {
    return false;
  }

  const expected = createHmac("sha256", getSecret()).update(encoded).digest();
  if (presented.length !== expected.length) return false;
  if (!timingSafeEqual(presented, expected)) return false;

  let payload: UnlockPayload;
  try {
    payload = JSON.parse(b64urlDecode(encoded).toString("utf-8")) as UnlockPayload;
  } catch {
    return false;
  }
  if (
    typeof payload.s !== "string" ||
    typeof payload.exp !== "number" ||
    payload.s !== expectedSlug ||
    payload.exp <= Date.now()
  ) {
    return false;
  }
  return true;
}

function cookieNameForPage(appSlug: string): string {
  assertSlug(appSlug);
  return `${NAME_PREFIX}mixapp-unlock-${appSlug}`;
}

function cookieNameForApi(appSlug: string): string {
  assertSlug(appSlug);
  return `${NAME_PREFIX}mixapp-unlock-${appSlug}-api`;
}

/**
 * Server-component / route-handler helper. Reads the path-scoped unlock
 * cookie and returns true only if its signature, slug, and expiry all
 * check out. The two cookies (page-scoped and api-scoped) carry the same
 * token — checking either is sufficient. The page route reads the page
 * cookie; the API route reads the api cookie. Whichever is present on the
 * incoming request will satisfy the gate.
 */
export async function isAppUnlocked(appSlug: string): Promise<boolean> {
  assertSlug(appSlug);
  // Wrap every step so a misconfigured environment (missing
  // APP_UNLOCK_SECRET, etc.) cannot crash the rendering page or API
  // handler. The visitor sees the gate again — fail-closed — and the
  // server log carries the actionable detail for the operator.
  try {
    const jar = await cookies();
    const pageCookie = jar.get(cookieNameForPage(appSlug))?.value;
    if (pageCookie && verifyUnlockToken(pageCookie, appSlug)) return true;
    const apiCookie = jar.get(cookieNameForApi(appSlug))?.value;
    if (apiCookie && verifyUnlockToken(apiCookie, appSlug)) return true;
    return false;
  } catch (err) {
    console.error(
      `[public-access] isAppUnlocked failed for app="${appSlug}":`,
      err,
    );
    return false;
  }
}

/**
 * Set both unlock cookies via Next.js' `cookies()` API. Called from the
 * unlock server action once a password attempt succeeds. Cookies are
 * `HttpOnly`, `SameSite=Lax`, path-scoped to the slug, and expire after
 * `COOKIE_TTL_MS` with no refresh. The `Secure` attribute (and matching
 * `__Secure-` name prefix) only applies in production — in dev on plain
 * HTTP localhost, the browser would refuse to store them otherwise.
 * Two cookies (one for the page surface, one for the API) so the browser
 * only sends the unlock on requests to the unlocked app, never to other apps.
 */
export async function setUnlockCookies(appSlug: string): Promise<void> {
  assertSlug(appSlug);
  const token = signUnlockToken(appSlug);
  const jar = await cookies();
  const maxAge = Math.floor(COOKIE_TTL_MS / 1000);
  jar.set({
    name: cookieNameForPage(appSlug),
    value: token,
    httpOnly: true,
    secure: IS_PROD,
    sameSite: "lax",
    path: `/p/${appSlug}`,
    maxAge,
  });
  jar.set({
    name: cookieNameForApi(appSlug),
    value: token,
    httpOnly: true,
    secure: IS_PROD,
    sameSite: "lax",
    path: `/api/p/${appSlug}`,
    maxAge,
  });
}

/**
 * Clear both unlock cookies. Used when an admin rotates or removes the app
 * password and every visitor must re-enter it.
 */
export async function clearUnlockCookies(appSlug: string): Promise<void> {
  assertSlug(appSlug);
  const jar = await cookies();
  jar.set({
    name: cookieNameForPage(appSlug),
    value: "",
    path: `/p/${appSlug}`,
    httpOnly: true,
    secure: IS_PROD,
    sameSite: "lax",
    maxAge: 0,
  });
  jar.set({
    name: cookieNameForApi(appSlug),
    value: "",
    path: `/api/p/${appSlug}`,
    httpOnly: true,
    secure: IS_PROD,
    sameSite: "lax",
    maxAge: 0,
  });
}

/**
 * Returns the originating client IP from a NextRequest. Uses the
 * RIGHTMOST `x-forwarded-for` entry (the one appended by our own reverse
 * proxy, harder to spoof than the leftmost). Falls back to `x-real-ip`
 * and finally to a literal `"unknown"` sentinel. Mirrors the same logic
 * already used in [src/app/api/apps/[...slug]/route.ts].
 */
export function getClientIp(req: { headers: { get(name: string): string | null } }): string {
  const forwardedFor = req.headers.get("x-forwarded-for");
  const forwardedIps = forwardedFor
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return forwardedIps?.at(-1) || req.headers.get("x-real-ip") || "unknown";
}
