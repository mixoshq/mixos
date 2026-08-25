import { NextResponse, type NextRequest } from "next/server";
import { createRateLimiter } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/apps/public-access";
import { revokeToken } from "@/lib/mcp/store";

/**
 * RFC 7009 token revocation.
 *
 * The spec requires 200 even for an unknown token, so this endpoint cannot be
 * used to probe whether a token is valid. Revoking either half of a pair ends
 * the whole session for that (user, client) — a client asking to revoke means
 * "disconnect", not "expire this one string".
 */
export const dynamic = "force-dynamic";

const revokeLimiter = createRateLimiter({
  scope: "ip",
  name: "oauth-revoke",
  maxTokens: 30,
  refillRatePerSecond: 0.5,
});

export async function POST(request: NextRequest) {
  const limit = await revokeLimiter.consume(getClientIp(request));
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "temporarily_unavailable" },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) },
      },
    );
  }

  let token: string | null = null;
  const contentType = request.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const body = (await request.json()) as { token?: unknown };
      token = typeof body.token === "string" ? body.token : null;
    } else {
      token = new URLSearchParams(await request.text()).get("token");
    }
  } catch {
    // Fall through: an unparseable body is treated as "nothing to revoke",
    // which per RFC 7009 is still a 200.
  }

  if (token) {
    try {
      await revokeToken(token);
    } catch (err) {
      // Log, but still return 200 — the spec gives no useful error for this,
      // and surfacing one would leak whether the token existed.
      console.error("[mcp/oauth] revoke failed:", err);
    }
  }

  return new NextResponse(null, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}
