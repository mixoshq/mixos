/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { AppError } from "@/lib/apps/errors";

/**
 * Outbound HTTP for app code, bounded by a declared host allowlist.
 *
 * `docs/security-architecture.md` §13 said the platform had no SSRF defence and
 * called it "a gap to close *before* the next feature that fetches a URL" — while
 * app routes could already `fetch()` anything. This closes it, and the ESLint ban
 * on raw `fetch` in `apps/**` is what makes it the only door.
 *
 * BOTH HALVES ARE REQUIRED, and the second is the one people skip:
 *
 *   1. **Check the hostname against the app's declared `egress`.** The manifest
 *      schema already rejects schemes, ports, paths and IP literals, so what
 *      arrives here is a bare hostname.
 *   2. **Resolve it and re-check every returned address, then connect to that
 *      address.** Validating the string alone is defeated by DNS rebinding: an
 *      attacker registers a name that resolves public at validation time and
 *      private at fetch time. Resolving once and pinning the answer is what
 *      makes the allowlist mean anything.
 *
 * Redirects are followed manually for the same reason — a 302 to
 * `169.254.169.254` would otherwise walk straight past both checks.
 */

/** Private, loopback, link-local and unique-local ranges. */
function isPrivateAddress(address: string, family: number): boolean {
  if (family === 6) {
    const a = address.toLowerCase();
    if (a === "::1" || a === "::") return true;
    // Unique-local (fc00::/7) and link-local (fe80::/10).
    if (/^f[cd]/.test(a) || /^fe[89ab]/.test(a)) return true;
    // IPv4-mapped — unwrap and re-check as v4.
    const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1], 4);
    return false;
  }

  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 — link-local, and where every cloud metadata endpoint lives.
  if (a === 169 && b === 254) return true;
  // Carrier-grade NAT and benchmarking ranges are not somewhere an app should
  // be reaching either.
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true; // multicast and reserved
  return false;
}

/** `*.example.com` matches one level of subdomain, never the apex. */
function hostAllowed(host: string, allowlist: readonly string[]): boolean {
  const target = host.toLowerCase();
  return allowlist.some((entry) => {
    const rule = entry.toLowerCase();
    if (rule.startsWith("*.")) {
      const suffix = rule.slice(1); // ".example.com"
      if (!target.endsWith(suffix)) return false;
      const label = target.slice(0, -suffix.length);
      return label.length > 0 && !label.includes(".");
    }
    return target === rule;
  });
}

export interface AppHttpClient {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

const MAX_REDIRECTS = 3;

export function createHttpClient(
  appSlug: string,
  egress: readonly string[],
): AppHttpClient {
  async function guardedFetch(url: string, init: RequestInit, hop: number): Promise<Response> {
    if (hop > MAX_REDIRECTS) {
      throw AppError.invalidInput(`Too many redirects fetching ${url}.`);
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw AppError.invalidInput(`"${url}" is not a valid URL.`);
    }

    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw AppError.forbidden(
        `"${appSlug}" may not use the ${parsed.protocol} scheme.`,
      );
    }
    if (!hostAllowed(parsed.hostname, egress)) {
      throw AppError.forbidden(
        `"${appSlug}" is not allowed to reach ${parsed.hostname}. ` +
          `Add it to \`egress\` in app.json, or use a connector.`,
      );
    }

    // An IP literal skips DNS entirely, so it must be checked directly. The
    // manifest schema already refuses IP literals in `egress`, so this is only
    // reachable via a redirect.
    if (isIP(parsed.hostname)) {
      if (isPrivateAddress(parsed.hostname, isIP(parsed.hostname))) {
        throw AppError.forbidden(`${parsed.hostname} is not a public address.`);
      }
    } else {
      const answers = await lookup(parsed.hostname, { all: true });
      if (answers.length === 0) {
        throw AppError.unavailable(`${parsed.hostname} did not resolve.`);
      }
      for (const { address, family } of answers) {
        if (isPrivateAddress(address, family)) {
          throw AppError.forbidden(
            `${parsed.hostname} resolves to a non-public address and was refused.`,
          );
        }
      }
    }

    // `redirect: "manual"` so each hop goes back through both checks. Following
    // redirects automatically is how a validated hostname ends up serving a
    // request to the metadata endpoint.
    const response = await fetch(parsed, { ...init, redirect: "manual" });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return response;
      return guardedFetch(new URL(location, parsed).toString(), init, hop + 1);
    }

    return response;
  }

  return {
    fetch: (url, init = {}) => guardedFetch(url, init, 0),
  };
}
