import { NextResponse } from "next/server";
import { protectedResourceMetadata } from "@/lib/mcp/oauth";
import { WELL_KNOWN_CORS } from "../../cors";

/**
 * RFC 9728 protected-resource metadata for the MixOS MCP server.
 *
 * This is the first document an MCP client fetches after a 401: the
 * `WWW-Authenticate` header on `/api/mcp` points here, and this points on to
 * the authorization server. Public and unauthenticated by design — it names
 * endpoints and nothing else.
 *
 * Served at `/.well-known/oauth-protected-resource` via a rewrite in
 * next.config.ts (a dot-prefixed App Router directory isn't a documented
 * convention, so we don't rely on one). The optional catch-all also answers the
 * path-suffixed form clients probe, `/.well-known/oauth-protected-resource/api/mcp`,
 * which is the RFC 9728 layout for a resource that isn't at the origin root.
 *
 * `/.well-known` must be in PUBLIC_ROUTE_PREFIXES (src/proxy.ts) or the proxy
 * redirects the discovery request to /login and the flow never starts.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(protectedResourceMetadata(), {
    headers: { ...WELL_KNOWN_CORS, "Cache-Control": "public, max-age=3600" },
  });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: WELL_KNOWN_CORS });
}
