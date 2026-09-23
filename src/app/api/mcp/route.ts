/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { NextResponse, type NextRequest } from "next/server";
import { createRateLimiter } from "@/lib/rate-limit";
import { McpToolError, callTool } from "@/lib/mcp/broker";
import { wwwAuthenticateHeader } from "@/lib/mcp/oauth";
import { resolveAccessToken, type TokenPrincipal } from "@/lib/mcp/store";
import { describeTool, reachableApps } from "@/lib/mcp/tools";
import {
  RPC_INTERNAL_ERROR,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  isJsonRpcRequest,
  isNotification,
  rpcError,
  rpcResult,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "@/lib/mcp/jsonrpc";

/**
 * The MixOS MCP server — one endpoint, JSON-RPC 2.0 over HTTP POST.
 *
 * Transport: MCP Streamable HTTP, JSON-response mode. MixOS sends no
 * server-initiated messages, so a single `application/json` body per request is
 * spec-compliant and there is no SSE anywhere. `GET` (which would open a
 * server→client stream) and `DELETE` (session teardown; we are stateless) are
 * therefore 405.
 *
 * Authorization: an opaque bearer token issued by the MixOS OAuth 2.1
 * authorization server (src/app/api/oauth/**). A 401 from here MUST carry
 * `WWW-Authenticate` with `resource_metadata` — that header is the entire
 * bootstrap for a client that has never seen this server, and omitting it fails
 * silently and confusingly on the client side.
 *
 * `/api/mcp` must be in PUBLIC_ROUTE_PREFIXES (src/proxy.ts): "no session
 * cookie" is the expected state here, and the proxy would otherwise redirect
 * every token-authenticated request to /login.
 */
export const dynamic = "force-dynamic";

/** Protocol revision MixOS implements. Echoed back when the client agrees. */
const SUPPORTED_PROTOCOL_VERSION = "2025-06-18";
/** Older revisions we can still speak — the surface we use is unchanged. */
const ACCEPTED_PROTOCOL_VERSIONS = new Set([
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);

const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Per-TOKEN, not per-IP: claude.ai calls arrive from shared egress addresses, so
 * an IP bucket would let one tenant's traffic starve another's. Generous burst
 * because a model happily fires several tools/call in parallel.
 */
const mcpLimiter = createRateLimiter({
  scope: "api_key",
  name: "mcp",
  maxTokens: 120,
  refillRatePerSecond: 2,
});

function unauthorized(message: string) {
  return NextResponse.json(
    { error: "unauthorized", error_description: message },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": wwwAuthenticateHeader(),
        "Cache-Control": "no-store",
      },
    },
  );
}

function bearerFrom(request: NextRequest): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

export async function POST(request: NextRequest) {
  const token = bearerFrom(request);
  if (!token) {
    return unauthorized("A bearer access token is required.");
  }

  const principal = await resolveAccessToken(token);
  if (!principal) {
    // Same response for unknown, expired, and revoked — a caller must not be
    // able to tell those apart.
    return unauthorized("The access token is invalid, expired, or revoked.");
  }

  const limit = await mcpLimiter.consume(
    principal.clientId + "::" + principal.userId,
  );
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) },
      },
    );
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json(
      rpcError(null, RPC_INVALID_REQUEST, "Request body is too large."),
      { status: 413 },
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json(
      rpcError(null, RPC_INVALID_REQUEST, "Body is not valid JSON."),
      { status: 400 },
    );
  }

  // JSON-RPC batches are permitted by the transport. Handle them, but keep the
  // single-request path (what every client actually sends) the simple one.
  if (Array.isArray(payload)) {
    const responses: JsonRpcResponse[] = [];
    for (const entry of payload) {
      const res = await dispatchOne(entry, principal);
      if (res) responses.push(res);
    }
    if (responses.length === 0) return new NextResponse(null, { status: 202 });
    return NextResponse.json(responses, { headers: { "Cache-Control": "no-store" } });
  }

  const response = await dispatchOne(payload, principal);
  // A notification (no id) gets no body — 202 Accepted, per the transport spec.
  if (!response) return new NextResponse(null, { status: 202 });
  return NextResponse.json(response, { headers: { "Cache-Control": "no-store" } });
}

/** Streamable HTTP's server→client stream. MixOS never initiates; say so. */
export async function GET() {
  return NextResponse.json(
    { error: "method_not_allowed", error_description: "This server does not open SSE streams; POST JSON-RPC instead." },
    { status: 405, headers: { Allow: "POST" } },
  );
}

/** Session teardown. MixOS is stateless — there is no session to delete. */
export async function DELETE() {
  return new NextResponse(null, { status: 405, headers: { Allow: "POST" } });
}

async function dispatchOne(
  value: unknown,
  principal: TokenPrincipal,
): Promise<JsonRpcResponse | null> {
  if (!isJsonRpcRequest(value)) {
    return rpcError(null, RPC_INVALID_REQUEST, "Not a valid JSON-RPC 2.0 request.");
  }
  const req = value;
  const id = req.id ?? null;
  const notification = isNotification(req);

  try {
    switch (req.method) {
      case "initialize":
        return notification ? null : rpcResult(id, handleInitialize(req));

      case "notifications/initialized":
      case "notifications/cancelled":
        // Acknowledged by doing nothing — there is no per-session state.
        return null;

      case "ping":
        return notification ? null : rpcResult(id, {});

      case "tools/list":
        return notification ? null : rpcResult(id, await handleToolsList(principal));

      case "tools/call": {
        if (notification) return null;
        return rpcResult(id, await handleToolsCall(req, principal));
      }

      default:
        return notification
          ? null
          : rpcError(id, RPC_METHOD_NOT_FOUND, `Unknown method "${req.method}".`);
    }
  } catch (err) {
    console.error(`[mcp] ${req.method} failed:`, err);
    return notification
      ? null
      : rpcError(id, RPC_INTERNAL_ERROR, "The server failed to handle that request.");
  }
}

function handleInitialize(req: JsonRpcRequest) {
  const params = (req.params ?? {}) as { protocolVersion?: unknown };
  const requested =
    typeof params.protocolVersion === "string" ? params.protocolVersion : null;
  // Echo the client's version when we can speak it; otherwise answer with ours
  // and let the client decide whether to continue (per the spec's negotiation).
  const protocolVersion =
    requested && ACCEPTED_PROTOCOL_VERSIONS.has(requested)
      ? requested
      : SUPPORTED_PROTOCOL_VERSION;

  return {
    protocolVersion,
    // `listChanged: false` — the tool set is fixed for the life of a token's
    // consent, and we have no channel to push a change notification anyway.
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "mixos", title: "MixOS", version: "1.0.0" },
    // The last two sentences are deliberate. A client pools these tools with
    // every other server the user has connected, and ours are joins built for
    // one job each — so they read as more capable than they are on questions a
    // source system would answer better. Saying where they stop, once, is
    // cheaper than repeating a hedge in fifteen tool descriptions.
    instructions:
      "Read-only access to MixOS apps. Each tool is named <app>__<tool> and " +
      "returns data scoped to the connected user's own permissions. Tools cannot " +
      "change anything. Every tool names what it is built from: these are Mix" +
      "OS's joined, cached views over systems like monday.com, Gong and Amplitude, " +
      "each shaped for one job. For raw records, arbitrary fields, or anything " +
      "outside the joins a tool names, a source system's own connector is the " +
      "better fit. These tools claim no priority over other servers' tools.",
  };
}

async function handleToolsList(principal: TokenPrincipal) {
  const apps = await reachableApps(principal.userId, principal.grantedApps);
  const described = await Promise.all(
    apps.flatMap((app) => app.mcp.map((tool) => describeTool(app, tool))),
  );
  return { tools: described.filter((t) => t !== null) };
}

async function handleToolsCall(req: JsonRpcRequest, principal: TokenPrincipal) {
  const params = (req.params ?? {}) as { name?: unknown; arguments?: unknown };
  const name = typeof params.name === "string" ? params.name : "";
  if (!name) {
    return toolErrorResult("A tool name is required.");
  }

  try {
    const result = await callTool(principal, name, params.arguments);
    return {
      // `structuredContent` is what a model actually reads; the text block is
      // the required fallback for clients that don't support it yet.
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
      isError: false,
    };
  } catch (err) {
    if (err instanceof McpToolError) {
      // Tool failures come back as tool RESULTS, not JSON-RPC errors. That is
      // what lets a model see what went wrong and correct itself — a protocol
      // error is invisible to it and just aborts the turn.
      const detail = err.details
        ? `${err.message}\n${JSON.stringify(err.details, null, 2)}`
        : err.message;
      return toolErrorResult(`[${err.code}] ${detail}`);
    }
    console.error("[mcp] tools/call failed:", err);
    return toolErrorResult("The tool failed unexpectedly.");
  }
}

function toolErrorResult(message: string) {
  return { content: [{ type: "text", text: message }], isError: true };
}
