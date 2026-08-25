import { NextResponse } from "next/server";
import { authorizationServerMetadata } from "@/lib/mcp/oauth";
import { WELL_KNOWN_CORS } from "../../cors";

/**
 * RFC 8414 authorization-server metadata. Tells a client where to register,
 * authorize, exchange, and revoke — and, critically, that PKCE S256 is required
 * and no client secret is issued.
 *
 * Served at `/.well-known/oauth-authorization-server` via a rewrite in
 * next.config.ts. The optional catch-all also answers the path-suffixed form
 * some clients probe. Public and unauthenticated by design.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(authorizationServerMetadata(), {
    headers: { ...WELL_KNOWN_CORS, "Cache-Control": "public, max-age=3600" },
  });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: WELL_KNOWN_CORS });
}
