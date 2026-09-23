/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { NextResponse, type NextRequest } from "next/server";
import { createRateLimiter } from "@/lib/rate-limit";
import { isAcceptableRedirectUri } from "@/lib/mcp/oauth";
import { registerClient } from "@/lib/mcp/store";
import { safeErrorMessage } from "@/lib/safe-error";
import { getClientIp } from "@/lib/apps/public-access";

/**
 * RFC 7591 dynamic client registration.
 *
 * Registration is OPEN — no initial access token, no admin approval. That is
 * deliberate: it is what makes claude.ai's one-click "Add custom connector"
 * work, and it is safe because **registration grants nothing**. A registered
 * client can do exactly one thing: send a user to the consent screen. No data
 * moves until a logged-in MixOS user ticks specific apps there.
 *
 * What we still enforce:
 *  - redirect URIs must be https, http-on-loopback (RFC 8252), or a native
 *    custom scheme — and are stored as an exact-match allowlist;
 *  - no client_secret is ever issued (public clients + PKCE, per OAuth 2.1);
 *  - per-IP rate limiting, so the table can't be flooded.
 */
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_REDIRECT_URIS = 10;

// Registration is a once-per-client event; a real client needs one. Generous
// enough for a developer retrying in MCP Inspector, tight enough to matter.
const registerLimiter = createRateLimiter({
  scope: "ip",
  name: "oauth-register",
  maxTokens: 10,
  refillRatePerSecond: 0.05,
});

function invalidMetadata(description: string) {
  return NextResponse.json(
    { error: "invalid_client_metadata", error_description: description },
    { status: 400 },
  );
}

export async function POST(request: NextRequest) {
  const limit = await registerLimiter.consume(getClientIp(request));
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "temporarily_unavailable" },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) },
      },
    );
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return invalidMetadata("Registration request is too large.");
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return invalidMetadata("Body must be JSON.");
  }

  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return invalidMetadata("redirect_uris is required and must be a non-empty array.");
  }
  if (redirectUris.length > MAX_REDIRECT_URIS) {
    return invalidMetadata(`At most ${MAX_REDIRECT_URIS} redirect_uris are allowed.`);
  }
  for (const uri of redirectUris) {
    if (typeof uri !== "string" || !isAcceptableRedirectUri(uri)) {
      return invalidMetadata(
        `redirect_uri ${JSON.stringify(uri)} is not acceptable. Use https, http on localhost, or a native custom scheme, with no fragment.`,
      );
    }
  }

  // Some clients register with `token_endpoint_auth_method: "client_secret_post"`.
  // We only support public clients; say so rather than silently issuing
  // something the client won't be able to use.
  const authMethod = body.token_endpoint_auth_method;
  if (authMethod != null && authMethod !== "none") {
    return invalidMetadata(
      'Only public clients are supported: token_endpoint_auth_method must be "none" (PKCE is the client authentication).',
    );
  }

  const clientName =
    typeof body.client_name === "string" && body.client_name.trim()
      ? body.client_name.trim().slice(0, 120)
      : "Unnamed MCP client";

  try {
    const client = await registerClient({
      clientName,
      redirectUris: redirectUris as string[],
    });

    return NextResponse.json(
      {
        client_id: client.clientId,
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        // 0 = does not expire. Clients re-register if they lose their id.
        client_id_issued_at: Math.floor(Date.now() / 1000),
      },
      { status: 201 },
    );
  } catch (err) {
    console.error("[mcp/oauth] client registration failed:", err);
    return NextResponse.json(
      {
        error: "invalid_client_metadata",
        error_description: safeErrorMessage(err, "Could not register client."),
      },
      { status: 400 },
    );
  }
}
