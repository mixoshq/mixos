import { NextResponse, type NextRequest } from "next/server";
import { createRateLimiter } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/apps/public-access";
import { MCP_SCOPE, isValidResource, verifyPkce } from "@/lib/mcp/oauth";
import {
  consumeAuthorizationCode,
  issueTokens,
  rotateRefreshToken,
  sweepExpired,
} from "@/lib/mcp/store";

/**
 * OAuth 2.1 token endpoint — `authorization_code` (with PKCE) and
 * `refresh_token` (rotating).
 *
 * Deliberate choices:
 *  - Every failure mode of a code exchange (unknown / expired / already used /
 *    wrong client / wrong redirect_uri / bad verifier) returns the same
 *    `invalid_grant`. Distinguishing them would let an attacker probe which
 *    codes exist.
 *  - Refresh tokens rotate: the presented one is revoked in the same statement
 *    that reads it, so a replayed refresh token fails. `granted_apps` is copied
 *    forward verbatim, so a refresh can never widen consent.
 *  - No client authentication — clients are public and PKCE is the proof.
 */
export const dynamic = "force-dynamic";

const tokenLimiter = createRateLimiter({
  scope: "ip",
  name: "oauth-token",
  maxTokens: 30,
  refillRatePerSecond: 0.5,
});

function oauthError(
  error: "invalid_request" | "invalid_grant" | "unsupported_grant_type",
  description: string,
  status = 400,
) {
  return NextResponse.json(
    { error, error_description: description },
    { status, headers: { "Cache-Control": "no-store", Pragma: "no-cache" } },
  );
}

export async function POST(request: NextRequest) {
  const limit = await tokenLimiter.consume(getClientIp(request));
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "temporarily_unavailable" },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) },
      },
    );
  }

  // RFC 6749 mandates application/x-www-form-urlencoded here. Some clients send
  // JSON anyway; accept both rather than fail a flow over a content type.
  let form: URLSearchParams;
  const contentType = request.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const body = (await request.json()) as Record<string, unknown>;
      form = new URLSearchParams(
        Object.entries(body).map(([k, v]) => [k, String(v)]),
      );
    } else {
      form = new URLSearchParams(await request.text());
    }
  } catch {
    return oauthError("invalid_request", "Could not parse the request body.");
  }

  const grantType = form.get("grant_type");
  const resource = form.get("resource");
  if (!isValidResource(resource)) {
    return oauthError(
      "invalid_request",
      "The `resource` parameter does not identify this MCP server.",
    );
  }

  // Opportunistic cleanup — these tables are small and this is the one endpoint
  // every flow passes through, so MCP needs no scheduled job of its own.
  void sweepExpired();

  if (grantType === "authorization_code") {
    return handleAuthorizationCode(form);
  }
  if (grantType === "refresh_token") {
    return handleRefresh(form);
  }
  return oauthError(
    "unsupported_grant_type",
    'Supported grant types are "authorization_code" and "refresh_token".',
  );
}

async function handleAuthorizationCode(form: URLSearchParams) {
  const code = form.get("code");
  const clientId = form.get("client_id");
  const redirectUri = form.get("redirect_uri");
  const codeVerifier = form.get("code_verifier");

  if (!code || !clientId || !redirectUri || !codeVerifier) {
    return oauthError(
      "invalid_request",
      "code, client_id, redirect_uri, and code_verifier are all required.",
    );
  }

  // Atomically consume — a concurrent or replayed exchange finds nothing.
  const consumed = await consumeAuthorizationCode(code);
  if (!consumed) {
    return oauthError("invalid_grant", "Authorization code is invalid or expired.");
  }

  // Every mismatch below is `invalid_grant` with the same text, on purpose.
  if (consumed.clientId !== clientId) {
    return oauthError("invalid_grant", "Authorization code is invalid or expired.");
  }
  if (consumed.redirectUri !== redirectUri) {
    return oauthError("invalid_grant", "Authorization code is invalid or expired.");
  }
  if (!verifyPkce(codeVerifier, consumed.codeChallenge)) {
    return oauthError("invalid_grant", "Authorization code is invalid or expired.");
  }

  const tokens = await issueTokens({
    clientId: consumed.clientId,
    userId: consumed.userId,
    grantedApps: consumed.grantedApps,
  });

  return tokenResponse(tokens);
}

async function handleRefresh(form: URLSearchParams) {
  const refreshToken = form.get("refresh_token");
  const clientId = form.get("client_id");
  if (!refreshToken) {
    return oauthError("invalid_request", "refresh_token is required.");
  }

  const principal = await rotateRefreshToken(refreshToken);
  if (!principal) {
    return oauthError("invalid_grant", "Refresh token is invalid, expired, or already used.");
  }
  if (clientId && principal.clientId !== clientId) {
    return oauthError("invalid_grant", "Refresh token is invalid, expired, or already used.");
  }

  // grantedApps carried forward from the rotated token — never re-read from
  // anywhere else, so consent cannot silently widen across a refresh.
  const tokens = await issueTokens({
    clientId: principal.clientId,
    userId: principal.userId,
    grantedApps: principal.grantedApps,
  });

  return tokenResponse(tokens);
}

function tokenResponse(tokens: {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
}) {
  return NextResponse.json(
    {
      access_token: tokens.accessToken,
      token_type: "Bearer",
      expires_in: tokens.expiresInSec,
      refresh_token: tokens.refreshToken,
      scope: MCP_SCOPE,
    },
    { headers: { "Cache-Control": "no-store", Pragma: "no-cache" } },
  );
}
