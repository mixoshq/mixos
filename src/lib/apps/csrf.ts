/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Double-submit CSRF verification for cookie-authenticated app API calls.
 *
 * `src/lib/apps/sdk.ts` has always attached `X-CSRF-Token` to every mutating
 * request and retried once on a 403. Nothing read it. A control that reads as
 * enforced and is not is worse than an absent one — the same argument
 * `src/lib/rate-limit.ts` makes about the in-memory limiter it replaced — so
 * this is the server half.
 *
 * `SameSite=Lax` on the session cookie remains the primary defence, and this is
 * defence in depth behind it. Lax is a browser-enforced control: it does nothing
 * on a browser that doesn't implement it, and its edges (top-level navigations
 * are exempt, which is why a mutating `GET` handler is still reachable
 * cross-site) are not obvious to app authors. A token the attacker's origin
 * cannot read closes what's left.
 *
 * WHAT AUTH.JS ISSUES. `/api/auth/csrf` returns `{ csrfToken }` and sets the
 * cookie `authjs.csrf-token` (`__Host-` prefixed over HTTPS) to
 * `"<token>|<sha256(token + AUTH_SECRET)>"`. The hash is what proves the pair
 * was minted by this server rather than planted by an attacker who can write
 * cookies — checking only that header and cookie agree would accept an
 * attacker-chosen value for both. Verify the hash first, then the header
 * against the token.
 *
 * WHERE THIS IS NOT APPLIED, deliberately:
 *   · the public mount. Its callers are anonymous visitors and API keys, which
 *     carry no ambient cookie for an attacker to ride. Requiring a token there
 *     would break every integration for no gain.
 *   · non-identity tiers. Same reason: no cookie, nothing to forge.
 *   · `callAppRoute` (src/lib/apps/call.ts). It never reaches the dispatcher; it
 *     builds a synthetic Request with no headers and calls `runRouteData`
 *     directly. Putting this check inside `runRoute` would break every server
 *     component that calls its own route.
 */

/** Both spellings — Auth.js `__Host-` prefixes this cookie over HTTPS. */
const COOKIE_NAMES = ["__Host-authjs.csrf-token", "authjs.csrf-token"] as const;

export const CSRF_HEADER = "x-csrf-token";

/** Methods that a cross-site form or `fetch` could be used to trigger. */
export function needsCsrf(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function readCookie(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return null;
}

/** Length-safe constant-time compare — timingSafeEqual throws on a mismatch. */
function sameValue(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * True when the request carries a header matching a server-issued CSRF cookie.
 *
 * Fails CLOSED on anything unexpected — no header, no cookie, malformed cookie,
 * or an unset `AUTH_SECRET`. An unset secret means the session cookies this
 * would protect cannot be verified either, so there is nothing to preserve by
 * being lenient.
 */
export function verifyCsrf(request: Request): boolean {
  const presented = request.headers.get(CSRF_HEADER);
  if (!presented) return false;

  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return false;

  let raw: string | null = null;
  for (const name of COOKIE_NAMES) {
    raw = readCookie(cookieHeader, name);
    if (raw) break;
  }
  if (!raw) return false;

  const [token, hash] = decodeURIComponent(raw).split("|");
  if (!token || !hash) return false;

  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    console.error("[csrf] AUTH_SECRET is unset — refusing the request");
    return false;
  }

  // 1. The cookie is one we minted. Without this, an attacker who can set a
  //    cookie chooses both halves and the double-submit proves nothing.
  const expected = createHash("sha256").update(`${token}${secret}`).digest("hex");
  if (!sameValue(hash, expected)) return false;

  // 2. The header matches it. This is the half the attacker's origin cannot
  //    read, and therefore cannot reproduce.
  return sameValue(presented, token);
}
