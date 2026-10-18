/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The canonical public origin of this deployment, e.g. `https://mos.example.com`.
 * No trailing slash.
 *
 * SECURITY: this is resolved from the environment ONLY — never from the
 * request's `Host` / `X-Forwarded-Host` header. Those are client-supplied, and
 * this value is what OAuth redirect URIs, the MCP resource identifier, and the
 * RFC 8414 / RFC 9728 discovery documents are all built from. Deriving it from
 * a header would let an attacker inject a host and steer a redirect.
 *
 * Throws when nothing is configured rather than guessing. Callers that can
 * degrade (e.g. the /account/mcp page showing an example URL in local dev)
 * catch it; callers that cannot must not paper over a misconfiguration.
 */
export function getAppOrigin(): string {
  // 1. Explicit override always wins. This is the value to set in production.
  const explicit = process.env.NEXTAUTH_URL;
  if (explicit) return normalize(explicit);

  // 2. On Vercel, fall back to the platform's own (server-side, non-spoofable)
  //    deployment URLs. Production uses the stable project domain; preview and
  //    development builds use the per-deployment URL so an OAuth round trip on
  //    a preview returns to that same preview rather than to production.
  const vercel =
    process.env.VERCEL_ENV === "production"
      ? (process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL)
      : process.env.VERCEL_URL;
  if (vercel) return normalize(vercel);

  // 3. The same idea on the other hosts with a one-click deploy (docs/hosting/):
  //    each sets its service's own public URL in the environment. Render's
  //    carries a scheme; Railway's is a bare hostname, and exists only once the
  //    service has a domain. A custom domain on either needs NEXTAUTH_URL —
  //    these name the platform's default domain.
  const platform = process.env.RENDER_EXTERNAL_URL ?? process.env.RAILWAY_PUBLIC_DOMAIN;
  if (platform) return normalize(platform);

  throw new Error(
    "Cannot resolve the application origin. Set NEXTAUTH_URL to the full " +
      "public URL of this deployment (e.g. https://mos.example.com).",
  );
}

function normalize(value: string): string {
  // VERCEL_URL is a bare hostname with no scheme; NEXTAUTH_URL carries one.
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return withScheme.replace(/\/+$/, "");
}
